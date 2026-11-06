// Encrypted backups of private state (FIXES.md fix 6). Orders, salts and funding openings live only on this device;
// without them a user cannot reveal their own order or append to their funding root. The client writes an encrypted
// copy after every change, so a lost or wiped device can be restored from wherever the user keeps the backup.
//
// Key: by default derived from a wallet signature over a fixed, clearly labelled message. Local accounts sign
// deterministically (RFC 6979), so the same wallet on a new device derives the same key and needs nothing else.
// CLIENT_BACKUP_PASSPHRASE selects a passphrase (scrypt) instead. AES-256-GCM authenticates the ciphertext and binds the
// header (chain, settlement, owner, salt) as associated data, so a swapped or edited header fails to decrypt.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const BACKUP_KIND = 'blindfold-backup'
export const BACKUP_VERSION = 1

export const backupDir = (env = process.env) => env.CLIENT_BACKUP_DIR || join(homedir(), '.blindfold', 'backups')
export const backupPath = (dir, dep, owner) => join(dir, `${dep.chainId}-${dep.settlement}-${owner}.backup.json`.toLowerCase())

/** The message whose signature derives the key. Signing it anywhere else would disclose the backup key. */
export const keyMessage = (dep) =>
  `Blindfold backup key v1\nOnly sign this in the Blindfold client: it unlocks your order backups.\nchain ${dep.chainId}\nsettlement ${dep.settlement.toLowerCase()}`

async function deriveKey({ dep, account, passphrase, kdf, salt }) {
  if (kdf === 'scrypt') {
    if (!passphrase) throw new Error('this backup is passphrase-encrypted; set CLIENT_BACKUP_PASSPHRASE')
    return scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  }
  if (kdf !== 'wallet-signature') throw new Error(`unknown backup key derivation ${kdf}`)
  const signature = await account.signMessage({ message: keyMessage(dep) })
  return createHash('sha256').update(Buffer.from(signature.slice(2), 'hex')).update(salt).digest()
}

const header = ({ dep, owner, kdf, salt }) => ({
  kind: BACKUP_KIND, version: BACKUP_VERSION, chainId: dep.chainId, settlement: dep.settlement.toLowerCase(),
  owner: owner.toLowerCase(), kdf, salt: salt.toString('hex'),
})

/** Encrypt exported state text into a backup object. */
export async function sealBackup({ dep, owner, account, text, passphrase }) {
  const salt = randomBytes(16)
  const kdf = passphrase ? 'scrypt' : 'wallet-signature'
  const key = await deriveKey({ dep, account, passphrase, kdf, salt })
  const h = header({ dep, owner, kdf, salt })
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(JSON.stringify(h)))
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return { ...h, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('base64') }
}

/** Decrypt a backup object for this deployment and owner; throws on any mismatch or tampering. */
export async function openBackup(backup, { dep, owner, account, passphrase }) {
  if (backup?.kind !== BACKUP_KIND || backup.version !== BACKUP_VERSION) throw new Error('not a Blindfold backup')
  if (backup.chainId !== dep.chainId || backup.settlement !== dep.settlement.toLowerCase()) throw new Error('backup is for another chain or settlement')
  if (backup.owner !== owner.toLowerCase()) throw new Error(`backup belongs to ${backup.owner}`)
  const salt = Buffer.from(backup.salt, 'hex')
  const key = await deriveKey({ dep, account, passphrase, kdf: backup.kdf, salt })
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(backup.iv, 'hex'))
  decipher.setAAD(Buffer.from(JSON.stringify(header({ dep, owner, kdf: backup.kdf, salt }))))
  decipher.setAuthTag(Buffer.from(backup.tag, 'hex'))
  try {
    return Buffer.concat([decipher.update(Buffer.from(backup.ciphertext, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('backup does not decrypt: wrong wallet or passphrase, or the file was changed')
  }
}

/** Write the backup atomically, owner-only. Returns its path. */
export async function writeBackup({ dep, owner, account, text, passphrase, dir = backupDir() }) {
  const backup = await sealBackup({ dep, owner, account, text, passphrase })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = backupPath(dir, dep, owner)
  const fd = openSync(`${path}.tmp`, 'w', 0o600)
  try { fchmodSync(fd, 0o600); writeFileSync(fd, JSON.stringify(backup, null, 2)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(`${path}.tmp`, path)
  return path
}

export const readBackupFile = (path) => JSON.parse(readFileSync(path, 'utf8'))
