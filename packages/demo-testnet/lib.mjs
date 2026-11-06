// Pure helpers, no chain access, so `npm test` runs offline.
import { encodeAbiParameters, getCreate2Address, keccak256, toHex } from 'viem'

export const DRAND_GENESIS = 1692803367n
const BEFORE_SWAP_FLAG = 0x80n
const ALL_HOOK_FLAGS = 0x3fffn

const KEY_TYPES = ['address', 'address', 'uint24', 'int24', 'address'].map((type) => ({ type }))
/** v4 PoolId: keccak256(abi.encode(poolKey)). */
export const poolIdOf = (k) => keccak256(encodeAbiParameters(KEY_TYPES, [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]))

/** First CREATE2 salt whose address carries exactly the BEFORE_SWAP hook flag (AGENTS.md gotcha 3). */
export function mineHookSalt(from, bytecodeHash) {
  for (let i = 0n; ; i++) {
    const salt = toHex(i, { size: 32 })
    const address = getCreate2Address({ from, salt, bytecodeHash })
    if ((BigInt(address) & ALL_HOOK_FLAGS) === BEFORE_SWAP_FLAG) return { salt, address }
  }
}

/** start and length on drand's 3 s grid, so each batch's reveal round lands 6 s after commits close (AGENTS.md gotcha 9). */
export function drandSchedule(now, batchSeconds) {
  const len = BigInt(batchSeconds)
  return { start: now - ((now - DRAND_GENESIS) % 3n), batchLength: len - (len % 3n), revealLength: 30n, settleLength: 60n }
}

/** The client's `track` lines: "#id batch b: state (what)" plus " → got X" for a fill. */
export const parseTrack = (out) => [...out.matchAll(/^#(\d+) batch (\d+): (\w+) \((.*?)\)(.*)$/gm)]
  .map(([, id, batch, state, what, rest]) => ({ id: Number(id), batch: Number(batch), state, what, fill: rest.trim() }))
