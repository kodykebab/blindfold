import test from 'node:test'
import assert from 'node:assert/strict'
import { clearBatch, pricePath, swapOut, tickPrice, tryPrice } from '../replay/model.mjs'

const Q96 = 2 ** 96
const at = (timestamp, tick, liquidity = 1e24) => ({ timestamp, tick, sqrtPriceX96: Math.sqrt(tickPrice(tick)) * Q96, liquidity })
const cfg = { window: 600, maxDelay: 30, maxObservationAge: 120, maxDeviationBps: 100, fee: 0.0005, solverDelay: 12 }

test('mean tick holds each tick until the next swap, like the v3 oracle', () => {
  const path = pricePath([at(0, 100), at(300, 200)])
  assert.equal(path.meanTick(600, 600), 150)
  assert.equal(path.meanTick(900, 600), 200)
  assert.equal(path.meanTick(500, 600), null) // not enough history
  assert.equal(path.observationAge(450), 150)
})

test('swapOut charges the fee and gives less than spot for size', () => {
  const pool = { sqrtP: 1, liquidity: 1e6, fee: 0.003 }
  const small = swapOut(pool, true, 1)
  assert.ok(small < 1 * (1 - 0.003) + 1e-9 && small > 0.996)
  assert.ok(swapOut(pool, true, 1e5) / 1e5 < small) // price impact
  assert.ok(Math.abs(swapOut(pool, false, 1) - small) < 1e-6) // symmetric at price 1
})

test('crossed flow needs no pool swap; residual output above what is owed goes back to its recipients', () => {
  const pool = { sqrtP: 1, liquidity: 1e12, fee: 0.0005 }
  const sell = { zeroForOne: true, amountIn: 100, minOut: 90 }
  const buy = { zeroForOne: false, amountIn: 100, minOut: 90 }
  const crossed = tryPrice([sell, buy], 1, pool)
  assert.ok(crossed.ok)
  assert.equal(crossed.paid.get(sell), 100)
  // one-sided: at a price below what the pool pays, the seller gets the pool's whole output, not just p
  const alone = tryPrice([sell], 0.99, pool)
  assert.ok(alone.ok)
  assert.ok(Math.abs(alone.paid.get(sell) - swapOut(pool, true, 100)) < 1e-9)
  assert.equal(tryPrice([sell], 1, pool).ok, false) // spot itself can't cover the fee
})

test('a batch expires on a quiet pool or a moved spot, and fills within the limits otherwise', () => {
  const o = { zeroForOne: true, amountIn: 1e18, minOut: 0.99e18 * tickPrice(0) }
  const quiet = pricePath([at(0, 0), at(100, 0)])
  assert.equal(clearBatch([o], { revealCloses: 1000 }, quiet, cfg).reason, 'StaleObservation')
  const off = { ...cfg, maxObservationAge: Infinity }
  const r = clearBatch([o], { revealCloses: 1000 }, quiet, off)
  assert.ok(r.paid.has(o))
  const jump = pricePath([at(0, 0), at(1005, 200)]) // +2% right before settlement
  assert.equal(clearBatch([o], { revealCloses: 1000 }, jump, off).reason, 'PriceDeviation')
  const tight = { ...o, minOut: 1.01e18 }
  assert.equal(clearBatch([tight], { revealCloses: 1000 }, quiet, off).reason, 'NoExecutablePrice')
})
