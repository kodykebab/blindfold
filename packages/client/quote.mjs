// Pure logic for quote-based limits (FIXES.md fix 4), resubmitting orders that did not fill and keeping one
// preparation ready (fix 5). Prices are raw token1 per token0 x 2^96, as the settlement and markets report them.

export const Q96 = 1n << 96n
const PPM = 1_000_000n
const BPS = 10_000n

/** What `amountIn` buys at `priceX96`, after a pool fee in parts per million (rounded down, like the settlement). */
export function quoteOut({ zeroForOne, amountIn, priceX96, feePpm = 0n }) {
  if (priceX96 <= 0n) throw new Error('no price to quote from')
  const gross = zeroForOne ? (amountIn * priceX96) / Q96 : (amountIn * Q96) / priceX96
  return (gross * (PPM - BigInt(feePpm))) / PPM
}

/** The limit a quote and a slippage tolerance give: the minimum output the order accepts. */
export function limitFromQuote(quote, slippageBps) {
  const s = BigInt(slippageBps)
  if (s < 0n || s >= BPS) throw new Error('slippage must be 0-9999 basis points')
  return (quote * (BPS - s)) / BPS
}

/** "--slippage 50" style input: a whole number of basis points below 10,000. */
export function parseSlippage(text) {
  if (!/^\d+$/.test(String(text ?? ''))) throw new Error('slippage is a whole number of basis points, e.g. 50 for 0.5%')
  const s = BigInt(text)
  if (s >= BPS) throw new Error('slippage must be below 10000 basis points')
  return s
}

/** Combined fee of hops in a route, each in ppm: 1 - product(1 - fee). */
export function routeFeePpm(fees) {
  let keep = PPM
  for (const f of fees) keep = (keep * (PPM - BigInt(f))) / PPM
  return PPM - keep
}

/**
 * The order to try again: the most recent saved commitment whose tracked outcome is unfilled or expired and that has not
 * been resubmitted already. tracked: Map from track(); saved: the client's saved commitments (with order and hash).
 */
export function retryable(tracked, saved) {
  const byHash = new Map([...tracked.values()].map((c) => [c.hash?.toLowerCase(), c]))
  for (let i = saved.length - 1; i >= 0; i--) {
    const s = saved[i]
    const t = byHash.get(s.hash?.toLowerCase())
    if (!t || !s.order || s.order.amountIn === 0n) continue
    if (t.state !== 'unfilled' && t.state !== 'expired') continue
    if (s.resubmittedAs) continue
    return { saved: s, tracked: t }
  }
  return null
}

/**
 * Which tracked commitment replaced which, from the saved `resubmittedAs` links (T13): Map(id → {replacedBy, replaces}).
 * replacedBy is 'pending' while the replacement has no commitment id yet.
 */
export function replacements(tracked, saved) {
  const idOf = new Map([...tracked.values()].map((c) => [c.hash?.toLowerCase(), c.id]))
  const links = new Map()
  const at = (id) => links.get(id) ?? links.set(id, {}).get(id)
  for (const s of saved) {
    if (!s.resubmittedAs) continue
    const from = idOf.get(s.hash?.toLowerCase()), to = idOf.get(s.resubmittedAs.toLowerCase())
    if (from === undefined) continue
    at(from).replacedBy = to ?? 'pending'
    if (to !== undefined) at(to).replaces = from
  }
  return links
}

/**
 * What `status` says about advance preparation (T06): generating, ready, expired, consumed or none.
 * preparing: the marker `prepare-admission` saves while it proves; running(pid) tells whether that process still runs.
 */
export function preparationStatus({ preparation, preparing, consumed, current, running }) {
  if (preparing && running(preparing.pid)) return `generating for batch ${preparing.batch} (round ${preparing.round}) in process ${preparing.pid}`
  if (preparation) {
    return BigInt(preparation.batch) >= BigInt(current)
      ? `ready for batch ${preparation.batch} (round ${preparation.round}): an order in that batch needs only the online proof`
      : `expired: batch ${preparation.batch} has closed; the next commit discards it`
  }
  if (consumed) return `none ready; the last one was consumed by an order for batch ${consumed.batch}. Run prepare-admission, or keep-ready while you trade`
  return 'none ready; run prepare-admission, or keep-ready while you trade'
}

/**
 * Which batch to prepare a key for so that one is always ready, or null when the ready one still serves. The earliest
 * batch this device can still prepare for and then prove an order in (`preparation` + `online` seconds before it closes).
 * A key for that batch or a later one is kept; one for an earlier or closed batch is replaced.
 */
export function nextPreparation({ prepBatch, current, commitsClose, batchLength, now, preparation, online }) {
  ;[current, commitsClose, batchLength, now, preparation, online] = [current, commitsClose, batchLength, now, preparation, online].map(BigInt)
  const target = commitsClose - now >= preparation + online ? current : current + 1n
  if (prepBatch !== undefined && prepBatch !== null && BigInt(prepBatch) >= target) return null
  return target
}

/**
 * What waiting for the batch typically costs, from the order-flow replay of 2026-11-06 (packages/solver/replay.mjs,
 * PR #76): filled orders against the same swap executed immediately, median, 50 bps limits. Shown before every order
 * so users can judge whether the protection is worth it (FIXES.md fix 8).
 */
export const WAIT_COST = { deepBps: [3, 6], thinBps: [8, 18], source: 'order-flow replay, 2026-11-06' }

/** Seconds from `now` until the batch can settle: its reveal deadline plus about one block for the solver. */
export const settlesIn = ({ now, revealCloses, block = 12n }) => (revealCloses > now ? revealCloses - now : 0n) + block

export function waitNote({ now, revealCloses }) {
  const { deepBps: d, thinBps: t, source } = WAIT_COST
  return [
    `wait: settles about ${settlesIn({ now, revealCloses })}s from now`,
    `cost of waiting: typically ${d[0]}-${d[1]} bps on deep pools and ${t[0]}-${t[1]} bps on thin ones against an immediate swap (${source}).`
      + ' Blindfold pays off when MEV protection is worth more than that: larger orders, or pairs that get sandwiched.',
  ]
}
