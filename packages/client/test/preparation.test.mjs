import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { consumePreparation, validatePreparation } from '../admission.mjs'
import { exportState, importState, loadState, writeState } from '../state.mjs'

const dep = { chainId: 31337, settlement: `0x${'11'.repeat(20)}`, admission: { manifestSha256: 'a'.repeat(64) } }
const owner = `0x${'22'.repeat(20)}`
const expected = { dep, owner, batch: 1n, round: 1000n }
function ready() {
  const context = { chainId: '31337', settlement: dep.settlement, owner, batch: '1', round: '1000' }
  return { version: 1, manifestSha256: dep.admission.manifestSha256, ...context, preparation: context, proof: { seal: '0x1234', journal: '0xabcd' } }
}
test('preparation rejects account, network, deployment, batch, round and parameter changes before consumption', () => {
  for (const change of [
    { owner: `0x${'33'.repeat(20)}` }, { batch: 2n }, { round: 1001n },
    { dep: { ...dep, chainId: 1 } }, { dep: { ...dep, settlement: owner } },
    { dep: { ...dep, admission: { manifestSha256: 'b'.repeat(64) } } },
  ]) {
    const state = { preparation: ready() }
    assert.throws(() => consumePreparation(state, { ...expected, ...change }, () => assert.fail('must not write')), /preparation/)
    assert.ok(state.preparation)
  }
  const bad = ready(); bad.preparation = { ...bad.preparation, round: '1001' }
  assert.throws(() => validatePreparation(bad, expected), /round changed/)
})
test('consumption survives interruption and repeated calls; exports cannot resurrect a prepared key', () => {
  const old = process.env.CLIENT_STATE
  process.env.CLIENT_STATE = mkdtempSync(join(tmpdir(), 'blindfold-preparation-'))
  try {
    const state = loadState(dep, owner); state.preparation = ready(); writeState(dep, owner, state)
    const backup = JSON.parse(exportState(dep, owner))
    assert.equal(backup.preparation, undefined)
    const taken = consumePreparation(loadState(dep, owner), expected, (s) => writeState(dep, owner, s))
    assert.ok(taken)
    // Simulated process death immediately after consumption, before online proving produces anything.
    assert.equal(loadState(dep, owner).preparation, undefined)
    assert.equal(consumePreparation(loadState(dep, owner), expected, () => assert.fail('nothing to consume')), undefined)
    importState(dep, owner, { ...backup, preparation: ready() })
    assert.equal(loadState(dep, owner).preparation, undefined)
  } finally {
    rmSync(process.env.CLIENT_STATE, { recursive: true, force: true })
    if (old === undefined) delete process.env.CLIENT_STATE; else process.env.CLIENT_STATE = old
  }
})
test('failed durable consumption does not return a key for encryption', () => {
  assert.throws(() => consumePreparation({ preparation: ready() }, expected, () => { throw new Error('disk full') }), /disk full/)
})

test('interrupted preparation does not return a reusable key or expose prover diagnostics', async () => {
  const { prepareAdmission } = await import('../admission.mjs')
  const { writeFileSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'blindfold-failed-prover-'))
  try {
    const executable = join(dir, 'prover')
    writeFileSync(executable, '#!/bin/sh\nprintf "private-witness-sentinel" >&2\nexit 137\n', { mode: 0o700 })
    await assert.rejects(prepareAdmission({ ...expected, env: { ADMISSION_PROVER: executable } }), (e) => {
      assert.match(e.message, /local prover failed/)
      assert.doesNotMatch(e.message, /private-witness-sentinel/)
      return true
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('desktop preflight budgets distinguish online-only and inline proving and reject invalid configuration', async () => {
  const { admissionLead } = await import('../admission.mjs')
  const { preflight } = await import('../flow.mjs')
  const input = { order: { amountIn: 1n, minAmountOut: 1n }, tokenIn: 'a', depositToken: 'a', depositAmount: 0n, fee: 0n, free: { a: 1n }, wallet: { a: 0n }, allowance: { a: 0n }, batch: { id: 1n, current: 1n, commitsClose: 300n, now: 150n, commits: 0n, maxCommits: 64n } }
  assert.equal(preflight({ ...input, minLead: admissionLead(true, {}) }).ok, true)
  assert.equal(preflight({ ...input, minLead: admissionLead(false, {}) }).ok, false)
  assert.equal(admissionLead(true, { ADMISSION_MIN_LEAD_SECONDS: '240' }), 240n)
  for (const value of ['0', '-1', 'NaN', '1.5', '18446744073709551616']) assert.throws(() => admissionLead(true, { ADMISSION_MIN_LEAD_SECONDS: value }), /positive uint64/)
})
