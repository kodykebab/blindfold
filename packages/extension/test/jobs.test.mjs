import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clearExports } from '../src/jobs.mjs'

test('unread exports are discarded without removing the unlock key, send journal or other jobs', async () => {
  const records = { key: 'session-key', 'send:1': { record: {} }, 'job:1': { op: 'export', result: 'secret salt' }, 'job:2': { op: 'track', state: 'done' }, 'job:3': { op: 'export', state: 'running' } }
  const session = { get: async () => structuredClone(records), remove: async (keys) => keys.forEach((key) => delete records[key]) }
  await clearExports(session)
  assert.deepEqual(Object.keys(records), ['key', 'send:1', 'job:2'])
  await clearExports(session)
  assert.equal(records.key, 'session-key')
})
