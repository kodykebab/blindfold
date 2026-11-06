import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanSymbol, statusPayload } from '../quote.mjs'

const token0 = { address: '0x1111111111111111111111111111111111111111', symbol: 'TKA', decimals: 18 }
const token1 = { address: '0x2222222222222222222222222222222222222222', symbol: 'TKB', decimals: 6 }
const rows = [
  { tok: token0, wallet: 100n * 10n ** 18n, available: 20n * 10n ** 18n, reserved: 0n, withdrawable: 20n * 10n ** 18n },
  { tok: token1, wallet: 5n * 10n ** 6n, available: 1n * 10n ** 6n, reserved: 2n * 10n ** 6n, withdrawable: 0n },
]

test('status JSON uses decimal strings and the public batch schedule', () => {
  const payload = statusPayload({
    account: '0xabc',
    chainId: 31337n,
    token0,
    token1,
    rows,
    openCommitments: 0n,
    batchId: 3n,
    now: 1700000000n,
    deadlines: [{ at: 1700000060n, what: 'commits close' }],
    preparation: null,
    quote: null,
  })
  assert.equal(payload.account, '0xabc')
  assert.equal(payload.chainId, 31337)
  assert.equal(payload.pair.token0.symbol, 'TKA')
  assert.equal(payload.pair.token1.decimals, 6)
  assert.deepEqual(payload.balances[0], { token: 'token0', wallet: '100', available: '20', reserved: '0', withdrawable: '20' })
  assert.equal(payload.balances[1].wallet, '5')
  assert.equal(payload.balances[1].reserved, '2')
  assert.equal(payload.openCommitments, 0)
  assert.deepEqual(payload.batch, { id: '3', now: 1700000000, deadlines: [{ at: 1700000060, what: 'commits close' }] })
  assert.equal(payload.preparation, 'none')
  assert.equal(payload.quote, null)
})

test('a broken symbol falls back to the address, stripped and capped', () => {
  assert.equal(cleanSymbol('TKA', token0.address), 'TKA')
  assert.equal(cleanSymbol('A\u0000B\u0007', token0.address), 'AB')
  assert.equal(cleanSymbol('\u0000\u0001', token0.address), token0.address)
  assert.equal(cleanSymbol(null, token0.address), token0.address)
  assert.equal(cleanSymbol('X'.repeat(40), token0.address), 'X'.repeat(32))
})
