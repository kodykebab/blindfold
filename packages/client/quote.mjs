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
