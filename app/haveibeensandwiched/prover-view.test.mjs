import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backupReminder, identityChanged, importProblems, preparationPanel, provedSeconds, proverSteps, reminderNeedsExport } from './prover-view.mjs'

// Real client output (fresh-proof stack run), cut at each point a running job can be observed.
const ORDER = 'order: sell 10 TKB for at least 9 TKA in batch 1\ncosts: deposit 5 TKA (returned minus the revealer\'s bounty when revealed), fee 0.000000000000000001 TKA\n'
const PROVING = `${ORDER}generating the online admission proof locally…\n`
const PROVED = `${PROVING}local proving completed in 50.72s\n`
const ADMITTED = `${PROVED}admitted #0 in 0x${'ab'.repeat(32)}\n`
const status = (job) => proverSteps(job, { now: 70_000 }).steps.map((s) => `${s.name}:${s.status}`).join(' ')

test('admission commit: each output line moves exactly one step', () => {
  assert.equal(status({ action: 'commit', state: 'running', output: '' }), 'Encrypt:current Prove:waiting Submit:waiting Included:waiting')
  assert.equal(status({ action: 'commit', state: 'running', output: PROVING }), 'Encrypt:done Prove:current Submit:waiting Included:waiting')
  assert.equal(status({ action: 'commit', state: 'running', output: PROVED }), 'Encrypt:done Prove:done Submit:current Included:waiting')
  assert.equal(status({ action: 'commit', state: 'done', output: ADMITTED }), 'Encrypt:done Prove:done Submit:done Included:done')
})

test('plain commit (admission off) completes without a proving line', () => {
  const out = `${ORDER}committed #3 to round 1000000 in 0x${'cd'.repeat(32)}\n`
  assert.equal(status({ action: 'commit', state: 'done', output: out }), 'Encrypt:done Prove:done Submit:done Included:done')
})

test('a failed proof marks the current step failed, not done', () => {
  assert.equal(status({ action: 'commit', state: 'failed', output: `${PROVING}client: local prover failed (1)` }), 'Encrypt:done Prove:failed Submit:waiting Included:waiting')
})

test('elapsed time and the machine\'s usual proving time appear on the current proving step', () => {
  const view = proverSteps({ action: 'commit', state: 'running', output: PROVING, startedAt: 10_000 }, { now: 70_000, typicalSeconds: 51 })
  assert.equal(view.steps[1].detail, '60s so far, usually about 51s on this machine')
})

test('preparation progress and timing', () => {
  assert.equal(status({ action: 'prepare-admission', state: 'running', output: 'preparing locally for batch 4, round 1000040…\n' }), 'Prepare:current Saved:waiting')
  const done = 'preparing locally for batch 4, round 1000040…\nprepared batch 4 in 103.40s; private preparation saved locally\n'
  assert.equal(status({ action: 'prepare-admission', state: 'done', output: done }), 'Prepare:done Saved:done')
  assert.equal(provedSeconds(done), 103)
  assert.equal(provedSeconds(PROVED), 51)
  assert.equal(provedSeconds(ORDER), null)
  assert.equal(proverSteps({ action: 'status', state: 'done', output: '' }), null)
})

test('preparation panel: every status line the client prints', () => {
  assert.deepEqual(preparationPanel('', '3'), { state: 'off', text: 'Preparation is not required by this deployment.', action: null })
  assert.deepEqual(preparationPanel('preparation: none', '3').action, { label: 'Prepare for batch 4', batch: '4' })
  assert.equal(preparationPanel('preparation: prepared for batch 3', '3').state, 'ready')
  assert.equal(preparationPanel('preparation: prepared for batch 3', '3').action, null)
  assert.equal(preparationPanel('preparation: expired for batch 2', '3').state, 'stale')
  assert.equal(preparationPanel('preparation: prepared for batch 2', '3').state, 'stale', 'a past batch is stale even if not yet marked expired')
  assert.equal(preparationPanel('preparation: invalid for this account, network or deployment', '3').state, 'invalid')
  assert.equal(preparationPanel('preparation: local state unreadable; restore a backup', '3').state, 'unreadable')
  assert.equal(preparationPanel('preparation: none', null).action, null, 'no batch known: no prepare button')
})

test('identity change between status reads', () => {
  const a = { account: '0xA', network: '31337', pair: 'TKA / TKB' }
  assert.equal(identityChanged(a, { ...a, account: '0xa' }), false, 'case does not matter')
  assert.equal(identityChanged(a, { ...a, network: '1' }), true)
  assert.equal(identityChanged(a, { ...a, pair: 'TKB / TKA' }), true)
  assert.equal(identityChanged(null, a), false)
})

test('backup refusals: each problem the client reports gets its own sentence', () => {
  const refuse = (lines) => `client: refusing to import [private temporary file]:\n  ${lines.join('\n  ')}`
  const kinds = (out) => importProblems(out).map((p) => p.kind)
  assert.deepEqual(kinds(refuse(['state is for another chain or settlement'])), ['foreign'])
  assert.deepEqual(kinds(refuse(['state belongs to 0x00000000000000000000000000000000000000a1'])), ['foreign'])
  assert.deepEqual(kinds(refuse([`commitment 0x${'11'.repeat(32)}: order and salt do not hash to it`])), ['tampered'])
  assert.deepEqual(kinds(refuse([`commitment #0: chain has 0x${'22'.repeat(32)} (stale or foreign state)`])), ['stale'])
  assert.deepEqual(kinds(refuse(['state belongs to 0x1', 'commitment 0x2: order and salt do not hash to it'])), ['foreign', 'tampered'])
  assert.deepEqual(kinds('Backup must be a JSON object'), ['unreadable'])
  assert.deepEqual(kinds('imported; 1 commitment(s) saved'), [])
})

test('backup reminder clears only after an export that follows the last submission, then a confirmation', () => {
  let s = backupReminder(null, 'submitted', 100)
  assert.equal(reminderNeedsExport(s), true)
  s = backupReminder(s, 'acknowledged', 110)
  assert.equal(s.pending, true, 'confirming without exporting does nothing')
  s = backupReminder(s, 'exported', 120)
  assert.equal(reminderNeedsExport(s), false)
  s = backupReminder(s, 'submitted', 130)
  assert.equal(reminderNeedsExport(s), true, 'a new order needs a new backup')
  s = backupReminder(backupReminder(s, 'exported', 140), 'acknowledged', 150)
  assert.equal(s.pending, false)
})

test('preparation panel accepts the current CLI status lifecycle', async () => {
  const { preparationStatus } = await import('../../packages/client/quote.mjs')
  const view = (state) => preparationPanel(preparationStatus({ current: 2n, running: () => true, ...state }), '2')
  assert.equal(view({}).state, 'none')
  assert.equal(view({ consumed: { batch: '2' } }).state, 'none')
  assert.equal(view({ preparation: { batch: '3', round: '100' } }).state, 'ready')
  assert.equal(view({ preparation: { batch: '1', round: '100' } }).state, 'stale')
  assert.equal(view({ preparing: { batch: '3', round: '100', pid: 1 } }).state, 'preparing')
})
