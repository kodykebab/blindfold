import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serve } from '../server.mjs'

test('static server: page, module MIME type, CSP, and nothing outside public/', async () => {
  const server = await serve(0, '127.0.0.1')
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    let r = await fetch(`${base}/`)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), /^text\/html/)
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'.*frame-ancestors 'none'/)
    assert.match(await r.text(), /<script type="module" src="bridge.mjs">/)
    r = await fetch(`${base}/protocol.mjs`)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), /^text\/javascript/)
    for (const path of ['/../server.mjs', '/%2e%2e/server.mjs', '/..%2fserver.mjs', '/package.json', '/missing.mjs', '/test/protocol.test.mjs']) {
      assert.equal((await fetch(`${base}${path}`)).status, 404, path)
    }
    assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 404)
  } finally {
    server.close()
  }
})
