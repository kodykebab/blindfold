import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeAbiParameters, encodeEventTopics, getCreate2Address, keccak256, parseAbi, zeroAddress } from 'viem'
import { DRAND_GENESIS, createdV3Pool, drandSchedule, mineHookSalt, orderedSandwich, parseTrack, receiptVisible, poolIdOf, v3FactoryFromManifest, victimSandwich, waitForState, splitLogFilter, rpcRequest } from '../lib.mjs'

test('poolIdOf matches a live mainnet v4 pool (ETH/USDC 0.05%)', () => {
  const key = { currency0: zeroAddress, currency1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', fee: 500, tickSpacing: 10, hooks: zeroAddress }
  assert.equal(poolIdOf(key), '0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27')
})

test('mineHookSalt finds an address with only the BEFORE_SWAP flag', () => {
  const from = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
  const bytecodeHash = keccak256('0x6080')
  const { salt, address } = mineHookSalt(from, bytecodeHash)
  assert.equal(BigInt(address) & 0x3fffn, 0x80n)
  assert.equal(getCreate2Address({ from, salt, bytecodeHash }), address)
})

test('drandSchedule sits on the 3 s drand grid', () => {
  for (const now of [DRAND_GENESIS, DRAND_GENESIS + 1n, 1793993119n]) {
    const s = drandSchedule(now, 61)
    assert.equal((s.start - DRAND_GENESIS) % 3n, 0n)
    assert.ok(s.start <= now && now - s.start < 3n)
    assert.equal(s.batchLength, 60n)
  }
})

test('parseTrack reads the client\'s track lines, fills included', () => {
  const out = [
    'account 0xabc',
    '#3 batch 7: filled (sell 10000000000000000000) → got 9.97 dUSD [full fill: 10 dWETH of 10 dWETH]',
    '#4 batch 7: unfilled (buy 10000000000000000000)',
    '#5 batch 8: committed (sealed)',
  ].join('\n')
  assert.deepEqual(parseTrack(out), [
    { id: 3, batch: 7, state: 'filled', what: 'sell 10000000000000000000', fill: '→ got 9.97 dUSD [full fill: 10 dWETH of 10 dWETH]' },
    { id: 4, batch: 7, state: 'unfilled', what: 'buy 10000000000000000000', fill: '' },
    { id: 5, batch: 8, state: 'committed', what: 'sealed', fill: '' },
  ])
})

test('v3 factory discovery accepts the official document and rejects a missing factory', () => {
  const address = '0x1234567890123456789012345678901234567890'
  assert.equal(v3FactoryFromManifest(`### Uniswap V3 Factory\n\nAddress: [${address}](https://example.com)`), address)
  assert.throws(() => v3FactoryFromManifest('### Other Factory\nAddress: ' + address), /cannot find v3 factory/)
})

test('a detected sandwich requires three ordered transactions in one block', () => {
  const leg = (blockNumber, transactionIndex) => ({ blockNumber, transactionIndex })
  assert.equal(orderedSandwich(leg(12n, 0), leg(12n, 1), leg(12n, 2)), true)
  assert.equal(orderedSandwich(leg(12n, 0), leg(12n, 1), leg(13n, 0)), false)
  assert.equal(orderedSandwich(leg(12n, 1), leg(12n, 0), leg(12n, 2)), false)
})

test('victim verification matches the transaction and pool', () => {
  const match = { victim: { txHash: '0xAbC', pool: '0xDEF' } }
  assert.equal(victimSandwich([match], '0xabc', '0xdef'), match)
  assert.equal(victimSandwich([match], '0xabc', '0x999'), undefined)
  assert.equal(victimSandwich([match], '0xaaa', '0xdef'), undefined)
})

test('v3 deployment uses the pool address in the factory receipt', () => {
  const abi = parseAbi(['event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)'])
  const factory = '0x1111111111111111111111111111111111111111'
  const pool = '0x2222222222222222222222222222222222222222'
  const log = { address: factory, topics: encodeEventTopics({ abi, eventName: 'PoolCreated', args: { token0: zeroAddress, token1: factory, fee: 3000 } }), data: encodeAbiParameters([{ type: 'int24' }, { type: 'address' }], [60, pool]) }
  assert.equal(createdV3Pool({ logs: [log] }, factory, abi).toLowerCase(), pool)
  assert.throws(() => createdV3Pool({ logs: [log] }, pool, abi), /no PoolCreated/)
})

test('deployment waits for RPC state after receipt and fails if it never appears', async () => {
  let calls = 0
  await waitForState(async () => ++calls === 3, { attempts: 3, intervalMs: 0 })
  assert.equal(calls, 3)
  await assert.rejects(waitForState(async () => false, { attempts: 2, intervalMs: 0 }), /did not become visible/)
})

test('proxy holds a preconfirmed receipt until latest-state reads include its block', () => {
  assert.equal(receiptVisible(null, '0x10'), true)
  assert.equal(receiptVisible({ blockNumber: '0x11' }, '0x10'), false)
  assert.equal(receiptVisible({ blockNumber: '0x11' }, '0x11'), true)
  assert.equal(receiptVisible({ blockNumber: '0x11' }, '0x12'), true)
})

test('historical log filters are split into ordered bounded ranges', () => {
  const filters = splitLogFilter({ address: '0x123', fromBlock: '0x64', toBlock: 'latest' }, 1200n, 500n)
  assert.deepEqual(filters.map((f) => [f.fromBlock, f.toBlock]), [['0x64', '0x257'], ['0x258', '0x44b'], ['0x44c', '0x4b0']])
  assert.ok(filters.every((f) => f.address === '0x123'))
  assert.deepEqual(splitLogFilter({ blockHash: '0xabc' }, 1200n), [{ blockHash: '0xabc' }])
})

test('RPC reads retry transient failures without replaying raw transactions', async () => {
  let calls = 0
  const fetcher = async () => { if (++calls < 3) throw new Error('network'); return { ok: true, json: async () => ({ result: '0x1' }) } }
  assert.equal(await rpcRequest('http://rpc', 'eth_blockNumber', [], { fetcher, delayMs: 0 }), '0x1')
  assert.equal(calls, 3)
  calls = 0
  await assert.rejects(rpcRequest('http://rpc', 'eth_sendRawTransaction', ['0x01'], { fetcher, delayMs: 0 }), /network/)
  assert.equal(calls, 1)
})
