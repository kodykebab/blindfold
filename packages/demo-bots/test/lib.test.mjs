import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEther } from 'viem'
import { amountOut, maxPayoutFor, planSandwich } from '../lib.mjs'

// the demo pool: 1000 ETH / 1000 DEMO of full-range liquidity at 1:1, 0.3% fee
const pool = { sqrtPriceX96: 2n ** 96n, liquidity: parseEther('1000'), fee: 3000, zeroForOne: true }
const R = parseEther('1000')
const victimIn = parseEther('10')
const quote = amountOut(R, R, victimIn, 3000).out
const minOut = (quote * 9700n) / 10_000n // 3% slippage

/** Replays a plan on the constant-product curve: what the victim then gets, and what the back leg returns. */
function replay(frontIn) {
  const f = amountOut(R, R, frontIn, 3000)
  const v = amountOut(R + f.net, R - f.out, victimIn, 3000)
  const b = amountOut(R - f.out - v.out, R + f.net + v.net, f.out, 3000)
  return { victimOut: v.out, backOut: b.out }
}

test('sizes the largest front leg the victim still clears, and the back leg profits', () => {
  const plan = planSandwich({ ...pool, victimIn, minOut, maxFront: parseEther('100') })
  assert.ok(plan)
  assert.ok(plan.victimOut >= minOut, 'the victim tx still succeeds')
  assert.ok(plan.profit > 0n)
  assert.deepEqual(replay(plan.frontIn), { victimOut: plan.victimOut, backOut: plan.backOut })
  // the largest such front: one more wei misses the 10 bps rounding margin, 5% more reverts the victim tx
  assert.ok(replay(plan.frontIn + 1n).victimOut < (minOut * 10_010n) / 10_000n)
  assert.ok(replay((plan.frontIn * 105n) / 100n).victimOut < minOut)
  // about 15 ETH on this pool (DemoSandwich.t.sol uses 15 ETH)
  assert.ok(plan.frontIn > parseEther('14') && plan.frontIn < parseEther('16'), `front ${plan.frontIn}`)
})

test('caps the front leg at what the bot holds', () => {
  const plan = planSandwich({ ...pool, victimIn, minOut, maxFront: parseEther('1') })
  assert.equal(plan.frontIn, parseEther('1'))
  assert.ok(plan.profit > 0n)
})

test('no sandwich when the victim allows no slippage, or the bot has nothing', () => {
  assert.equal(planSandwich({ ...pool, victimIn, minOut: quote, maxFront: parseEther('100') }), null)
  assert.equal(planSandwich({ ...pool, victimIn, minOut, maxFront: 0n }), null)
})

test('sizes the other direction too (victim sells token1)', () => {
  const plan = planSandwich({ ...pool, zeroForOne: false, victimIn, minOut, maxFront: parseEther('100') })
  assert.ok(plan && plan.profit > 0n && plan.victimOut >= minOut)
})

test('maxPayout is the share of the input the slippage gives up', () => {
  assert.equal(maxPayoutFor(parseEther('10'), parseEther('10'), parseEther('9.7')), parseEther('0.3'))
  assert.equal(maxPayoutFor(parseEther('10'), parseEther('9'), parseEther('9')), 0n)
  assert.equal(maxPayoutFor(parseEther('10'), parseEther('9'), parseEther('9.5')), 0n, 'minOut above the quote')
})
