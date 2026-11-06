import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

async function freePort() {
  const s = createServer()
  s.listen(0, '127.0.0.1'); await once(s, 'listening')
  const port = s.address().port
  await new Promise((resolve) => s.close(resolve))
  return port
}
test('local server serves the page and rejects cross-origin commands', async () => {
  const port = await freePort(), base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('.', import.meta.url), env: { ...process.env, PORT: String(port), OFFLINE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(([code]) => { throw Error(`server exited ${code}`) })])
    const landing = await fetch(`${base}/`)
    assert.match(await landing.text(), /href="\/trade"/)
    const trade = await fetch(`${base}/trade`)
    assert.equal(trade.status, 200)
    assert.equal(trade.headers.get('x-frame-options'), 'DENY', 'the trading page can never be framed')
    assert.match(trade.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
    const reject = await fetch(`${base}/api/trade`, { method: 'POST', headers: { origin: 'https://example.com', 'content-type': 'application/json', 'x-blindfold-request': '1' }, body: JSON.stringify({ action: 'status' }) })
    assert.equal(reject.status, 403)
    const bad = await fetch(`${base}/api/trade`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-blindfold-request': '1' }, body: JSON.stringify({ action: 'arbitrary-command' }) })
    assert.equal(bad.status, 400)
  } finally { child.kill(); await once(child, 'exit') }
})
