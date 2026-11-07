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
    // status can say which batch used it; like the key, that and the in-progress marker stay on this device
    assert.deepEqual(loadState(dep, owner).consumedPreparation, { batch: '1', round: '1000' })
    writeState(dep, owner, { ...loadState(dep, owner), preparing: { batch: '2', round: '1001', pid: 1 } })
    const later = JSON.parse(exportState(dep, owner))
    assert.equal(later.consumedPreparation, undefined)
    assert.equal(later.preparing, undefined)
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

test('the proving margin follows this device once it has three measurements', async () => {
  const { admissionLead, recordProving } = await import('../admission.mjs')
  const state = {}
  for (const s of [40, 47.3, 44]) recordProving(state, 'online', s)
  // 1.25 x the slowest (47.3 s -> 60 s) plus 15 s for inclusion
  assert.equal(admissionLead(true, {}, state.proving), 75n)
  assert.equal(admissionLead(false, {}, state.proving), 180n, 'inline still has no measurements')
  assert.equal(admissionLead(true, { ADMISSION_INCLUSION_SECONDS: '30' }, state.proving), 90n)
  assert.equal(admissionLead(true, { ADMISSION_MIN_LEAD_SECONDS: '200' }, state.proving), 200n, 'an explicit margin wins')
  const fast = {}
  for (const s of [2, 3, 2]) recordProving(fast, 'online', s)
  assert.equal(admissionLead(true, {}, fast.proving), 30n, 'never under 30 s')
  // a slow attempt raises the margin, and only the last five samples count
  recordProving(state, 'online', 90)
  assert.equal(admissionLead(true, {}, state.proving), 128n)
  for (const s of [40, 40, 40, 40, 40]) recordProving(state, 'online', s)
  assert.deepEqual(state.proving.online, [40, 40, 40, 40, 40])
  for (const bad of [0, -1, NaN, Infinity]) recordProving(state, 'online', bad)
  assert.equal(state.proving.online.length, 5)
  assert.throws(() => admissionLead(true, { ADMISSION_INCLUSION_SECONDS: '0' }, state.proving), /positive uint64/)
})

test('an order goes into the current batch when it can still be proved there, else into the next', async () => {
  const { targetBatch } = await import('../admission.mjs')
  const lead = { online: 75n, inline: 180n }
  const at = (now, preparedBatch, batchLength = 300n) => targetBatch({ current: 4n, commitsClose: 300n, batchLength, now, preparedBatch, lead })
  assert.deepEqual(at(100n, undefined), { batch: 4n, prepared: false, close: 300n }) // 200 s left: inline fits
  assert.deepEqual(at(200n, 4n), { batch: 4n, prepared: true, close: 300n }) // 100 s: only the prepared proof fits
  assert.deepEqual(at(200n, undefined), { batch: 5n, prepared: false, close: 600n }) // 100 s, no key: roll over
  assert.deepEqual(at(250n, 5n), { batch: 5n, prepared: true, close: 600n }) // the next batch's key serves it
  assert.deepEqual(at(240n, 4n), { batch: 5n, prepared: false, close: 600n }) // 60 s is too little even prepared
  assert.equal(at(250n, undefined, 60n), null) // 60 s batches: 110 s to the next close is too little inline
  assert.deepEqual(at(250n, 5n, 60n), { batch: 5n, prepared: true, close: 360n }) // ...but a prepared key makes it
  // viem returns uint32 reads (batchLength) as numbers
  assert.deepEqual(targetBatch({ current: 4n, commitsClose: 300n, batchLength: 300, now: 200n, preparedBatch: '5', lead }), { batch: 5n, prepared: true, close: 600n })
})

test('preflight accepts the next batch for an order proved ahead, never a later one', async () => {
  const { preflight } = await import('../flow.mjs')
  const input = { order: { amountIn: 1n, minAmountOut: 1n }, tokenIn: 'a', depositToken: 'a', depositAmount: 0n, fee: 0n, free: { a: 1n }, wallet: { a: 0n }, allowance: { a: 0n } }
  const batch = (id) => ({ id, current: 4n, commitsClose: 360n, now: 250n, commits: 0n, maxCommits: 64n })
  assert.equal(preflight({ ...input, batch: batch(5n), minLead: 75n }).ok, true)
  assert.match(preflight({ ...input, batch: batch(6n), minLead: 75n }).problems.join(), /not open/)
  assert.match(preflight({ ...input, batch: batch(5n), minLead: 75n, openBatches: [4n] }).problems.join(), /one active batch/)
})
