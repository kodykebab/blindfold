// Price search for BlindfoldSettlement.settle. Pure logic: the chain sits behind
//   simulate(priceX96, marginal?) -> { ok: true } | { ok: false, poolX96?, error? }
// where poolX96 is the post-swap pool price from a NotMarginalPrice revert and error is the revert's name.
// Prices are token1 per token0 in raw units, times 2^96 (AGENTS.md gotcha 8).
//
// Why bisection works: as the price p rises, more sells and fewer buys fill and each buy needs less token0, so
// the batch sells more token0 into the pool and the post-swap price falls. post(p) - p is therefore strictly
// decreasing: every failed simulation says which way the accepted band lies.

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

/** Token0 the batch sells into the pool at price p (negative = buys), with settle's fill rule. */
export function net0At(orders, p, marginal) {
  let net = 0n
  for (const o of orders) {
    let amountIn = o.amountIn
    if (marginal && o.id === marginal.id) amountIn = marginal.amountIn
    else {
      const out = o.zeroForOne ? (o.amountIn * p) / Q96 : (o.amountIn * Q96) / p
      if (out === 0n || out < o.minAmountOut) continue
    }
    net += o.zeroForOne ? amountIn : -((amountIn * Q96) / p)
  }
  return net
}

/** 0 = settle accepts p; +1 = the post-swap price ends above p (try higher); -1 = below; null = can't tell. */
function side(r, p, orders, marginal) {
  if (r.ok) return 0
  if (r.poolX96 !== undefined) return r.poolX96 > p ? 1 : -1
  // the pool couldn't pay what p promises: it would have to move past p in the batch's direction
  if (r.error === 'ResidualShort') return net0At(orders, p, marginal) > 0n ? -1 : 1
  return null
}

/**
 * A price settle accepts, by bracketing the crossing of post(p) and p and bisecting it.
 * Returns { p }, or { gap: { lo, hi } } when the band is empty between two adjacent prices (an order's
 * all-or-nothing fill jumps over it: REVIEW.md R1), or {} when a simulation fails in an unreadable way.
 */
async function firstFeasible(simulate, pool, orders) {
  const at = async (p) => side(await simulate(p), p, orders)
  let d = await at(pool)
  if (d === 0) return { p: pool }
  if (d === null) return {}
  let lo = pool
  let hi = pool
  for (let step = 16; ; step *= 2) {
    const q = d > 0 ? atBps(lo, step) : atBps(hi, -Math.min(step, 5_000))
    const dq = await at(q)
    if (dq === 0) return { p: q }
    if (dq === null) return {}
    if (d > 0) [lo, hi] = dq > 0 ? [q, q] : [lo, q]
    else [lo, hi] = dq < 0 ? [q, q] : [q, hi]
    if (lo !== hi) break
    if (step > 1 << 20) return {}
  }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n
    const dm = await at(mid)
    if (dm === 0) return { p: mid }
    if (dm === null) return {}
    if (dm > 0) lo = mid
    else hi = mid
  }
  return { gap: { lo, hi } }
}

/** The accepted band around `p0`, walked in 1 bp steps. */
async function bandAround(simulate, p0, toleranceBps) {
  const cap = 2 * toleranceBps + 2
  let lo = 0
  let hi = 0
  while (hi < cap && (await simulate(atBps(p0, hi + 1))).ok) hi++
  while (lo > -cap && (await simulate(atBps(p0, lo - 1))).ok) lo--
  return { lo: atBps(p0, lo), hi: atBps(p0, hi), priceX96: atBps(p0, Math.floor((lo + hi) / 2)) }
}

/**
 * The band of prices settle accepts and its midpoint, or null. Settling at the midpoint rather than the first
 * price that works keeps the solver from leaning on either side of the band (REVIEW.md R4).
 */
export async function findBand(simulate, pool, toleranceBps, orders = []) {
  const f = await firstFeasible(simulate, pool, orders)
  return f.p === undefined ? null : bandAround(simulate, f.p, toleranceBps)
}

/**
 * No price fills everyone fully (REVIEW.md R1): one order fills partially, at its own limit price. Candidates are
 * orders whose limit sits in the gap the bisection found (they cause the jump), closest to it first. For each,
 * binary-search the fill amount: more of a sell pushes the post-swap price down, more of a buy pushes it up.
 */
export async function solveMarginal(simulate, gap, orders, toleranceBps) {
  const from = atBps(gap.lo, -toleranceBps)
  const to = atBps(gap.hi, toleranceBps)
  const mid = (gap.lo + gap.hi) / 2n
  const candidates = orders
    .map((o) => ({ o, p: limitPriceX96(o) }))
    .filter(({ p }) => p !== null && p >= from && p <= to)
    .sort((a, b) => (distBps(a.p, mid) < distBps(b.p, mid) ? -1 : 1))
  for (const { o, p } of candidates) {
    let lo = 1n
    let hi = o.amountIn
    while (lo <= hi) {
      const x = (lo + hi) / 2n
      const m = { id: o.id, amountIn: x }
      const s = side(await simulate(p, m), p, orders, m)
      if (s === 0) return { priceX96: p, marginal: m }
      if (s === null) break // this order can't be the marginal one
      const tooMuch = o.zeroForOne ? s < 0 : s > 0
      if (tooMuch) hi = x - 1n
      else lo = x + 1n
    }
  }
  return null
}

/** Full search: the band midpoint if one exists, else a marginal partial fill (when the contract supports it). */
export async function solve({ simulate, poolX96, toleranceBps, orders, marginal = true }) {
  const f = await firstFeasible(simulate, poolX96, orders)
  if (f.p !== undefined) {
    const band = await bandAround(simulate, f.p, toleranceBps)
    return { priceX96: band.priceX96, band }
  }
  return marginal && f.gap ? solveMarginal(simulate, f.gap, orders, toleranceBps) : null
}
