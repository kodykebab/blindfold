// node --test contracts/test/solver-sandwich-lib.test.mjs (offline)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Q96, quoteOut, bps, priceOffsetBps, classifyCli, attackAccounting, weiToToken0, summarise } from './solver-sandwich-lib.mjs'

test('quoteOut matches the settlement rounding in both directions', () => {
  assert.equal(quoteOut(true, 10n, Q96 * 3n), 30n)
  assert.equal(quoteOut(false, 10n, Q96 * 3n), 3n) // floor(10/3)
  assert.throws(() => quoteOut(true, 1n, 0n))
})

test('bps and price offsets are signed toward the order being worse off', () => {
  assert.equal(bps(1n, 10_000n), 1)
  assert.equal(bps(-25n, 1_000_000n), -0.25)
  assert.equal(bps(1n, 0n), null)
  const ref = Q96 * 1000n
  assert.equal(priceOffsetBps(true, ref - ref / 100n, ref), 100) // lower token1/token0 hurts a token0 seller
  assert.equal(priceOffsetBps(false, ref + ref / 100n, ref), 100) // higher hurts a token1 seller
  assert.equal(priceOffsetBps(false, ref - ref / 100n, ref), -100)
})

test('classifyCli separates RPC, search, stale, deadline and on-chain failures', () => {
  const tx = '0x' + 'ab'.repeat(32)
  assert.equal(classifyCli({ code: 0, stdout: `settled batch 0: 1 orders at 1 token1/token0, public-pool residual route, tx ${tx}\n` }), 'settled')
  assert.equal(classifyCli({ code: 0, stdout: '' }), 'exit0-without-settlement')
  assert.equal(classifyCli({ code: 1, stderr: 'solver: HTTP request failed (RPC_URL http://x)' }), 'rpc-failure')
  assert.equal(classifyCli({ code: 1, stderr: 'batch 0: search found no executable candidate; this does not prove infeasibility' }), 'search-exhausted')
  assert.equal(classifyCli({ code: 1, stderr: 'batch 0: candidate became stale; retry on next poll' }), 'stale-candidate')
  assert.equal(classifyCli({ code: 1, stderr: 'external search deadline reached' }), 'deadline')
  assert.equal(classifyCli({ code: 1, stderr: 'external search simulation budget exhausted' }), 'search-budget')
  assert.equal(classifyCli({ code: 1, stderr: `batch 0: settle tx ${tx} reverted` }), 'settlement-reverted')
  assert.equal(classifyCli({ code: 1, stderr: 'something new' }), 'other-failure')
  assert.equal(classifyCli({ code: 1, stderr: 'The request took too long to respond.' }), 'rpc-failure')
  assert.equal(classifyCli({ code: 1, stderr: 'The contract function "referencePriceX96" reverted with the following signature:\n0x94e8dec3' }), 'reference-rejected')
  assert.equal(classifyCli({ code: null }), 'killed')
})

test('attack accounting separates gross profit from gas at base fee', () => {
  const a = attackAccounting({ frontIn: 1000n, backOut: 1100n, gasUnits: 200_000n, baseFeeWei: 10n, ethToInput: (w) => w / 100_000n })
  assert.deepEqual(a, { grossProfitInput: 100n, gasUnits: 200_000n, gasWei: 2_000_000n, gasCostInput: 20n, netBeforeBuilderInput: 80n })
  const loss = attackAccounting({ frontIn: 1000n, backOut: 990n, gasUnits: 0n, baseFeeWei: 1n, ethToInput: (w) => w })
  assert.equal(loss.grossProfitInput, -10n)
  assert.equal(weiToToken0(10n ** 18n, Q96 * 2n), 5n * 10n ** 17n)
})

test('summarise counts outcomes and profitable rows per case and mode', () => {
  const rows = [
    { caseId: 'c', mode: 'm', outcome: 'settled', attacker: { grossProfitInput: 5n, netBeforeBuilderInput: -1n }, victimLossBps: 3 },
    { caseId: 'c', mode: 'm', outcome: 'settlement-reverted', attacker: { grossProfitInput: -2n, netBeforeBuilderInput: -3n }, victimLossBps: null },
  ]
  const s = summarise(rows)['c/m']
  assert.equal(s.scenarios, 2)
  assert.deepEqual(s.outcomes, { settled: 1, 'settlement-reverted': 1 })
  assert.equal(s.profitableGross, 1)
  assert.equal(s.profitableNetBeforeBuilder, 0)
  assert.equal(s.maxGrossProfitInput, 5n)
  assert.equal(s.maxVictimLossBps, 3)
})
