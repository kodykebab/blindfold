import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadHistory } from './history.mjs'
import { courtRows, loadCourt } from './court-view.mjs'

test('history stays unavailable when Arkiv is down, without throwing', async () => {
  const history = await loadHistory({ ARKIV: 'testnet' })
  assert.equal(history.unavailable, true)
  assert.equal(history.message, 'history unavailable')
  assert.deepEqual(history.batches, [])
})

test('an in-memory Arkiv still answers with an empty public history', async () => {
  const history = await loadHistory({ ARKIV: 'off' })
  assert.equal(history.unavailable, false)
  assert.deepEqual(history.batches, [])
})

test('court stays hidden when no deployment is configured', async () => {
  const court = await loadCourt({ COURT_DEPLOYMENT: '/tmp/blindfold-no-court.json' })
  assert.equal(court.hidden, true)
})

test('court rows list bonds, claims and payouts only', () => {
  const rows = courtRows([
    { event: 'Bonded', args: { rpc: '0x1', amount: '10', total: '10' } },
    { event: 'ClaimRegistered', args: { txHash: '0xabc', weight: '4', beneficiary: '0x2' } },
    { event: 'Collected', args: { txHash: '0xabc', payout: '4', beneficiary: '0x2' } },
    { event: 'Committed', args: { ciphertext: 'secret' } },
  ])
  assert.equal(rows.length, 3)
  assert.match(rows[0], /Bond/)
  assert.match(rows[2], /Payout/)
})
