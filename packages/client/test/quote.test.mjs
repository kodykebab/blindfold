import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanSymbol, gasQuote, priceFromX96, readQuote, statusPayload } from '../quote.mjs'

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

test('X96 prices convert with both decimals, including a price below 1', () => {
  const one = 1n << 96n
  assert.equal(priceFromX96(one, 18, 18), '1')
  assert.equal(priceFromX96(one, 18, 6), '1000000000000')
  assert.equal(priceFromX96(one / 2n, 18, 18), '0.5')
  assert.equal(priceFromX96(one * 3n, 6, 18), '0.000000000003')
})

test('a reverted reference price is null and carries the reason', async () => {
  const block = { number: 9n, timestamp: 1700000000n }
  const quote = await readQuote({
    has: (name) => name === 'referencePriceX96',
    block,
    batchId: 3n,
    decimals0: 18,
    decimals1: 18,
    read: async (name) => {
      if (name === 'poolPriceX96') return 1n << 96n
      if (name === 'poolLiquidity') return 123n
      throw new Error('ExternalConfig')
    },
  })
  assert.equal(quote.pool.price, '1')
  assert.equal(quote.pool.source, 'BlindfoldSettlement.poolPriceX96')
  assert.equal(quote.pool.blockNumber, '9')
  assert.equal(quote.external.price, null)
  assert.equal(quote.external.reason, 'ExternalConfig')
  assert.equal(quote.liquidity.raw, '123')
  assert.equal(quote.liquidity.label, 'pool liquidity (v4 units)')
  assert.equal(quote.liquidity.estimate, null)
  assert.equal(quote.liquidity.estimateReason, 'estimate not available')
  const gas = gasQuote({ units: 1000n, gasPrice: 2n * 10n ** 9n, block })
  assert.equal(gas.eth, '0.000002')
  assert.equal(gas.units, '1000')
  assert.equal(gasQuote({ block, reason: 'preview does not build an admission proof' }).eth, null)
})

test('a broken symbol falls back to the address, stripped and capped', () => {
  assert.equal(cleanSymbol('TKA', token0.address), 'TKA')
  assert.equal(cleanSymbol('A\u0000B\u0007', token0.address), 'AB')
  assert.equal(cleanSymbol('\u0000\u0001', token0.address), token0.address)
  assert.equal(cleanSymbol(null, token0.address), token0.address)
  assert.equal(cleanSymbol('X'.repeat(40), token0.address), 'X'.repeat(32))
})
