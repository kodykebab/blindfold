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

test('court ledger skips the registry events it does not show instead of going unavailable', async () => {
  const { decodeCourtLogs, courtRows } = await import('./court-view.mjs')
  const { decodeEventLog, encodeAbiParameters, encodeEventTopics, parseAbiItem } = await import('../../packages/client/node_modules/viem/_esm/index.js')
  const log = (signature, args, data) => ({ topics: encodeEventTopics({ abi: [parseAbiItem(signature)], args }), data })
  const rpc = '0x00000000000000000000000000000000000000a1'
  const logs = [
    log('event IncidentOpened(bytes32 indexed incident, uint256 budget, uint64 closesAt)', { incident: `0x${'11'.repeat(32)}` }, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint64' }], [5n, 9n])),
    log('event Bonded(address indexed rpc, uint256 amount, uint256 total)', { rpc }, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [7n, 7n])),
    log('event Unbonded(address indexed rpc, uint256 amount)', { rpc }, encodeAbiParameters([{ type: 'uint256' }], [7n])),
  ]
  const rows = courtRows(decodeCourtLogs(logs, decodeEventLog))
  assert.equal(rows.length, 1)
  assert.match(rows[0], /^Bond 0x0+a1: 7 \(total 7\)$/i)
})
