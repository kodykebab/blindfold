// Native-messaging client: request/response by id, errors with codes, disconnects, idle close.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { helper } from '../src/helper.mjs'
import { fakePort } from './port.mjs'

test('calls are matched by id on one port until close()', async () => {
  const ports = []
  const h = helper(() => { const p = fakePort(); ports.push(p); return p })
  const a = h.call('hello'), b = h.call('prove', { manifestSha256: 'ab', request: { batch: '3' } })
  assert.equal(ports.length, 1)
  const [ma, mb] = ports[0].posted
  assert.deepEqual(mb, { id: mb.id, cmd: 'prove', manifestSha256: 'ab', request: { batch: '3' } })
  ports[0].emit({ id: mb.id, ok: true, result: { proof: 1 } })
  ports[0].emit({ id: ma.id, ok: false, error: { code: 'PARAMS', message: 'manifest mismatch' } })
  assert.deepEqual(await b, { proof: 1 })
  await assert.rejects(a, (e) => e.code === 'PARAMS' && /manifest mismatch/.test(e.message))
  assert.ok(!ports[0].disconnected) // prepare and online share the helper process
  const c = h.call('online')
  h.close()
  assert.ok(ports[0].disconnected)
  await assert.rejects(c, /closed/)
  const reopened = h.call('hello')
  assert.equal(ports.length, 2) // reopened on demand
  ports[1].emit({ id: ports[1].posted[0].id, ok: true, result: { protocol: 1 } })
  assert.deepEqual(await reopened, { protocol: 1 })
  h.close()
})

test('a host that exits rejects every pending call with install advice', async () => {
  const p = fakePort()
  const h = helper(() => p)
  const a = h.call('prove')
  p.drop()
  await assert.rejects(a, /prover helper disconnected.*install\.sh/)
})

test('an unresponsive native host times out and is disconnected', async () => {
  const p = fakePort()
  const h = helper(() => p, { hello: 10 })
  await assert.rejects(h.call('hello'), (e) => e.code === 'E_TIMEOUT' && /timed out during hello/.test(e.message))
  assert.equal(p.disconnected, true)
})
