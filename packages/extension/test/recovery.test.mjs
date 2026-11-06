import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recovery } from '../src/recovery.mjs'

function area(initial = {}) {
  const data = structuredClone(initial)
  return { data, async get(k) { return k == null ? structuredClone(data) : { [k]: structuredClone(data[k]) } },
    async set(obj) { Object.assign(data, structuredClone(obj)) }, async remove(key) { delete data[key] } }
}
const entry = { record: { kind: 'admit', hash: 'order' }, owner: 'original', settlement: 'settlement', dep: { chainId: 31337 } }
const tx = `0x${'ab'.repeat(32)}`

test('a replayed result waits for the prior sent hash to become durable', async () => {
  const session = area({ 'send:1': entry })
  let release, started
  const running = new Promise((r) => { started = r })
  const gate = new Promise((r) => { release = r })
  const saved = []
  const r = recovery({ session, save: async (e, hash) => { started(); await gate; saved.push([e.owner, hash]) } })
  const sent = r.handle({ type: 'sent', id: '1', hash: tx })
  await running
  const result = r.handle({ type: 'result', id: '1', ok: true, hashes: [tx] })
  assert.equal(session.data['send:1'].hash, tx)
  assert.equal(session.data['send:1'].done, undefined)
  release()
  await Promise.all([sent, result])
  assert.deepEqual(saved, [['original', tx]])
  assert.equal(session.data['send:1'], undefined)
})

test('locked recovery retains the completed send and retries against its original account after unlock', async () => {
  const session = area({ 'send:1': entry })
  let unlocked = false
  const saved = []
  const r = recovery({ session, save: async (e, hash) => { if (!unlocked) throw Error('locked'); saved.push([e.owner, e.dep.chainId, hash]) } })
  await r.handle({ type: 'sent', id: '1', hash: tx })
  await r.handle({ type: 'result', id: '1', ok: true, hashes: [tx] })
  assert.deepEqual([session.data['send:1'].hash, session.data['send:1'].done], [tx, true])
  unlocked = true
  await r.drain()
  assert.deepEqual(saved, [['original', 31337, tx]])
  assert.equal(session.data['send:1'], undefined)
})

test('a result without a replayed sent event still persists its transaction hash', async () => {
  const session = area({ 'send:1': entry })
  const saved = []
  const r = recovery({ session, save: async (_, hash) => saved.push(hash) })
  await r.handle({ type: 'result', id: '1', ok: false, hashes: [tx] })
  assert.deepEqual(saved, [tx])
  assert.equal(session.data['send:1'], undefined)
})

test('a finished rejected request with no transaction clears its journal', async () => {
  const session = area({ 'send:1': entry })
  const r = recovery({ session, save: async () => assert.fail('nothing to save') })
  await r.handle({ type: 'result', id: '1', ok: false, hashes: [] })
  assert.equal(session.data['send:1'], undefined)
})
