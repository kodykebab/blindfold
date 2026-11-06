// The Court watcher service core (S16, #22). Each tick:
//   1. checks the hashes of recently scanned blocks and, on a reorg, drops what it found there and rescans;
//   2. discovers sandwiches in confirmed blocks only, a bounded range per tick, with bounded concurrency;
//   3. proves a bounded number of discoveries (the expensive stage, kept separate from discovery);
//   4. submits proven claims, when a submitter is configured, and records each outcome;
//   5. collects submitted claims once their incident's claim window has closed (by `now`, the registry chain's
//      time), when a collector is configured.
// State (next block, recent block hashes, every discovery and its status) is saved after each stage, only once
// that stage has fully succeeded, so an RPC failure or crash never skips a block. A restart rescans the last
// `overlap` blocks; discoveries are keyed by block hash and leg tx hashes, so rescans never duplicate them.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { numberToHex } from 'viem'
import { findSandwiches, swapLogs } from './lib.mjs'

/** fn over items with at most `limit` in flight; results in input order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

export function memoryStore(initial = null) {
  let saved = initial
  return { load: async () => (saved ? structuredClone(saved) : null), save: async (s) => { saved = structuredClone(s) } }
}

/** JSON state file, written to a temp file and renamed so a crash mid-write never corrupts it. */
export function fileStore(path) {
  return {
    load: async () => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null),
    save: async (s) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(`${path}.tmp`, JSON.stringify(s, null, 1))
      renameSync(`${path}.tmp`, path)
    },
  }
}

export const keyOf = (blockHash, s) => `${blockHash}:${s.front.txHash}:${s.victim.txHash}:${s.back.txHash}`

/**
 * @param call    (method, params) => result, against the chain being judged
 * @param prove   async (item) => claim info (e.g. { path }); throws to retry later
 * @param submit  optional async (item) => submission info (e.g. { tx, closesAt }); throws to retry later
 * @param collect optional async (item) => collection info (e.g. { tx, payout }), run once `await now() >= closesAt`
 * @param now     async () => unix seconds on the chain that holds the claims (its latest block's timestamp)
 * @param wanted  optional (item) => bool at discovery; unwanted sandwiches (no receipt) are kept as 'ignored', unproven
 */
export function createWatcher({
  call, store, start, confirmations = 3, overlap = 12, maxBlocks = 50, concurrency = 4, proveLimit = 2,
  maxAttempts = 3, prove, submit, collect, wanted, now = async () => Date.now() / 1000, log = () => {},
}) {
  let state
  const hex = (n) => numberToHex(BigInt(n))

  async function load() {
    const saved = await store.load()
    if (!saved) {
      const head = Number(await call('eth_blockNumber', []))
      state = { version: 1, next: start ?? Math.max(0, head - confirmations), hashes: {}, items: {} }
    } else {
      state = saved
      state.next = Math.max(start ?? 0, state.next - overlap) // restart: rescan a bounded overlap
    }
  }

  /** Re-checks recent block hashes; on a mismatch, marks what was found there and rewinds to rescan. */
  async function checkReorg() {
    const heights = Object.keys(state.hashes).map(Number).sort((a, b) => a - b)
    let from = null
    for (const n of heights) {
      const b = await call('eth_getBlockByNumber', [hex(n), false])
      if (b?.hash !== state.hashes[n]) {
        from = n
        break
      }
    }
    if (from === null) return 0
    let dropped = 0
    for (const item of Object.values(state.items)) {
      if (item.block >= from && item.status !== 'reorged' && item.blockHash === state.hashes[item.block]) {
        item.status = 'reorged'
        dropped++
      }
    }
    for (const n of heights) if (n >= from) delete state.hashes[n]
    state.next = Math.min(state.next, from)
    log(`reorg at block ${from}: ${dropped} discoveries dropped, rescanning`)
    return dropped
  }

  async function scanBlock(n) {
    const block = await call('eth_getBlockByNumber', [hex(n), false])
    const receipts = await call('eth_getBlockReceipts', [hex(n)])
    // receipts are fetched by number: make sure they belong to the block we hashed
    if (receipts.some((r) => r.blockHash !== block.hash)) throw new Error(`block ${n} changed while it was read`)
    return { n, hash: block.hash, found: findSandwiches(swapLogs(receipts)) }
  }

  async function discover() {
    const head = Number(await call('eth_blockNumber', []))
    const safe = head - confirmations
    const from = state.next
    const to = Math.min(safe, from + maxBlocks - 1)
    if (to < from) return { from, to, found: 0 }
    const blocks = await mapLimit(Array.from({ length: to - from + 1 }, (_, i) => from + i), concurrency, scanBlock)
    let found = 0
    for (const { n, hash, found: list } of blocks) {
      state.hashes[n] = hash
      for (const s of list) {
        const key = keyOf(hash, s)
        if (state.items[key]) continue // already found: a restart or overlap rescan
        state.items[key] = {
          key, block: n, blockHash: hash, v4: s.front.v4, pool: s.front.pool, poolId: s.front.poolId,
          front: [s.front.txIndex, s.front.logIndex], victim: [s.victim.txIndex, s.victim.logIndex],
          back: [s.back.txIndex, s.back.logIndex], victimTx: s.victim.txHash, attacker: s.front.from,
          profit: s.profit.toString(), profitInToken0: s.profitInToken0, status: 'discovered', attempts: 0,
        }
        if (wanted && !wanted(state.items[key])) state.items[key].status = 'ignored'
        found++
      }
    }
    state.next = to + 1
    for (const n of Object.keys(state.hashes).map(Number)) if (n < state.next - overlap) delete state.hashes[n]
    return { from, to, found }
  }

  /**
   * Runs `stage` on up to `limit` items in `status` that are `due`; success moves them to `done`, failures retry up
   * to maxAttempts.
   */
  async function advance(status, done, limit, stage, field, due = () => true) {
    const ready = Object.values(state.items)
      .filter((i) => i.status === status && due(i))
      .sort((a, b) => a.block - b.block)
    const batch = ready.slice(0, limit)
    await mapLimit(batch, concurrency, async (item) => {
      try {
        item[field] = await stage(item)
        item.status = done
        item.attempts = 0
        delete item.error
      } catch (e) {
        item.attempts++
        item.error = e.shortMessage ?? e.message
        if (item.attempts >= maxAttempts) item.status = 'failed'
        log(`${field} failed for ${item.key} (attempt ${item.attempts}): ${item.error}`)
      }
    })
    return batch.filter((i) => i.status === done).length
  }

  return {
    get state() {
      return state
    },
    async tick() {
      if (!state) await load()
      const reorged = await checkReorg()
      const scan = await discover()
      await store.save(state)
      const proven = prove ? await advance('discovered', 'proven', proveLimit, prove, 'claim') : 0
      const submitted = submit ? await advance('proven', 'submitted', proveLimit, submit, 'submission') : 0
      const t = collect ? await now() : 0
      const due = (i) => t >= i.submission.closesAt
      const collected = collect ? await advance('submitted', 'collected', proveLimit, collect, 'collection', due) : 0
      await store.save(state)
      return { ...scan, reorged, proven, submitted, collected }
    },
  }
}
