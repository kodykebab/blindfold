import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getCreate2Address, keccak256, zeroAddress } from 'viem'
import { DRAND_GENESIS, drandSchedule, mineHookSalt, orderedSandwich, parseTrack, poolIdOf, v3FactoryFromManifest, victimSandwich } from '../lib.mjs'

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
