import { Q96, allocationsAt, sameLimit } from './price.mjs'

/** Pre-bonus token budgets. Conservation must hold separately for each token. */
export function peerTotals(orders, price, marginal) {
  const amounts = allocationsAt(orders, price, marginal)
  const t = { in0: 0n, out0: 0n, in1: 0n, out1: 0n, validLimits: true }
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i], input = amounts[i]
    if (input === 0n) continue
    const output = o.zeroForOne ? input * price / Q96 : input * Q96 / price
    const minimum = (o.minAmountOut * input + o.amountIn - 1n) / o.amountIn
    if (output === 0n || output < minimum) t.validLimits = false
    if (o.zeroForOne) { t.in0 += input; t.out1 += output }
    else { t.in1 += input; t.out0 += output }
  }
  return t
}

/** Find a price-priority crossing at the fixed reference price, without an AMM leg.
 * Amount search is local BigInt arithmetic; only budget-balanced candidates go
 * to RPC simulation. This helper never changes the reference price.
 */
export async function solvePeer({ orders, priceX96, simulate }) {
  if (priceX96 <= 0n) throw new Error('invalid peer reference price')
  const groups = []
  for (const o of [...orders].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const out = o.zeroForOne ? o.amountIn * priceX96 / Q96 : o.amountIn * Q96 / priceX96
    if (out === 0n || out < o.minAmountOut || groups.some((g) => sameLimit(g, o))) continue
    groups.push(o)
  }
  groups.sort((a, b) => {
    if (a.zeroForOne !== b.zeroForOne) return a.zeroForOne ? -1 : 1
    const d = a.minAmountOut * b.amountIn - b.minAmountOut * a.amountIn
    return d < 0n ? -1 : d > 0n ? 1 : 0
  })
  for (const ref of groups) {
    const totals = (x) => peerTotals(orders, priceX96, { id: ref.id, amountIn: x })
    const supplied = (t) => ref.zeroForOne ? t.in0 >= t.out0 : t.in1 >= t.out1
    let lo = 1n, hi = ref.amountIn
    if (!supplied(totals(hi))) continue
    // First fraction that funds the opposing side's quoted outputs.
    while (lo < hi) {
      const mid = (lo + hi) / 2n
      if (supplied(totals(mid))) hi = mid
      else lo = mid + 1n
    }
    const t = totals(lo)
    if (!t.validLimits || t.out0 === 0n || t.out1 === 0n || t.in0 < t.out0 || t.in1 < t.out1) continue
    const peer = { id: ref.id, amountIn: lo }
    if ((await simulate(peer)).ok) return { priceX96, peer }
  }
  return null
}
