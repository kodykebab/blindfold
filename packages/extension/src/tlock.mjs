// tlock work for the offscreen document: encrypt orders (deployments without admission) and check ciphertexts.
import { Buffer, mainnetClient, timelockDecrypt, timelockEncrypt } from 'tlock-js'
import { bytesToHex, hexToBytes, sha256 } from 'viem'
import { armor, dearmor, DRAND } from './core.mjs'

/** quicknet over HTTP, or recorded rounds ({public_key, chain_hash, rounds}) as in client lib.mjs drandClient. */
export function drandClient(fixture) {
  if (!fixture) return mainnetClient()
  const info = {
    public_key: fixture.public_key, period: 3, genesis_time: Number(DRAND.genesis), hash: fixture.chain_hash, groupHash: '',
    schemeID: 'bls-unchained-g1-rfc9380', metadata: { beaconID: 'quicknet' },
  }
  return {
    options: { disableBeaconVerification: false, noCache: true },
    chain: () => ({ baseUrl: 'fixture', info: async () => info }),
    latest: async () => { throw new Error('recorded drand client has no latest round') },
    get: async (round) => {
      const signature = fixture.rounds[String(round)]
      if (!signature) throw new Error(`round ${round} is not recorded`)
      return { round, signature, randomness: sha256(`0x${signature}`).slice(2) }
    },
  }
}

/** Raw AGE bytes (hex) of the payload encrypted to a quicknet round. */
export const encrypt = async (round, payload, fixture) =>
  dearmor(await timelockEncrypt(Number(round), Buffer.from(hexToBytes(payload)), drandClient(fixture)))

/**
 * Check a ciphertext before it is committed: one tlock stanza for quicknet and the batch's round, and, once the
 * round's signature is available (recorded rounds, or a round already out), that it decrypts to the expected payload.
 * Returns {round, decrypted}; throws on any mismatch.
 */
export async function check(ciphertext, round, payload, fixture, now = Date.now() / 1000) {
  const header = new TextDecoder().decode(hexToBytes(ciphertext)).split('\n---')[0]
  const stanzas = [...header.matchAll(/^-> (\S+)(.*)$/gm)]
  if (!header.startsWith('age-encryption.org/v1\n') || stanzas.length !== 1) throw new Error('ciphertext is not a single-recipient AGE file')
  const [, type, args] = stanzas[0]
  if (`${type}${args}` !== `tlock ${round} ${DRAND.chainHash}`) throw new Error(`ciphertext is sealed to "${type}${args}", expected quicknet round ${round}`)
  const out = fixture ? fixture.rounds[String(round)] : now >= Number(DRAND.genesis) + (Number(round) - 1) * 3
  if (!out) return { round: String(round), decrypted: false }
  const plain = bytesToHex(await timelockDecrypt(armor(ciphertext), drandClient(fixture)))
  if (plain !== payload.toLowerCase()) throw new Error('ciphertext does not decrypt to this order')
  return { round: String(round), decrypted: true }
}
