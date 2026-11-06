import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, matchVictim, check, checkAddress, FIXTURES } from './check.mjs'

const POOL = '0x' + '11'.repeat(20), ID = '0x' + '00'.repeat(32)
// v3 pool-side amounts: a0 > 0 means token0 paid in (zeroForOne)
// `trader` (court-watcher before S5) and `caller` (after) both name the contract that called the pool
const sw = (txIndex, from, a0, a1, via = from) => ({ v4: false, pool: POOL, poolId: ID, txIndex, logIndex: 0, from, trader: via, caller: via, a0, a1 })
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

test('matchVictim finds a victim who used the same router as the attacker', () => {
  const R = 'router'
  const shared = [
    sw(1, 'bot', 100n, -90n, R), // front, through a public router
    sw(2, 'alice', 50n, -40n),   // another victim, own route
    sw(3, 'carol', 20n, -15n, R), // victim through the same router
    sw(4, 'bot', -105n, 90n, R), // back
  ]
  const [m, ...rest] = matchVictim(shared, 3)
  assert.equal(rest.length, 0)
  assert.equal(m.victim.from, 'carol')
  assert.equal(m.front.txIndex, 1)
})

test('matchVictim ignores attacker, opposite-direction and outside txs', () => {
  for (const i of [1, 4, 5, 9]) assert.deepEqual(matchVictim(block, i), [])
})

test('matchVictim catches a bot that keeps inventory, which Court cannot prove', () => {
  // shape of tx 0xa5dd…6acb (block 26,352,400): the back-run sells back ~99% and re-buys a little in the same tx
  const kept = [sw(0, 'bot', 627843n, -276006n), sw(2, 'eve', 8967n, -3882n), sw(3, 'bot', -620539n, 272778n), sw(3, 'bot', 152n, -68n)]
  const [m, ...rest] = matchVictim(kept, 2)
  assert.equal(rest.length, 0)
  assert.equal(m.strict, false) // closes 98.8%, outside Court's 1%
  assert.equal(m.kept, 3296n) // token1 the bot still holds
  assert.equal(m.back.a0, -620539n + 152n) // the back-run's two swaps count as one leg
  // got back 620,387, paid 627,843, kept 3,296 token1 worth 7,498 at the back-run's price
  assert.equal(m.profit, 620387n - 627843n + (3296n * 620387n) / 272710n)
  assert.equal(m.profit, 42n)
})

test('matchVictim skips a back-run that unwinds less than half, or loses money', () => {
  const half = [sw(0, 'bot', 100n, -100n), sw(1, 'eve', 10n, -9n), sw(2, 'bot', -40n, 40n)]
  assert.deepEqual(matchVictim(half, 1), [])
  const loss = [sw(0, 'bot', 100n, -100n), sw(1, 'eve', 10n, -9n), sw(2, 'bot', -90n, 100n)]
  assert.deepEqual(matchVictim(loss, 1), [])
})

test('matchVictim marks the strict sandwiches Court can prove', () => {
  assert.equal(matchVictim(block, 2)[0].strict, true)
})

test('address lookup without an Etherscan key says what it needs', async () => {
  const key = process.env.ETHERSCAN_API_KEY
  delete process.env.ETHERSCAN_API_KEY
  assert.match((await checkAddress('0x' + 'ab'.repeat(20))).error, /needs ETHERSCAN_API_KEY/)
  if (key !== undefined) process.env.ETHERSCAN_API_KEY = key
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


test('network selection routes lookups and isolates cached results', async () => {
  const originalFetch = globalThis.fetch
  const hash = '0x' + 'fe'.repeat(32), calls = []
  globalThis.fetch = async (url, init) => {
    const request = JSON.parse(init.body)
    calls.push({ url, method: request.method })
    const result = request.method === 'eth_getTransactionReceipt'
      ? { blockNumber: '0x1', transactionIndex: '0x0' }
      : request.method === 'eth_getBlockReceipts' ? []
        : request.method === 'eth_getBlockByNumber' ? { timestamp: '0x1' } : '0x1'
    return { json: async () => ({ result }) }
  }
  try {
    const main = await check(hash, 'mainnet')
    const testnet = await check(hash, 'testnet')
    assert.equal(main.network, 'mainnet')
    assert.equal(testnet.network, 'testnet')
    assert.equal(testnet.cached, undefined)
    assert.ok(calls.some((c) => c.url.includes('sepolia.unichain.org')))
    assert.equal((await check(hash, 'testnet')).cached, true)
    assert.match((await check(hash, 'invalid')).error, /unknown network/)
  } finally { globalThis.fetch = originalFetch }
})

test('testnet selects v3 and v4 swap logs', async () => {
  const { hasSwap } = await import('./check.mjs')
  const { V3_SWAP, V4_SWAP } = await import('../../packages/court-watcher/lib.mjs')
  assert.equal(hasSwap({ logs: [{ topics: [V4_SWAP] }] }), true)
  assert.equal(hasSwap({ logs: [{ topics: [V3_SWAP] }] }), true)
  assert.equal(hasSwap({ logs: [{ topics: ['0x' + '00'.repeat(32)] }] }), false)
})

test('testnet replays a v4 sandwich on Unichain Sepolia and prices it in ETH from Blockscout', async () => {
  const { V4_SWAP } = await import('../../packages/court-watcher/lib.mjs')
  const originalFetch = globalThis.fetch
  const PM = '0x00b036b58a818b1bc34d502d3fe730db729e62ac', POOL_ID = '0x' + 'ab'.repeat(32)
  const hash = (n) => '0x' + n.toString(16).padStart(64, '0')
  const addr = (n) => '0x' + n.toString(16).padStart(40, '0')
  const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0')
  // v4 Swap amounts are swapper-side: negative is paid in. a0/a1 here are pool-side, as in the v3 test.
  const receipt = (i, from, caller, a0, a1) => ({
    status: '0x1', blockNumber: '0x10', transactionIndex: `0x${i.toString(16)}`, transactionHash: hash(i + 101), from: addr(from),
    logs: [{ address: PM, topics: [V4_SWAP, POOL_ID, hash(caller)], data: '0x' + word(-a0) + word(-a1) }],
  })
  const e15 = 10n ** 15n
  const receipts = [receipt(0, 1, 9, 100n * e15, -90n * e15), receipt(1, 2, 8, 50n * e15, -40n * e15), receipt(2, 1, 9, -105n * e15, 90n * e15)]
  const urls = []
  globalThis.fetch = async (url, init) => {
    urls.push(String(url))
    if (String(url).includes('blockscout')) return { json: async () => ({ status: '1', result: [{ topics: [hash(0), POOL_ID, hash(0), hash(7)] }] }) }
    const q = JSON.parse(init.body)
    const result = q.method === 'eth_getTransactionReceipt' ? receipts[1]
      : q.method === 'eth_getBlockReceipts' ? receipts
        : q.method === 'eth_getBlockByNumber' ? { timestamp: '0x100' } : '0x10'
    return { json: async () => ({ result }) }
  }
  try {
    const s = (await check(hash(102), 'testnet')).txs[0].sandwiches[0] // own hashes: check() caches per network and input
    assert.equal(s.v4, true)
    assert.equal(s.pool, PM)
    assert.equal(s.poolId, POOL_ID)
    assert.equal(s.profitRaw, String(5n * e15))
    assert.equal(s.token, addr(0)) // currency0 is native ETH
    assert.equal(s.symbol, 'ETH')
    assert.equal(s.amount, 0.005)
    assert.equal(s.usd, null)
    assert.ok(urls.some((u) => u.includes(`unichain-sepolia.blockscout.com/api?module=logs&action=getLogs&address=${PM}`) && u.includes(`topic1=${POOL_ID}`)))
    assert.ok(!urls.some((u) => u.includes('llama')), 'testnet profits are not priced')
  } finally { globalThis.fetch = originalFetch }
})

test('testnet replays a v3 sandwich and returns its raw profit', async () => {
  const { V3_SWAP } = await import('../../packages/court-watcher/lib.mjs')
  const originalFetch = globalThis.fetch
  const hash = (n) => '0x' + n.toString(16).padStart(64, '0')
  const addr = (n) => '0x' + n.toString(16).padStart(40, '0')
  const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0')
  const receipt = (i, from, a0, a1) => ({
    status: '0x1', blockNumber: '0x10', transactionIndex: `0x${i.toString(16)}`,
    transactionHash: hash(i + 1), from: addr(from),
    logs: [{ address: POOL, topics: [V3_SWAP, hash(0), hash(from)], data: '0x' + word(a0) + word(a1) }],
  })
  const receipts = [receipt(0, 1, 100, -90), receipt(1, 2, 50, -40), receipt(2, 1, -105, 90)]
  globalThis.fetch = async (_url, init) => {
    const q = JSON.parse(init.body)
    const result = q.method === 'eth_getTransactionReceipt' ? receipts[1]
      : q.method === 'eth_getBlockReceipts' ? receipts
        : q.method === 'eth_getBlockByNumber' ? { timestamp: '0x100' }
          : q.method === 'eth_call' ? '0x' + addr(3).slice(2).padStart(64, '0') : '0x10'
    return { json: async () => ({ result }) }
  }
  try {
    const result = await check(hash(2), 'testnet')
    assert.equal(result.sandwichCount, 1)
    assert.equal(result.txs[0].sandwiches[0].profitRaw, '5')
    assert.equal(result.txs[0].sandwiches[0].usd, null)
    assert.equal(result.txs[0].sandwiches[0].courtProvable, false)
  } finally { globalThis.fetch = originalFetch }
})
