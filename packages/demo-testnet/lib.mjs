// Pure helpers, no chain access, so `npm test` runs offline.
import { decodeEventLog, encodeAbiParameters, getCreate2Address, keccak256, toHex } from 'viem'

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

/** Find the v3 factory in Uniswap's chain deployment document. */
export function v3FactoryFromManifest(document) {
  const address = document.match(/### Uniswap V3 Factory\s+Address: \[?(0x[0-9a-fA-F]{40})/)?.[1]
  if (!address) throw new Error('cannot find v3 factory in Uniswap deployment manifest; set V3_FACTORY')
  return address
}

/** A detectable sandwich has all three legs ordered in the same block. */
export function orderedSandwich(front, victim, back) {
  return front.blockNumber === victim.blockNumber && victim.blockNumber === back.blockNumber
    && front.transactionIndex < victim.transactionIndex && victim.transactionIndex < back.transactionIndex
}

/** Find this victim's sandwich on the expected pool, not a different trade in the same block. */
export function victimSandwich(sandwiches, hash, pool) {
  return sandwiches.find((s) => s.victim.txHash.toLowerCase() === hash.toLowerCase() && s.victim.pool.toLowerCase() === pool.toLowerCase())
}

/** Read the created pool from the mined factory event, even if latest-state reads lag the receipt. */
export function createdV3Pool(receipt, factory, abi) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== factory.toLowerCase()) continue
    try {
      const event = decodeEventLog({ abi, data: log.data, topics: log.topics })
      if (event.eventName === 'PoolCreated') return event.args.pool
    } catch {}
  }
  throw new Error('the factory receipt has no PoolCreated event')
}

/** Wait for a confirmed transaction to become visible to latest-state RPC calls. */
export async function waitForState(read, { attempts = 30, intervalMs = 1000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try { if (await read()) return } catch {}
    if (i + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error('confirmed transaction did not become visible to the RPC')
}

/** Some RPCs return preconfirmed receipts before latest-state reads can see the transaction. */
export function receiptVisible(receipt, latestBlock) {
  return receipt == null || (receipt.blockNumber != null && BigInt(latestBlock) >= BigInt(receipt.blockNumber))
}

/** Split historical log queries for RPCs with a 1,000-block limit. */
export function splitLogFilter(filter, head, size = 500n) {
  if (filter.blockHash) return [filter]
  const block = (value) => value == null || value === 'latest' ? head : value === 'earliest' ? 0n : /^0x[0-9a-f]+$/i.test(value) ? BigInt(value) : null
  const from = block(filter.fromBlock), to = block(filter.toBlock)
  if (from === null || to === null || from > to) return [filter]
  const ranges = []
  for (let start = from; start <= to; start += size) {
    const end = start + size - 1n < to ? start + size - 1n : to
    ranges.push({ ...filter, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` })
  }
  return ranges
}
