import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createJobStore } from './job-store.mjs'

test('an opaque in-flight job can be recovered by a new page and is cleared on completion', () => {
  const data = new Map()
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }
  const first = createJobStore(storage); first.set('local-job-id')
  const reopened = createJobStore(storage)
  assert.equal(reopened.get(), 'local-job-id')
  assert.deepEqual([...data.values()], ['local-job-id'])
  reopened.set(null); assert.equal(first.get(), null)
})
test('unavailable browser storage does not crash the page', () => {
  const broken = { getItem() { throw Error('blocked') }, setItem() { throw Error('blocked') }, removeItem() { throw Error('blocked') } }
  const store = createJobStore(broken)
  assert.equal(store.get(), null); assert.doesNotThrow(() => store.set('id'))
})

test('backup reminder remains visible after reopening until an export clears it', async () => {
  const { createBackupReminder } = await import('./job-store.mjs')
  const data = new Map()
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }
  createBackupReminder(storage).set(true)
  const reopened = createBackupReminder(storage)
  assert.equal(reopened.get(), true)
  reopened.set(false)
  assert.equal(createBackupReminder(storage).get(), false)
})
