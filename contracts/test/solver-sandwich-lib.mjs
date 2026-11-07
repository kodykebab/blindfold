// Pure helpers for contracts/test/solver-sandwich.mjs. No network access.
export const Q96 = 1n << 96n

export const json = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)

/** Output of an order at a uniform price, rounded down (BlindfoldSettlement.quote). */
export function quoteOut(zeroForOne, amountIn, priceX96) {
  if (priceX96 <= 0n) throw new Error('price must be positive')
  return zeroForOne ? amountIn * priceX96 / Q96 : amountIn * Q96 / priceX96
}

/** Signed basis points of `part` relative to `whole`, truncated toward zero, as a Number with 2 decimals. */
export function bps(part, whole) {
  if (whole === 0n) return null
  return Number(part * 1_000_000n / whole) / 100
}

/** Distance of a candidate price from the reference in basis points; positive means worse for the order. */
export function priceOffsetBps(zeroForOne, priceX96, referenceX96) {
  const d = zeroForOne ? referenceX96 - priceX96 : priceX96 - referenceX96
  return bps(d, referenceX96)
}

/**
 * Classify one solver CLI invocation. The CLI exits 0 only after a successful receipt. Failure text comes
 * from packages/solver/solver.mjs and external.mjs; anything unrecognised is kept as 'other-failure'.
 */
export function classifyCli({ code, stdout = '', stderr = '' }) {
  if (code === 0) return /settled batch \d+: .* tx 0x[0-9a-fA-F]{64}/.test(stdout) ? 'settled' : 'exit0-without-settlement'
  if (code === null) return 'killed'
  const e = stderr
  if (/solver: .*\(RPC_URL/.test(e)) return 'rpc-failure'
  if (/function "referencePriceX96" reverted/.test(e)) return 'reference-rejected' // market fail-closed before any search
  if (/search found no executable candidate|no price fills everyone/.test(e)) return 'search-exhausted'
  if (/candidate became stale/.test(e)) return 'stale-candidate'
  if (/deadline reached/.test(e)) return 'deadline'
  if (/simulation budget exhausted/.test(e)) return 'search-budget'
  if (/settle tx 0x[0-9a-fA-F]{64} reverted/.test(e)) return 'settlement-reverted'
  if (/HTTP request failed|fetch failed|ECONNREFUSED|timed out|took too long to respond|Archive|403/i.test(e)) return 'rpc-failure'
  return 'other-failure'
}

/**
 * Attacker accounting for a same-pool round trip: front sells `frontIn` of the victim's input token, the back-run
 * sells exactly the intermediate amount received, and `backOut` is the input token returned. Gas is valued at the
 * given base fee (no priority fee or builder payment). `ethToInput(wei)` converts wei to input-token raw units.
 */
export function attackAccounting({ frontIn, backOut, gasUnits, baseFeeWei, ethToInput }) {
  const gross = backOut - frontIn
  const gasWei = gasUnits * baseFeeWei
  const gasInInput = ethToInput(gasWei)
  return { grossProfitInput: gross, gasUnits, gasWei, gasCostInput: gasInInput, netBeforeBuilderInput: gross - gasInInput }
}

/** Wei -> raw token units at a token1/token0 Q96 price, where WETH is token1 and the other token is token0. */
export function weiToToken0(wei, priceX96) {
  return wei * Q96 / priceX96
}

/** Summarise scenario rows into counts the report quotes; rows are produced by the runner. */
export function summarise(rows) {
  const out = {}
  for (const r of rows) {
    const k = `${r.caseId}/${r.mode}`
    const s = (out[k] ??= { scenarios: 0, outcomes: {}, profitableGross: 0, profitableNetBeforeBuilder: 0, maxGrossProfitInput: null, maxVictimLossBps: null })
    s.scenarios++
    s.outcomes[r.outcome] = (s.outcomes[r.outcome] ?? 0) + 1
    if (r.attacker) {
      if (r.attacker.grossProfitInput > 0n) s.profitableGross++
      if (r.attacker.netBeforeBuilderInput > 0n) s.profitableNetBeforeBuilder++
      if (s.maxGrossProfitInput === null || r.attacker.grossProfitInput > s.maxGrossProfitInput) s.maxGrossProfitInput = r.attacker.grossProfitInput
    }
    if (r.victimLossBps != null && (s.maxVictimLossBps === null || r.victimLossBps > s.maxVictimLossBps)) s.maxVictimLossBps = r.victimLossBps
  }
  return out
}
