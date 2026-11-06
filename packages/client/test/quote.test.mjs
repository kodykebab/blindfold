import test from 'node:test'
import assert from 'node:assert/strict'
import { Q96, limitFromQuote, nextPreparation, parseSlippage, quoteOut, retryable, routeFeePpm, settlesIn, waitNote } from '../quote.mjs'

const e18 = 10n ** 18n

test('quotes follow the price in both directions, after the pool fee, rounded down', () => {
  const twoPerOne = 2n * Q96 // 2 token1 per token0
  assert.equal(quoteOut({ zeroForOne: true, amountIn: 10n * e18, priceX96: twoPerOne }), 20n * e18)
  assert.equal(quoteOut({ zeroForOne: false, amountIn: 10n * e18, priceX96: twoPerOne }), 5n * e18)
  assert.equal(quoteOut({ zeroForOne: true, amountIn: 10n * e18, priceX96: twoPerOne, feePpm: 500n }), 19_990n * 10n ** 15n) // 0.05%
  assert.equal(quoteOut({ zeroForOne: false, amountIn: 3n, priceX96: twoPerOne }), 1n) // 1.5 rounds down
  // mixed decimals: 1 WETH (18) at 3,000 USDC (6) per WETH, priced token1 (USDC) per token0 (WETH) in raw units
  const usdcPerWeth = (3000n * 10n ** 6n * Q96) / e18
  assert.equal(quoteOut({ zeroForOne: true, amountIn: e18, priceX96: usdcPerWeth }), 3000n * 10n ** 6n - 1n)
  assert.throws(() => quoteOut({ zeroForOne: true, amountIn: 1n, priceX96: 0n }), /no price/)
})

test('the limit is the quote less the slippage, and slippage input is validated', () => {
  assert.equal(limitFromQuote(10_000n, 50n), 9_950n)
  assert.equal(limitFromQuote(10_000n, 0n), 10_000n)
  assert.equal(limitFromQuote(1n, 50n), 0n)
  assert.throws(() => limitFromQuote(10n, 10_000n), /0-9999/)
  assert.equal(parseSlippage('50'), 50n)
  assert.equal(parseSlippage(30), 30n)
  for (const bad of ['', '-1', '0.5', 'abc', '10000', undefined]) assert.throws(() => parseSlippage(bad), /basis points/)
})

test('route fees compound across hops', () => {
  assert.equal(routeFeePpm([]), 0n)
  assert.equal(routeFeePpm([500n]), 500n)
  assert.equal(routeFeePpm([500n, 3000n]), 3499n) // 1 - 0.9995 * 0.997 = 0.3498...%, rounded against the user
})

test('resubmit picks the latest unfilled or expired order it still has, once', () => {
  const order = { amountIn: 10n, minAmountOut: 9n, zeroForOne: true }
  const tracked = new Map([
    [0n, { id: 0n, hash: '0xAA', state: 'filled' }],
    [1n, { id: 1n, hash: '0xbb', state: 'expired' }],
    [2n, { id: 2n, hash: '0xcc', state: 'unfilled' }],
    [3n, { id: 3n, hash: '0xdd', state: 'committed' }],
  ])
  const saved = [{ hash: '0xaa', order }, { hash: '0xbb', order }, { hash: '0xcc', order }, { hash: '0xdd', order }]
  assert.equal(retryable(tracked, saved).tracked.id, 2n)
  saved[2].resubmittedAs = '0xee'
  assert.equal(retryable(tracked, saved).tracked.id, 1n)
  saved[1].resubmittedAs = '0xff'
  assert.equal(retryable(tracked, saved), null)
  assert.equal(retryable(tracked, [{ hash: '0xbb' }]), null, 'an entry without its order cannot be placed again')
  assert.equal(retryable(tracked, [{ hash: '0xbb', order: { ...order, amountIn: 0n } }]), null, 'padding is not an order')
})

test('keep-ready prepares for the earliest batch it can still make, and keeps a key that serves it', () => {
  const at = (now, prepBatch) => nextPreparation({ prepBatch, current: 4n, commitsClose: 300n, batchLength: 300, now, preparation: 60, online: 75n })
  assert.equal(at(100n, undefined), 4n) // 200 s left: prepare (60) and prove (75) fit
  assert.equal(at(200n, undefined), 5n) // 100 s left: too late for this batch
  assert.equal(at(100n, '4'), null) // a key for the current batch is ready
  assert.equal(at(200n, '4'), 5n) // that key can no longer be used: replace it
  assert.equal(at(200n, '5'), null)
  assert.equal(at(100n, '3'), 4n) // a key for a closed batch is replaced
})

test('the order shows when it settles and what waiting typically costs, with its source', () => {
  assert.equal(settlesIn({ now: 100n, revealCloses: 160n }), 72n)
  assert.equal(settlesIn({ now: 200n, revealCloses: 160n }), 12n)
  const [wait, cost] = waitNote({ now: 100n, revealCloses: 160n })
  assert.match(wait, /settles about 72s from now/)
  assert.match(cost, /3-6 bps on deep pools and 8-18 bps on thin ones/)
  assert.match(cost, /order-flow replay, 2026-11-06/)
  assert.match(cost, /larger orders, or pairs that get sandwiched/)
})
