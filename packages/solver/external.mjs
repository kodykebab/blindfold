import { allocationsAt, limitPriceX96, marginalPriceX96, sameLimit } from './price.mjs'
import { peerTotals } from './peer.mjs'

/** Bounded candidate search, not an infeasibility or maximum-volume proof.
 * Prefer full fills, then price-priority proportional boundary groups. Every
 * result is simulated; reverts do not establish monotonic execution feasibility.
 */
export async function solveExternal({ referenceX96, deviationBps, simulate, orders,
  maxSimulations = 4096, deadlineMs = Infinity, now = () => performance.now() }) {
  if (referenceX96 <= 0n || !Number.isInteger(deviationBps) || deviationBps < 1 || deviationBps > 1000 ||
      !Number.isInteger(maxSimulations) || maxSimulations < 1) {
    throw new Error('invalid external reference configuration')
  }
  const delta = referenceX96 * BigInt(deviationBps) / 10_000n
  const lower = referenceX96 - delta, upper = referenceX96 + delta
  let calls = 0
  const cache = new Map()
  const attempt = async (price, marginal) => {
    if (price < lower || price > upper || price <= 0n) return false
    if (now() >= deadlineMs) throw new Error('external search deadline reached')
    const key = `${price}:${marginal?.id ?? ''}:${marginal?.amountIn ?? ''}`
    if (cache.has(key)) return cache.get(key)
    if (orders) {
      const t = peerTotals(orders, price, marginal)
      if (!t.validLimits || t.out0 + t.out1 === 0n) return false
    }
    if (calls >= maxSimulations) throw new Error('external search simulation budget exhausted')
    calls++
    const ok = (await simulate(price, marginal)).ok
    if (now() >= deadlineMs) throw new Error('external search deadline reached')
    cache.set(key, ok)
    return ok
  }
  const nearest = (values) => [...new Set(values.filter((p) => p !== null && p >= lower && p <= upper))]
    .sort((a, b) => {
      const x = a > referenceX96 ? a - referenceX96 : referenceX96 - a
      const y = b > referenceX96 ? b - referenceX96 : referenceX96 - b
      return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0
    })
  const grid = [referenceX96]
  for (let bps = 1; bps <= deviationBps; bps++) {
    const step = referenceX96 * BigInt(bps) / 10_000n
    grid.push(referenceX96 - step, referenceX96 + step)
  }
  // Exact limit edges prevent a sub-basis-point fill interval being skipped.
  const edges = (orders ?? []).flatMap((o) => {
    const p = limitPriceX96(o)
    return p === null ? [] : [p - 1n, p, p + 1n]
  })
  for (const price of nearest([...grid, ...edges])) {
    if (await attempt(price)) return { priceX96: price, external: true }
  }
  if (!orders) return null
  const groups = []
  for (const o of [...orders].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (o.amountIn > 0n && !groups.some((g) => sameLimit(g, o))) groups.push(o)
  }
  for (const ref of groups) {
    const prices = nearest([referenceX96, lower, upper, ...edges])
    for (const anchor of prices) {
      const candidatePrice = (amountIn) => {
        if (ref.minAmountOut === 0n) return anchor
        const required = marginalPriceX96(orders, ref, amountIn)
        return ref.zeroForOne ? (anchor > required ? anchor : required) : (anchor < required ? anchor : required)
      }
      const at = async (amountIn) => attempt(candidatePrice(amountIn), { id: ref.id, amountIn })
      // Halving seeks an executable lot; bisection refines only that bracket.
      // Non-monotone gaps can remain, so a null result is deliberately inconclusive.
      let high = ref.amountIn, low = 0n
      for (let amount = high; amount > 0n; amount /= 2n) {
        if (await at(amount)) { low = amount; break }
        high = amount
      }
      if (low === 0n) continue
      while (high - low > 1n) {
        const mid = (low + high) / 2n
        if (await at(mid)) low = mid
        else high = mid
      }
      const marginal = { id: ref.id, amountIn: low }
      const priceX96 = candidatePrice(low)
      // Reject a boundary whose proportional rounding leaves every order empty.
      if (allocationsAt(orders, priceX96, marginal).some((x) => x > 0n)) {
        return { priceX96, marginal, external: true }
      }
    }
  }
  return null
}
