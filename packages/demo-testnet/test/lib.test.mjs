import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getCreate2Address, keccak256, zeroAddress } from 'viem'
import { DRAND_GENESIS, drandSchedule, mineHookSalt, poolIdOf } from '../lib.mjs'

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
