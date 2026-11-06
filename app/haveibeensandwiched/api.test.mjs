import { test } from 'node:test'
import assert from 'node:assert/strict'
import handler from './api/check.js'
import { FIXTURES } from './check.mjs'

// A stand-in for Vercel's response helpers: status(), json(), setHeader().
function fakeRes() {
  const res = { code: null, body: null, headers: {} }
  res.status = (c) => { res.code = c; return res }
  res.json = (b) => { res.body = b; return res }
  res.setHeader = (k, v) => { res.headers[k] = v }
  return res
}

test('the Vercel function answers like server.mjs and lets the CDN cache good answers', async () => {
  process.env.OFFLINE = '1'
  const addr = Object.keys(FIXTURES).find((k) => k.length === 42)
  const ok = fakeRes()
  await handler({ query: { q: addr } }, ok)
  assert.equal(ok.code, 200)
  assert.ok(ok.body.sandwichCount > 0)
  assert.match(ok.headers['Cache-Control'], /s-maxage=300/)

  const bad = fakeRes()
  await handler({ query: { q: 'not-a-hash' } }, bad)
  assert.equal(bad.code, 200)
  assert.match(bad.body.error, /0x tx hash/)
  assert.equal(bad.headers['Cache-Control'], undefined) // errors aren't cached
  delete process.env.OFFLINE
})
