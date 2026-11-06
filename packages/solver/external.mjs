/** Search the validated reference band, closest price first, in one-basis-point steps.
 * Every candidate is simulated onchain. This bounded full-fill search is not an
 * infeasibility proof; peer matching is a separate fixed-reference fallback.
 */
export async function solveExternal({ referenceX96, deviationBps, simulate }) {
  if (referenceX96 <= 0n || !Number.isInteger(deviationBps) || deviationBps < 1 || deviationBps > 1000) {
    throw new Error('invalid external reference configuration')
  }
  const seen = new Set()
  for (let bps = 0; bps <= deviationBps; bps++) {
    const delta = referenceX96 * BigInt(bps) / 10_000n
    for (const price of [referenceX96 - delta, referenceX96 + delta]) {
      if (price <= 0n || seen.has(price)) continue
      seen.add(price)
      if ((await simulate(price)).ok) return { priceX96: price, external: true }
    }
  }
  return null
}
