// Price search for BlindfoldSettlement.settle. Pure logic: the chain sits behind
//   simulate(priceX96, marginal?) -> { ok: true } | { ok: false, poolX96?, error? }
// where poolX96 is the post-swap pool price from a NotMarginalPrice revert and error is the revert's name.
// Prices are token1 per token0 in raw units, times 2^96 (AGENTS.md gotcha 8).
//
// Directional reverts guide the search; integer rounding and order boundaries can
// introduce gaps. Every returned candidate is simulated, and search exhaustion
// is not evidence that no feasible allocation exists.

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

export const sameLimit = (a, b) => a.zeroForOne === b.zeroForOne &&
  a.minAmountOut * b.amountIn === b.minAmountOut * a.amountIn
const ceilDiv = (a, b) => (a + b - 1n) / b
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a }

export const inputLot = (o) => o.amountIn / gcd(o.amountIn, o.minAmountOut)
export const partialInput = (o, numerator, denominator, price) => {
  let amount = o.amountIn * numerator / denominator
  const output = o.zeroForOne ? amount * price / Q96 : amount * Q96 / price
  const minimum = ceilDiv(o.minAmountOut * amount, o.amountIn)
  if (output < minimum) {
    const lot = inputLot(o)
    amount = amount / lot * lot
  }
  return amount
}
/** Largest representative retains the finest available fraction resolution. */
export function limitGroups(orders) {
  const groups = []
  const ranked = [...orders].sort((a, b) => a.amountIn > b.amountIn ? -1 : a.amountIn < b.amountIn ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  for (const o of ranked) if (o.amountIn > 0n && !groups.some((g) => sameLimit(g, o))) groups.push(o)
  return groups
}

/** Match the proportional contract rule, including priority and input dust. */
export function allocationsAt(orders, p, marginal) {
  const ref = marginal && orders.find((o) => o.id === marginal.id)
  if (marginal && (!ref || marginal.amountIn <= 0n || marginal.amountIn > ref.amountIn)) {
    throw new Error('invalid marginal representative or fraction')
  }
  return orders.map((o) => {
    if (ref && o.zeroForOne === ref.zeroForOne) {
      const limit = o.minAmountOut * ref.amountIn
      const boundary = ref.minAmountOut * o.amountIn
      if (limit > boundary) return 0n
      if (limit === boundary) {
        const amount = partialInput(o, marginal.amountIn, ref.amountIn, p)
        const out = o.zeroForOne ? amount * p / Q96 : amount * Q96 / p
        return out === 0n && o.minAmountOut === 0n ? 0n : amount
      }
    }
    const out = o.zeroForOne ? o.amountIn * p / Q96 : o.amountIn * Q96 / p
    return out > 0n && out >= o.minAmountOut ? o.amountIn : 0n
  })
}

/** Token0 net input, using the same group allocation as settlement. */
export function net0At(orders, p, marginal) {
  return allocationsAt(orders, p, marginal).reduce((net, amount, i) =>
    net + (orders[i].zeroForOne ? amount : -(amount * Q96 / p)), 0n)
}

/** Executable-side price needed to preserve every rounded-up partial minimum. */
export function marginalPriceX96(orders, ref, amountIn, toleranceBps = 100) {
  let p = limitPriceX96(ref)
  for (const o of orders.filter((o) => sameLimit(o, ref))) {
    const filled = o.amountIn * amountIn / ref.amountIn
    if (filled === 0n) continue
    const minimum = ceilDiv(o.minAmountOut * filled, o.amountIn)
    const required = o.zeroForOne ? ceilDiv(minimum * Q96, filled) : filled * Q96 / minimum
    const limit = limitPriceX96(ref)
    const inside = o.zeroForOne ? required <= limit * (BPS + BigInt(toleranceBps)) / BPS
      : required >= ceilDiv(limit * BPS, BPS + BigInt(toleranceBps))
    if (!inside) continue // this member uses the contract's whole-lot fallback
    p = o.zeroForOne ? (p > required ? p : required) : (p < required ? p : required)
  }
  return p
}

/** 0 = settle accepts p; +1 = the post-swap price ends above p (try higher); -1 = below; null = can't tell. */
function side(r, p, orders, marginal) {
  if (r.ok) return 0
  if (r.poolX96 !== undefined) return r.poolX96 > p ? 1 : -1
  // the pool couldn't pay what p promises: it would have to move past p in the batch's direction
  if (r.error === 'ResidualShort' || r.error === 'PartialResidual') return net0At(orders, p, marginal) > 0n ? -1 : 1
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
    if (q <= 0n || q >= (1n << 256n)) return {}
    const dq = await at(q)
    if (dq === 0) return { p: q }
    if (dq === null) return {}
    if (d > 0) [lo, hi] = dq > 0 ? [q, q] : [lo, q]
    else [lo, hi] = dq < 0 ? [q, q] : [q, hi]
    if (lo !== hi) break
    if (step > 1 << 20) return {}
  }
  // Test exact fill discontinuities before bisecting Q96 raw units. Otherwise
  // a poison order costs ~96 RPC calls just to rediscover a known limit edge.
  const edges = [...new Set(orders.map((o) => {
    const limit = limitPriceX96(o)
    return limit === null ? null : o.zeroForOne ? limit : limit + 1n
  }).filter((p) => p !== null && p > lo && p <= hi))].sort((a, b) => a < b ? -1 : 1)
  for (const edge of edges) {
    if (edge <= lo || edge > hi) continue
    const left = await at(edge - 1n)
    if (left === 0) return { p: edge - 1n }
    const right = await at(edge)
    if (right === 0) return { p: edge }
    if (left > 0 && right < 0) return { gap: { lo: edge - 1n, hi: edge } }
    if (right > 0) lo = edge
    if (left < 0) hi = edge - 1n
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

/** Search one representative per exact-limit group, never one privileged order.
 * Use exact proportional lots first, then raw units with a rounding-safe price.
 * The contract remains the authority for residual fees and available liquidity.
 */
export async function solveMarginal(simulate, gap, orders, toleranceBps, pool = Q96) {
  const middle = gap ? (gap.lo + gap.hi) / 2n : pool
  const candidates = []
  for (const o of limitGroups(orders)) {
    const p = limitPriceX96(o)
    if (p === null || o.amountIn < 2n || candidates.some((c) => sameLimit(c.o, o))) continue
    candidates.push({ o, p })
  }
  candidates.sort((a, b) => {
    const da = absDiff(a.p, middle), db = absDiff(b.p, middle)
    return da < db ? -1 : da > db ? 1 : 0
  })
  for (const { o } of candidates) {
    const group = orders.filter((x) => sameLimit(x, o))
    const commonInput = group.reduce((a, x) => gcd(a, x.amountIn), 0n)
    const inputLot = o.amountIn / gcd(o.amountIn, o.minAmountOut)
    const exactSteps = commonInput / inputLot
    const stride = o.amountIn / exactSteps
    for (const step of [...new Set([stride, 1n])]) {
      let lo = 1n, hi = (o.amountIn - 1n) / step
      while (lo <= hi) {
        const x = (lo + hi) / 2n
        const m = { id: o.id, amountIn: x * step }
        const p = marginalPriceX96(orders, o, m.amountIn, toleranceBps)
        if (p <= 0n) break
        const r = await simulate(p, m)
        const direction = side(r, p, orders, m)
        if (direction === 0) return { priceX96: p, marginal: m }
        if (direction === null) break
        const tooMuch = o.zeroForOne ? direction < 0 : direction > 0
        if (tooMuch) hi = x - 1n
        else lo = x + 1n
      }
    }
  }
  return null
}

export class SearchBudgetExceeded extends Error {
  constructor(limit) { super(`solver simulation budget exhausted (${limit}); feasibility is unknown`) }
}

/** Find and validate a candidate. null means no candidate found, not proven infeasibility. */
export async function solve({ simulate, poolX96, toleranceBps, orders, marginal = true, maxSimulations = 4096 }) {
  if (poolX96 <= 0n || !Number.isSafeInteger(toleranceBps) || toleranceBps < 0 ||
      !Number.isSafeInteger(maxSimulations) || maxSimulations < 1) throw new Error('invalid solver inputs')
  let calls = 0
  const checked = async (p, m) => {
    if (++calls > maxSimulations) throw new SearchBudgetExceeded(maxSimulations)
    return simulate(p, m) // RPC errors must propagate, never masquerade as infeasibility.
  }
  const f = await firstFeasible(checked, poolX96, orders)
  if (f.p !== undefined) {
    const band = await bandAround(checked, f.p, toleranceBps)
    if ((await checked(band.priceX96)).ok) return { priceX96: band.priceX96, band }
    // A sampled band can hide a discrete gap. Preserve the known executable point.
    if ((await checked(f.p)).ok) return { priceX96: f.p }
    throw new Error('simulation state changed during search')
  }
  return marginal ? solveMarginal(checked, f.gap, orders, toleranceBps, poolX96) : null
}
