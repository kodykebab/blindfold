import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWatcher, fileStore, mapLimit, memoryStore } from '../watcher.mjs'
import { l1Anchor, V3_SWAP } from '../lib.mjs'

const word = (x) => (x < 0n ? (1n << 256n) + x : x).toString(16).padStart(64, '0')
const topic = (a) => '0x' + '00'.repeat(12) + a.slice(2)
const BOT = '0x' + 'b0'.repeat(20), USER = '0x' + 'a1'.repeat(20), ROUTER = '0x' + 'c0'.repeat(20)
const POOL = '0x' + '77'.repeat(20)

/** A v3 Swap in its own tx (pool-side amounts, as SandwichCourtVerifier's predicate test). */
const swapReceipt = (blockHash, i, from, trader, a0, a1) => ({
  status: '0x1', transactionIndex: '0x' + i.toString(16), transactionHash: `${blockHash}-tx${i}`, from, blockHash,
  logs: [{ address: POOL, topics: [V3_SWAP, topic(trader), topic(trader)], data: '0x' + word(a0) + word(a1) + word(0n).repeat(3) }],
})

/** An in-memory chain behind the JSON-RPC methods the watcher uses, with failure injection and a call log. */
function fakeChain() {
  const blocks = new Map()
  const calls = []
  const fail = new Set()
  let head = -1
  let salt = 0
  let mismatch = null
  const make = (sandwich) => {
    const hash = '0x' + (++salt).toString(16).padStart(64, '0')
    const receipts = sandwich
      ? [
          swapReceipt(hash, 0, BOT, BOT, 50n, -100n),
          swapReceipt(hash, 1, USER, ROUTER, 10n, -18n),
          swapReceipt(hash, 2, BOT, BOT, -52n, 100n),
        ]
      : []
    return { hash, receipts }
  }
  return {
    calls, fail,
    mine(sandwich = false) {
      blocks.set(++head, make(sandwich))
      return head
    },
    reorg(n, sandwich = false) {
      blocks.set(n, make(sandwich))
    },
    receiptsFromAnotherBlock(n) {
      mismatch = n
    },
    async call(method, params) {
      const n = params[0] === undefined ? undefined : Number(params[0])
      calls.push(`${method}:${n}`)
      for (const k of [method, `${method}:${n}`]) {
        if (fail.has(k)) {
          fail.delete(k)
          throw new Error(`fake RPC down: ${k}`)
        }
      }
      if (method === 'eth_blockNumber') return '0x' + head.toString(16)
      const b = blocks.get(n)
      if (method === 'eth_getBlockByNumber') return b ? { number: params[0], hash: b.hash } : null
      if (method === 'eth_getBlockReceipts') {
        if (n === mismatch) return [{ ...swapReceipt('0xother', 0, BOT, BOT, 1n, -1n) }]
        return b.receipts
      }
      throw new Error(`unexpected ${method}`)
    },
  }
}

const items = (w) => Object.values(w.state.items)

test('finds a sandwich only once it has the configured confirmations, a bounded range per tick', async () => {
  const c = fakeChain()
  c.mine()
  c.mine(true) // block 1
  c.mine()
  const w = createWatcher({ call: c.call, store: memoryStore(), start: 0, confirmations: 2, maxBlocks: 1 })
  assert.deepEqual(await w.tick(), { from: 0, to: 0, found: 0, reorged: 0, proven: 0, submitted: 0 })
  assert.equal((await w.tick()).found, 0, 'block 1 has only one confirmation: not scanned yet')
  assert.equal(w.state.next, 1)
  c.mine()
  c.mine()
  const t = await w.tick()
  assert.deepEqual([t.from, t.to, t.found], [1, 1, 1], 'one block per tick (maxBlocks)')
  const [item] = items(w)
  assert.equal(item.status, 'discovered')
  assert.equal(item.block, 1)
  assert.deepEqual([item.front, item.victim, item.back], [[0, 0], [1, 0], [2, 0]])
  assert.equal(item.victimTx, `${item.blockHash}-tx1`)
  assert.equal(item.profit, '2')
})

test('a restart rescans a bounded overlap without duplicating what it found', async () => {
  const c = fakeChain()
  for (let i = 0; i < 6; i++) c.mine(i === 2)
  const path = join(mkdtempSync(join(tmpdir(), 'watcher-')), 'state.json')
  const first = createWatcher({ call: c.call, store: fileStore(path), start: 0, confirmations: 0, overlap: 4 })
  await first.tick()
  assert.equal(items(first).length, 1)
  const next = first.state.next

  const second = createWatcher({ call: c.call, store: fileStore(path), start: 0, confirmations: 0, overlap: 4 })
  c.calls.length = 0
  const t = await second.tick()
  assert.equal(t.from, next - 4, 'rewound by the overlap')
  assert.ok(c.calls.includes('eth_getBlockReceipts:2'), 'the block with the sandwich was rescanned')
  assert.equal(t.found, 0)
  assert.equal(items(second).length, 1, 'no duplicate')
  assert.equal(second.state.next, next)
})

test('an RPC failure mid-scan keeps the state, and the next tick catches up', async () => {
  const c = fakeChain()
  for (let i = 0; i < 4; i++) c.mine(i === 1)
  const store = memoryStore()
  const w = createWatcher({ call: c.call, store, start: 0, confirmations: 0 })
  c.fail.add('eth_getBlockReceipts:1')
  await assert.rejects(w.tick(), /fake RPC down/)
  assert.equal(w.state.next, 0, 'nothing marked scanned')
  assert.equal(await store.load(), null, 'nothing saved')
  const t = await w.tick()
  assert.equal(t.found, 1)
  assert.equal(w.state.next, 4)
})

test('a reorg drops discoveries from the orphaned block and the rescan finds the new one', async () => {
  const c = fakeChain()
  c.mine()
  c.mine(true) // block 1
  c.mine()
  const w = createWatcher({ call: c.call, store: memoryStore(), start: 0, confirmations: 0 })
  await w.tick()
  const [orphan] = items(w)

  c.reorg(1, false) // block 1 replaced by one with no sandwich
  let t = await w.tick()
  assert.equal(t.reorged, 1)
  assert.equal(w.state.items[orphan.key].status, 'reorged')
  assert.equal(t.found, 0)

  c.reorg(1, true) // and again, by one with a different sandwich
  t = await w.tick()
  assert.equal(t.reorged, 0, 'the orphan is not counted twice')
  assert.equal(t.found, 1)
  assert.equal(items(w).filter((i) => i.status === 'discovered').length, 1)
})

test('receipts that belong to a different block than the one hashed abort the tick', async () => {
  const c = fakeChain()
  for (let i = 0; i < 3; i++) c.mine(i === 1)
  c.receiptsFromAnotherBlock(1)
  const w = createWatcher({ call: c.call, store: memoryStore(), start: 0, confirmations: 0 })
  await assert.rejects(w.tick(), /changed while it was read/)
  assert.equal(w.state.next, 0)
  assert.equal(items(w).length, 0)
})

test('proving is a separate, bounded stage with retries; discovery goes on when proving fails', async () => {
  const c = fakeChain()
  for (let i = 0; i < 4; i++) c.mine(i > 0) // sandwiches in blocks 1-3
  let failsLeft = 1
  const prove = async (item) => {
    if (item.block === 1 && failsLeft-- > 0) throw new Error('prover crashed')
    return { path: `claim-${item.block}.json` }
  }
  const w = createWatcher({ call: c.call, store: memoryStore(), start: 0, confirmations: 0, proveLimit: 2, prove })
  let t = await w.tick()
  assert.equal(t.found, 3, 'all three discovered at once')
  assert.equal(t.proven, 1, 'two proving attempts this tick, one failed')
  const byBlock = Object.fromEntries(items(w).map((i) => [i.block, i]))
  assert.equal(byBlock[1].status, 'discovered')
  assert.equal(byBlock[1].attempts, 1)
  assert.match(byBlock[1].error, /prover crashed/)
  assert.equal(byBlock[2].status, 'proven')
  assert.equal(byBlock[3].status, 'discovered', 'beyond this tick\'s prove limit')
  t = await w.tick()
  assert.equal(t.proven, 2)
  assert.deepEqual(items(w).map((i) => i.status).sort(), ['proven', 'proven', 'proven'])
  assert.equal(w.state.items[byBlock[1].key].claim.path, 'claim-1.json', 'the retried claim is recorded')

  const broken = fakeChain()
  broken.mine(true)
  const w2 = createWatcher({
    call: broken.call, store: memoryStore(), start: 0, confirmations: 0, maxAttempts: 2,
    prove: async () => {
      throw new Error('always')
    },
  })
  await w2.tick()
  await w2.tick()
  assert.equal(items(w2)[0].status, 'failed', 'gives up after maxAttempts')
})

test('submission outcomes are recorded', async () => {
  const c = fakeChain()
  for (let i = 0; i < 3; i++) c.mine(i > 0)
  const submit = async (item) => {
    if (item.block === 2) throw new Error('claim reverted: ClaimWindowClosed')
    return { tx: `0xsubmit${item.block}` }
  }
  const w = createWatcher({
    call: c.call, store: memoryStore(), start: 0, confirmations: 0, maxAttempts: 1,
    prove: async (item) => ({ path: `claim-${item.block}.json` }), submit,
  })
  const t = await w.tick()
  assert.equal(t.submitted, 1)
  const byBlock = Object.fromEntries(items(w).map((i) => [i.block, i]))
  assert.equal(byBlock[1].status, 'submitted')
  assert.equal(byBlock[1].submission.tx, '0xsubmit1')
  assert.equal(byBlock[2].status, 'failed')
  assert.match(byBlock[2].error, /ClaimWindowClosed/)
})

test('mapLimit never runs more than the limit at once', async () => {
  let running = 0
  let peak = 0
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
    peak = Math.max(peak, ++running)
    await new Promise((r) => setTimeout(r, 5))
    running--
    return x * 2
  })
  assert.equal(peak, 3)
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14])
})

test('a hung RPC endpoint times out instead of stalling', async () => {
  const server = createServer(() => {}) // accepts and never answers
  await new Promise((r) => server.listen(0, r))
  process.env.RPC_TIMEOUT_MS = '200'
  const { rpc } = await import('../lib.mjs?timeout') // fresh module, reads the env var
  const started = Date.now()
  await assert.rejects(rpc(`http://127.0.0.1:${server.address().port}`, 'eth_blockNumber', [], 1))
  assert.ok(Date.now() - started < 2_000, 'gave up quickly')
  server.closeAllConnections()
  server.close()
})

test('l1Anchor reads number and hash from one Base block', async () => {
  const seen = []
  const call = async (method, params) => {
    seen.push([method, params[1]])
    if (method === 'eth_blockNumber') return '0x10'
    const number = params[0].data === '0x8381f58a' // number()
    return '0x' + (number ? word(1234n) : 'ab'.repeat(32))
  }
  const a = await l1Anchor(call)
  assert.deepEqual(seen.filter(([m]) => m === 'eth_call').map(([, tag]) => tag), ['0x10', '0x10'])
  assert.equal(a.number, 1234n)
  assert.equal(a.hash, '0x' + 'ab'.repeat(32))
  assert.equal(a.baseBlock, 16n)
})
