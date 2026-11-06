import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { command, createJobs } from './trading-server.mjs'

test('only structured supported commands and numeric amounts reach the CLI', () => {
  assert.deepEqual(command({ action: 'preflight', side: 'sell', amount: '1.2', minimum: '0.5' }), ['commit', 'sell', '1.2', '0.5', '--dry-run'])
  assert.deepEqual(command({ action: 'withdraw', token: 'token1', amount: 'all' }), ['withdraw', 'token1', 'all'])
  assert.throws(() => command({ action: 'commit', side: 'sell', amount: '1; echo bad', minimum: '1' }))
  assert.throws(() => command({ action: 'export-state', amount: '/tmp/a' }))
  assert.throws(() => command({ action: 'deposit', token: 'token0', amount: 'all' }))
})
test('jobs serialize, capture output and release the slot on completion', () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  let args
  const jobs = createJobs({ start: (a) => { args = a; return child } })
  const id = jobs.start({ action: 'status' })
  assert.deepEqual(args, ['status']); assert.equal(jobs.get(id).state, 'running')
  assert.throws(() => jobs.start({ action: 'track' }), /running/)
  child.stdout.write('account example'); child.emit('close', 0)
  assert.deepEqual(jobs.get(id), { state: 'done', output: 'account example' })
  assert.doesNotThrow(() => jobs.start({ action: 'track' }))
})
