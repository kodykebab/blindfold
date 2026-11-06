// Tabulate /tmp/blindfold-solver-sandwich-results.json (offline): node contracts/test/solver-sandwich-report.mjs [results.json]
import { readFileSync } from 'node:fs'
const r = JSON.parse(readFileSync(process.argv[2] || '/tmp/blindfold-solver-sandwich-results.json'))
const B = (x) => (x == null ? '-' : BigInt(x))
const fmt = (x, d) => (x == null ? '-' : (Number(BigInt(x)) / 10 ** d).toFixed(d === 6 ? 2 : 6))
console.log(`fork ${r.fork.block} ${r.fork.hash} baseFee ${r.fork.baseFeePerGas} commit ${r.provenance.commit} dirty ${r.provenance.dirty.length} solverUnchanged ${r.provenance.solverUnchangedFromHead}`)
console.log(`controls: ${r.controls.map((c) => `${c.caseId}:${c.control}:${c.identicalCalldata ?? c.identicalFill ?? c.ok}`).join(' ')}`)
if (r.error) console.log('ERROR', r.error.message)
for (const c of r.cases) {
  const d = c.sell ? 18 : 6 // output decimals
  const di = c.sell ? 6 : 18
  console.log(`\n## ${c.id} amount ${fmt(c.amount, di)} limit ${c.limitBps ? c.limitBps + 'bps size-aware' : 'band edge'}; ready spot vs ref ${c.readySpotVsReferenceBps} bps`)
  if (!c.clean?.fill) { console.log(`  clean: ${c.clean?.outcome} ${c.clean?.stderr ?? ''}`); continue }
  console.log(`  clean: ${c.clean.simulations} sims, ${c.clean.call.fn}${c.clean.call.marginal ? ' marginal ' + c.clean.call.marginal.amountIn : ''}, price ${c.clean.priceOffsetBps} bps from ref, fill ${fmt(c.clean.fill.amountIn, di)} -> ${fmt(c.clean.fill.amountOut, d)}, floor slack ${c.clean.floorSlackBps} bps, gas ${c.clean.receipt.gasUsed}, wall ${c.clean.wallMs} ms`)
  const rows = r.rows.filter((x) => x.caseId === c.id)
  const modes = [...new Set(rows.map((x) => x.mode))]
  for (const m of modes) {
    const xs = rows.filter((x) => x.mode === m)
    const acc = xs.filter((x) => x.outcome === 'settled')
    console.log(`  ${m}: ${xs.length} rows; settled ${acc.length}; profitable gross ${acc.filter((x) => B(x.attacker.grossProfitInput) > 0n).length}; net-before-builder ${acc.filter((x) => B(x.attacker.netBeforeBuilderInput) > 0n).length}; outcomes ${JSON.stringify(xs.reduce((o, x) => ((o[x.outcome] = (o[x.outcome] ?? 0) + 1), o), {}))}`)
    for (const x of xs) console.log(`    front ${String(x.frontUnits).padStart(3)}u spot ${String(x.spotAfterFrontVsReferenceBps).padStart(7)} ${x.outcome.padEnd(19)} price ${String(x.settlement.priceOffsetBps ?? '-').padStart(6)} loss ${String(x.victimLossBps ?? '-').padStart(6)} bps vsRef ${String(x.outputVsReferenceBps ?? '-').padStart(6)} gross ${fmt(x.attacker.grossProfitInput, di)} net ${fmt(x.attacker.netBeforeBuilderInput, di)}${x.fill?.partial && BigInt(x.fill.amountIn) > 0n ? ' partial ' + fmt(x.fill.amountIn, di) : ''}${x.cli ? ` sims ${x.cli.simulations} ${x.cli.revertSelector?.name ?? ''}` : ''}`)
  }
  // identical-state comparison: band-edge settler vs CLI fresh search
  const fronts = [...new Set(rows.map((x) => x.frontUnits))]
  const diff = fronts.filter((f) => {
    const a = rows.find((x) => x.mode === 'band-edge-settler' && x.frontUnits === f), b = rows.find((x) => x.mode === 'search-after-front' && x.frontUnits === f)
    return a && b && (a.outcome !== b.outcome || a.fill?.amountOut !== b.fill?.amountOut)
  })
  console.log(`  band-edge vs CLI fresh search differ at fronts: ${diff.length ? diff.join(',') : 'none'}`)
}
