// Price search for BlindfoldSettlement.settle. Pure logic: the chain sits behind
//   simulate(priceX96, marginal?) -> { ok: true } | { ok: false, poolX96? }
// where poolX96 is the post-swap pool price from a NotMarginalPrice revert (absent for other reverts).
// Prices are token1 per token0 in raw units, times 2^96 (AGENTS.md gotcha 8).

export const Q96 = 1n << 96n
const BPS = 10_000n

/** `p` moved by `k` basis points (k may be negative). */
export const atBps = (p, k) => (p * (BPS + BigInt(k))) / BPS

const absDiff = (a, b) => (a > b ? a - b : b - a)

/** Distance from `a` to `b` in basis points of `b`, rounded up. */
export const distBps = (a, b) => (absDiff(a, b) * BPS + b - 1n) / b

/**
 * An order's limit as a price, matching BlindfoldSettlement.quote: a sell (zeroForOne) fills at p >= limit,
 * a buy at p <= limit. null = no limit.
 */
export function limitPriceX96(o) {
  if (o.minAmountOut === 0n) return null
  return o.zeroForOne
    ? (o.minAmountOut * Q96 + o.amountIn - 1n) / o.amountIn // smallest p with amountIn * p / Q96 >= minOut
    : (o.amountIn * Q96) / o.minAmountOut // largest p with amountIn * Q96 / p >= minOut
}

/** A price settle accepts: follow the post-swap price to its fixed point (FM-AMM), else scan outward from the pool. */
async function firstFeasible(simulate, pool, maxBps) {
  const seen = new Set()
  for (let p = pool, i = 0; i < 16 && !seen.has(p); i++) {
    seen.add(p)
    const r = await simulate(p)
    if (r.ok) return p
    if (r.poolX96 === undefined) break
    p = r.poolX96
  }
  for (let d = 0; d <= maxBps; d++) {
    for (const k of d === 0 ? [0] : [d, -d]) {
      const p = atBps(pool, k)
      if ((await simulate(p)).ok) return p
    }
  }
  return null
}

/**
 * The band of prices settle accepts around the first feasible one, in 1 bp steps, and its midpoint.
 * Settling at the midpoint rather than the first price that works keeps the solver from leaning on
 * either side of the band (REVIEW.md R4).
 */
export async function findBand(simulate, pool, toleranceBps) {
  const p0 = await firstFeasible(simulate, pool, 3 * toleranceBps)
  if (p0 === null) return null
  const cap = 2 * toleranceBps + 2
  let lo = 0
  let hi = 0
  while (hi < cap && (await simulate(atBps(p0, hi + 1))).ok) hi++
  while (lo > -cap && (await simulate(atBps(p0, lo - 1))).ok) lo--
  return { lo: atBps(p0, lo), hi: atBps(p0, hi), priceX96: atBps(p0, Math.floor((lo + hi) / 2)) }
}

/**
 * No price fills everyone fully (REVIEW.md R1): let one order fill partially, at its own limit price.
 * Candidates are orders whose limit is near the pool, closest first. For each, binary-search the fill amount:
 * more of a sell pushes the post-swap price down, more of a buy pushes it up.
 */
export async function solveMarginal(simulate, pool, orders, maxBps) {
  const candidates = orders
    .map((o) => ({ o, p: limitPriceX96(o) }))
    .filter(({ p }) => p !== null && p > 0n && distBps(p, pool) <= BigInt(maxBps))
    .sort((a, b) => (distBps(a.p, pool) < distBps(b.p, pool) ? -1 : 1))
  for (const { o, p } of candidates) {
    let lo = 1n
    let hi = o.amountIn
    while (lo <= hi) {
      const x = (lo + hi) / 2n
      const r = await simulate(p, { id: o.id, amountIn: x })
      if (r.ok) return { priceX96: p, marginal: { id: o.id, amountIn: x } }
      if (r.poolX96 === undefined) break // this order can't be the marginal one
      const tooMuch = o.zeroForOne ? r.poolX96 < p : r.poolX96 > p
      if (tooMuch) hi = x - 1n
      else lo = x + 1n
    }
  }
  return null
}

/** Full search: the band midpoint if one exists, else a marginal partial fill (when the contract supports it). */
export async function solve({ simulate, poolX96, toleranceBps, orders, marginal = true }) {
  const band = await findBand(simulate, poolX96, toleranceBps)
  if (band) return { priceX96: band.priceX96, band }
  return marginal ? solveMarginal(simulate, poolX96, orders, 3 * toleranceBps) : null
}
