import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStatus, jobStage, preparedBatch, parseTrack, parseBlockers } from './status.mjs'

test('status report preserves actual balances, batch and deadlines', () => {
  const value = parseStatus(`account 0x1111111111111111111111111111111111111111\nnetwork 31337\npair TKA / TKB\n  TKA    wallet 100 TKA | available 5 TKA | reserved 10 TKA | withdrawable 0 TKA\n  TKB    wallet 2 TKB | available 1 TKB | reserved 0 TKB | withdrawable 0 TKB\n  open commitments: 1 (withdrawals blocked)\nbatch 7 (chain time 1234)\n    20s commits close\n    -4s reveal opens\npreparation: prepared for batch 8\n`)
  assert.equal(value.account, '0x1111111111111111111111111111111111111111')
  assert.equal(value.network, 'network 31337')
  assert.equal(value.pair, 'pair TKA / TKB')
  assert.equal(value.rows[0].reserved, '10 TKA')
  assert.equal(value.rows[1].withdrawable, '0 TKB')
  assert.equal(value.batch, 'batch 7 (chain time 1234)')
  assert.equal(value.preparation, 'preparation: prepared for batch 8')
  assert.deepEqual(value.deadlines, ['20s commits close', '-4s reveal opens'])
})
test('incomplete or error output is not presented as a successful status', () => {
  assert.equal(parseStatus('client: deployment is missing'), null)
  assert.equal(parseStatus('account 0x1111111111111111111111111111111111111111\nbatch 0 (chain time 0)'), null)
})

test('progress labels only follow actual CLI output', () => {
  assert.equal(jobStage({ action: 'commit', output: 'order: sell' }), 'RUNNING')
  assert.equal(jobStage({ action: 'commit', output: 'generating the online admission proof locally…' }), 'PROVING')
  assert.equal(jobStage({ action: 'commit', output: 'local proving completed in 90s' }), 'FINALIZING')
  assert.equal(jobStage({ action: 'prepare-admission', output: 'preparing locally for batch 2' }), 'PREPARING')
})

test('prepared badge only uses an actual successful CLI preparation message', () => {
  assert.equal(preparedBatch('preparing locally for batch 4…'), null)
  assert.equal(preparedBatch('prepared batch 4 in 100.0s; private preparation saved locally'), '4')
})

test('tracking displays reported states and distinguishes explicitly reported partial fills', () => {
  const rows = parseTrack('#0 batch 2: committed (sealed)\n#1 batch 2: filled (sell 10) → got 3 TKB [partial fill: 4 TKA of 10 TKA]')
  assert.equal(rows[0].state, 'committed')
  assert.equal(rows[1].state, 'partially filled')
  assert.match(rows[1].detail, /4 TKA of 10 TKA/)
  assert.deepEqual(parseTrack('no commitments'), [])
  assert.equal(parseTrack('unrecognized result'), null)
})

test('withdrawal blockers preserve the actual action and policy explanation', () => {
  const rows = parseBlockers('#7 batch 2 (committed): wait 12s — sealed until its drand round\n#8 batch 2 (revealed): expire — nobody settled the batch')
  assert.equal(rows[0].action, 'wait 12s')
  assert.equal(rows[1].action, 'expire')
  assert.deepEqual(parseBlockers('nothing blocks withdrawal'), [])
  assert.equal(parseBlockers('unknown output'), null)
})
