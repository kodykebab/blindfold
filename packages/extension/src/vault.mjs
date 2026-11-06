// Private state at rest (D6): a passphrase through PBKDF2-SHA256 to an AES-256-GCM key, WebCrypto only.
// Each record is sealed with a fresh IV and its storage key as associated data, so a record moved to another
// account's slot, or any flipped byte, fails to open.
import { bytesToHex, hexToBytes } from 'viem'
import { emptyState, replacer, reviver, stateId } from './core.mjs'

export const ITERATIONS = 600_000 // OWASP 2023 minimum for PBKDF2-HMAC-SHA256
const enc = new TextEncoder()
const CHECK = 'blindfold-passphrase-check'

export async function deriveKey(passphrase, salt, iterations = ITERATIONS) {
  if (!passphrase) throw new Error('empty passphrase')
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  // extractable: the raw key is parked in chrome.storage.session so the service worker survives restarts unlocked
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(salt), iterations }, base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}
export const exportKey = async (key) => bytesToHex(new Uint8Array(await crypto.subtle.exportKey('raw', key)))
export const importKey = (hex) => crypto.subtle.importKey('raw', hexToBytes(hex), 'AES-GCM', true, ['encrypt', 'decrypt'])

export async function seal(key, text, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(text))
  return { iv: bytesToHex(iv), ct: bytesToHex(new Uint8Array(ct)) }
}
export async function open(key, box, aad) {
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(box.iv), additionalData: enc.encode(aad) }, key, hexToBytes(box.ct)))
  } catch { throw new Error('cannot decrypt private state: wrong passphrase or corrupted data') }
}

/** First run: a random PBKDF2 salt and a sealed check value, so unlock can tell a wrong passphrase. */
export async function createVault(area, passphrase, iterations = ITERATIONS) {
  if ((await area.get('kdf')).kdf) throw new Error('a passphrase is already set; unlock instead')
  const kdf = { salt: bytesToHex(crypto.getRandomValues(new Uint8Array(16))), iterations }
  const key = await deriveKey(passphrase, kdf.salt, iterations)
  await area.set({ kdf, check: await seal(key, CHECK, 'check') })
  return key
}

export async function unlockVault(area, passphrase) {
  const { kdf, check } = await area.get(['kdf', 'check'])
  if (!kdf) throw new Error('no passphrase set yet; create one first')
  const key = await deriveKey(passphrase, kdf.salt, kdf.iterations)
  try { if (await open(key, check, 'check') !== CHECK) throw new Error() } catch { throw new Error('wrong passphrase') }
  return key
}

/** Per-account encrypted state on a chrome.storage-like area ({get, set}); same JSON as the CLI's state file. */
export function stateStore(area, key) {
  const slot = (dep, owner) => `state:${stateId(dep, owner)}`
  return {
    async load(dep, owner) {
      const id = slot(dep, owner)
      const box = (await area.get(id))[id]
      return box ? JSON.parse(await open(key, box, id), reviver) : emptyState(dep, owner)
    },
    async write(dep, owner, state) {
      const id = slot(dep, owner)
      await area.set({ [id]: await seal(key, JSON.stringify(state, replacer), id) })
    },
  }
}
