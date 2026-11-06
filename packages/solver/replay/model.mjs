// Pure model of Blindfold's public-pool settlement (settleExternal) applied to replayed order flow.
// It mirrors the contract's checks: UniswapV3Market.referencePrice (window mean ending at revealCloses, read within
// maxDelay, last observation within maxObservationAge, spot within maxDeviationBps of the mean), the settlement's
// price band around that reference, uniform-price limit fills and an exact-input residual that must cover what the
// batch owes. Prices are token1 per token0 in raw units, as floats: this estimates rates, it does not settle.

/** Swap logs (sorted by time) -> a queryable price path. */
export function pricePath(swaps) {
  const t = swaps.map((s) => s.timestamp)
  const at = (time) => { // index of the last swap at or before `time`, or -1
    let lo = 0, hi = t.length - 1, ans = -1
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (t[mid] <= time) { ans = mid; lo = mid + 1 } else hi = mid - 1 }
    return ans
  }
  return {
    /** State after the last swap at or before `time`. */
    state(time) { const i = at(time); return i < 0 ? null : swaps[i] },
    /** Seconds since the last swap at or before `time` (the oracle's newest observation). */
    observationAge(time) { const i = at(time); return i < 0 ? Infinity : time - t[i] },
    /** Mean tick over [end - window, end], with the tick held constant between swaps, as the v3 oracle does. */
    meanTick(end, window) {
      const start = end - window
      let i = at(start)
      if (i < 0) return null
      let acc = 0, from = start
      for (;;) {
        const next = i + 1 < swaps.length && t[i + 1] <= end ? t[i + 1] : end
        acc += swaps[i].tick * (next - from)
        if (next >= end) break
        from = next
        i++
      }
      return Math.floor(acc / window)
    },
  }
}

export const tickPrice = (tick) => Math.pow(1.0001, tick)
export const sqrtPrice = (sqrtPriceX96) => Number(sqrtPriceX96) / 2 ** 96

/**
 * Exact-input output against one in-range liquidity position (no tick crossing), fee on input.
 * zeroForOne: token0 in, token1 out.
 */
export function swapOut({ sqrtP, liquidity, fee }, zeroForOne, amountIn) {
  const L = Number(liquidity)
  if (!(L > 0) || !(amountIn > 0)) return 0
  const dx = amountIn * (1 - fee)
  if (zeroForOne) {
    const next = (L * sqrtP) / (L + dx * sqrtP)
    return L * (sqrtP - next)
  }
  const next = sqrtP + dx / L
  return L * (1 / sqrtP - 1 / next)
}

/** Output an order receives at uniform price p (token1 per token0), and whether its limit holds. */
export function quote(order, p) {
  const out = order.zeroForOne ? order.amountIn * p : order.amountIn / p
  return { out, fills: out > 0 && out >= order.minOut }
}

/**
 * Try one clearing price. Returns the filled set and whether the residual can execute on the pool.
 */
export function tryPrice(orders, p, pool) {
  let in0 = 0, in1 = 0, out0 = 0, out1 = 0
  const filled = []
  for (const o of orders) {
    const { out, fills } = quote(o, p)
    if (!fills) continue
    filled.push({ o, out })
    if (o.zeroForOne) { in0 += o.amountIn; out1 += out } else { in1 += o.amountIn; out0 += out }
  }
  if (!filled.length) return { ok: false, filled }
  // What the batch owes beyond its own opposing flow goes through the pool, exact input. Like _routeExternal and
  // _returnRounding, any pool output above what is owed goes back to that token's recipients pro rata.
  let surplus0 = in0 - out0, surplus1 = in1 - out1
  if (in0 > out0 && out1 > in1) {
    const got = swapOut(pool, true, in0 - out0)
    if (got < out1 - in1) return { ok: false, filled }
    surplus0 = 0
    surplus1 = got - (out1 - in1)
  } else if (in1 > out1 && out0 > in0) {
    const got = swapOut(pool, false, in1 - out1)
    if (got < out0 - in0) return { ok: false, filled }
    surplus1 = 0
    surplus0 = got - (out0 - in0)
  } else if (out0 > in0 || out1 > in1) return { ok: false, filled }
  const paid = new Map()
  for (const { o, out } of filled) {
    const [total, extra] = o.zeroForOne ? [out1, surplus1] : [out0, surplus0]
    paid.set(o, out + (total > 0 ? (extra * out) / total : 0))
  }
  return { ok: true, filled, paid }
}

/**
 * Clear one batch at settlement time. Returns per-order outcomes and the batch-level reason when nothing settles.
 * cfg: window, maxDelay, maxObservationAge, maxDeviationBps, fee, solverDelay
 */
export function clearBatch(orders, schedule, path, cfg) {
  const settleAt = schedule.revealCloses + cfg.solverDelay
  if (cfg.solverDelay > cfg.maxDelay) return { reason: 'StaleReference' }
  if (path.observationAge(settleAt) > cfg.maxObservationAge) return { reason: 'StaleObservation' }
  const mean = path.meanTick(schedule.revealCloses, cfg.window)
  const s = path.state(settleAt)
  if (mean === null || !s) return { reason: 'InsufficientHistory' }
  const ref = tickPrice(mean)
  const spotSqrt = sqrtPrice(s.sqrtPriceX96)
  const spot = spotSqrt ** 2
  const dev = cfg.maxDeviationBps / 10000
  if (Math.abs(spot - ref) > ref * dev) return { reason: 'PriceDeviation' }
  const pool = { sqrtP: spotSqrt, liquidity: s.liquidity, fee: cfg.fee }

  // Candidates: the band edges, the reference, spot and every order's limit price inside the band.
  const lo = ref * (1 - dev), hi = ref * (1 + dev)
  const cands = new Set([lo, hi, ref, Math.min(Math.max(spot, lo), hi)])
  for (const o of orders) {
    const limit = o.zeroForOne ? o.minOut / o.amountIn : o.amountIn / o.minOut
    if (limit >= lo && limit <= hi) cands.add(limit)
  }
  // Keep the price that fills the most input value (measured at the reference); among those, the one closest to spot.
  let best = null
  for (const p of cands) {
    const r = tryPrice(orders, p, pool)
    if (!r.ok) continue
    const value = r.filled.reduce((a, { o }) => a + (o.zeroForOne ? o.amountIn * ref : o.amountIn), 0)
    const gap = Math.abs(p - spot)
    if (!best || value > best.value * (1 + 1e-9) || (value >= best.value * (1 - 1e-9) && gap < best.gap)) {
      best = { p, value, gap, paid: r.paid }
    }
  }
  if (!best) return { reason: 'NoExecutablePrice' }
  return { p: best.p, paid: best.paid, settleAt, ref, spot }
}
