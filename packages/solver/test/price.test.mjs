import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Q96, atBps, distBps, limitPriceX96, findBand, solve } from '../price.mjs'

const E = 10n ** 18n
const order = (id, zeroForOne, amountIn, minAmountOut) => ({ id, zeroForOne, amountIn, minAmountOut })

/**
 * A fake settle with the contract's rules: fills follow from the price (or the marginal fill), and the
 * post-swap price (linear impact: `depth` token0 moves it 100%) must be within tolerance of the price.
 */
function market({ pool = Q96, depth = 5_000n * E, toleranceBps = 100, orders }) {
  const calls = { n: 0 }
  const simulate = async (p, m) => {
    calls.n++
    let net0 = 0n // token0 the batch sells into the pool
    for (const o of orders) {
      let amountIn = o.amountIn
      if (m && o.id === m.id) {
        const limit = limitPriceX96(o)
        if (limit === null || distBps(limit, p) > BigInt(toleranceBps) || m.amountIn > o.amountIn) return { ok: false }
        amountIn = m.amountIn
      } else {
        const out = o.zeroForOne ? (o.amountIn * p) / Q96 : (o.amountIn * Q96) / p
        if (out === 0n || out < o.minAmountOut) continue
      }
      net0 += o.zeroForOne ? amountIn : -((amountIn * Q96) / p)
    }
    const post = pool - (pool * net0) / depth
    const diff = post > p ? post - p : p - post
    return diff * 10_000n <= BigInt(toleranceBps) * p ? { ok: true } : { ok: false, poolX96: post }
  }
  return { simulate, calls, pool, toleranceBps, orders }
}

test('limitPriceX96 is exactly where quote starts to hold', () => {
  const sell = order(1n, true, 100n * E, 95n * E)
  const ls = limitPriceX96(sell)
  assert.ok((sell.amountIn * ls) / Q96 >= sell.minAmountOut)
  assert.ok((sell.amountIn * (ls - 1n)) / Q96 < sell.minAmountOut)
  const buy = order(2n, false, 50n * E, 45n * E)
  const lb = limitPriceX96(buy)
  assert.ok((buy.amountIn * Q96) / lb >= buy.minAmountOut)
  assert.ok((buy.amountIn * Q96) / (lb + 1n) < buy.minAmountOut)
  assert.equal(limitPriceX96(order(3n, true, 1n, 0n)), null)
})

test('two-sided batch: settles at the middle of the accepted band, near the post-swap price', async () => {
  const m = market({ orders: [order(1n, true, 100n * E, 95n * E), order(2n, false, 50n * E, 45n * E)] })
  const band = await findBand(m.simulate, m.pool, m.toleranceBps)
  assert.ok(band, 'a band exists')
  assert.ok(band.lo < band.hi && band.lo <= band.priceX96 && band.priceX96 <= band.hi)
  assert.ok((await m.simulate(band.priceX96)).ok)
  // net 50 token0 sold into a 5000-deep pool: post-swap ~0.99, so the band is centred there
  assert.ok(distBps(band.priceX96, atBps(Q96, -100)) <= 10n, 'midpoint ~0.99')
})

test('an empty batch settles at the pool price', async () => {
  const m = market({ orders: [] })
  const s = await solve({ ...m, poolX96: m.pool })
  assert.ok(s && !s.marginal && distBps(s.priceX96, m.pool) <= 1n)
})

test('poison order: no full-fill price exists, so one order fills partially at its own limit (R1)', async () => {
  // REVIEW.md R1: a 300 sell with limit 0.975 moves the pool ~6% if filled and keeps it near 1.0 if not
  const poison = order(2n, true, 300n * E, (300n * E * 975n) / 1000n)
  const m = market({ orders: [order(1n, false, 10n * E, 9n * E), poison] })
  assert.equal(await findBand(m.simulate, m.pool, m.toleranceBps), null, 'no band')
  assert.equal(await solve({ ...m, poolX96: m.pool, marginal: false }), null, 'stuck without the R1 overload')
  const s = await solve({ ...m, poolX96: m.pool })
  assert.ok(s?.marginal, 'a marginal solution')
  assert.equal(s.marginal.id, 2n)
  assert.ok(s.marginal.amountIn > 0n && s.marginal.amountIn < poison.amountIn, 'partial fill')
  assert.equal(s.priceX96, limitPriceX96(poison))
  assert.ok((await m.simulate(s.priceX96, s.marginal)).ok)
})

test('a large one-sided batch still converges (price far from the pool)', async () => {
  const m = market({ orders: [order(1n, false, 400n * E, 1n)] }) // buys move the price ~8% up
  const s = await solve({ ...m, poolX96: m.pool })
  assert.ok(s && !s.marginal)
  assert.ok((await m.simulate(s.priceX96)).ok)
  assert.ok(s.priceX96 > atBps(m.pool, 500), 'well above the starting pool price')
})
