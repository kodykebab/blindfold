import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, matchVictim, duneSql, check, FIXTURES } from './check.mjs'

const POOL = '0x' + '11'.repeat(20), ID = '0x' + '00'.repeat(32)
// v3 pool-side amounts: a0 > 0 means token0 paid in (zeroForOne)
const sw = (txIndex, from, a0, a1, trader = from) => ({ v4: false, pool: POOL, poolId: ID, txIndex, logIndex: 0, from, trader, a0, a1 })
const block = [
  sw(1, 'bot', 100n, -90n),   // front: buys token1
  sw(2, 'alice', 50n, -40n),  // victim 1
  sw(3, 'carol', 20n, -15n),  // victim 2 (findSandwiches alone reports only alice)
  sw(4, 'dave', -10n, 9n),    // opposite direction: not a victim
  sw(5, 'bot', -105n, 90n),   // back: sells token1, +5 token0
]

test('classify tx hash, address, junk', () => {
  assert.equal(classify('0x' + 'Ab'.repeat(32)).kind, 'tx')
  assert.equal(classify(' 0x' + 'ab'.repeat(20) + ' ').kind, 'address')
  assert.equal(classify('0x1234').kind, 'invalid')
  assert.equal(classify('vitalik.eth').kind, 'invalid')
})

test('matchVictim finds every victim, not just the first', () => {
  for (const [i, who] of [[2, 'alice'], [3, 'carol']]) {
    const [m, ...rest] = matchVictim(block, i)
    assert.equal(rest.length, 0)
    assert.equal(m.victim.from, who)
    assert.equal(m.profit, 5n)
    assert.equal(m.front.txIndex, 1)
  }
})

test('matchVictim ignores attacker, opposite-direction and outside txs', () => {
  for (const i of [1, 4, 5, 9]) assert.deepEqual(matchVictim(block, i), [])
})

test('duneSql only takes a validated address', () => {
  assert.match(duneSql('0x' + 'ab'.repeat(20)), /tx_from = 0xabab/)
  assert.throws(() => duneSql("0x00' or 1=1 --"))
})

test('OFFLINE serves fixtures and reports misses', async () => {
  process.env.OFFLINE = '1'
  const addr = Object.keys(FIXTURES).find((k) => k.length === 42)
  const r = await check(addr.toUpperCase().replace('0X', '0x'))
  assert.equal(r.fixture, true)
  assert.ok(r.sandwichCount > 0)
  assert.match((await check('0x' + '00'.repeat(20))).error, /no fixture/)
  delete process.env.OFFLINE
})

test('ownTxs keeps only successful txs the address sent', async () => {
  const { ownTxs } = await import('./check.mjs')
  const me = '0x' + 'aa'.repeat(20)
  const list = [
    { hash: 'a', from: me.toUpperCase().replace('0X', '0x'), isError: '0', txreceipt_status: '1' },
    { hash: 'b', from: me, isError: '1', txreceipt_status: '0' },
    { hash: 'c', from: '0x' + 'bb'.repeat(20), isError: '0', txreceipt_status: '1' }, // incoming
  ]
  assert.deepEqual(ownTxs(list, me).map((t) => t.hash), ['a'])
})

test('hasSwap spots v3 and v4 Swap logs only', async () => {
  const { hasSwap } = await import('./check.mjs')
  const { V3_SWAP, V4_SWAP } = await import('../../packages/court-watcher/lib.mjs')
  assert.equal(hasSwap({ logs: [{ topics: ['0x' + '00'.repeat(32)] }, { topics: [V3_SWAP] }] }), true)
  assert.equal(hasSwap({ logs: [{ topics: [V4_SWAP] }] }), true)
  assert.equal(hasSwap({ logs: [{ topics: ['0x' + '00'.repeat(32)] }] }), false)
})

test('mapLimit keeps order, caps concurrency, nulls failures', async () => {
  const { mapLimit } = await import('./check.mjs')
  let live = 0, peak = 0
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (x) => {
    live++; peak = Math.max(peak, live)
    await new Promise((r) => setTimeout(r, 5))
    live--
    if (x === 3) throw new Error('boom')
    return x * 10
  })
  assert.deepEqual(out, [10, 20, null, 40, 50])
  assert.equal(peak, 2)
})

test('rpcBatch orders by id and retries what the batch dropped', async () => {
  const { rpcBatch } = await import('./check.mjs')
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    const json = Array.isArray(body)
      ? body.filter((q) => q.id !== 1).reverse().map((q) => ({ jsonrpc: '2.0', id: q.id, result: `r${q.params[0]}` })) // drops id 1, out of order
      : { jsonrpc: '2.0', id: body.id, result: `single${body.params[0]}` }
    return { json: async () => json }
  }
  try {
    assert.deepEqual(await rpcBatch('m', [['a'], ['b'], ['c']]), ['ra', 'singleb', 'rc'])
    assert.equal(calls.length, 2)
  } finally { globalThis.fetch = real }
})
