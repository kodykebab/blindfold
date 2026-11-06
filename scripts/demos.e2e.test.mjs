// The two demos as tests: Court's coverage → claim → collection, and three users through one batch.
// Opt-in (each starts its own anvil): DEMO_E2E=1 node --test scripts/demos.e2e.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const enabled = process.env.DEMO_E2E === '1'
const root = fileURLToPath(new URL('../', import.meta.url))
const run = (script) => new Promise((resolve) => execFile('bash', [script], { cwd: root, env: process.env, timeout: 600_000, maxBuffer: 1 << 26 },
  (e, out, err) => resolve({ code: e ? e.code ?? 'TIMEOUT' : 0, out, err })))

test('Court demo: a sandwiched victim claims from the RPC bond and is paid', { skip: !enabled, timeout: 660_000 }, async () => {
  const r = await run('scripts/court-demo.sh')
  assert.equal(r.code, 0, (r.out + r.err).slice(-3000))
  assert.match(r.out, /PASS {2}beneficiary 0x[0-9a-fA-F]{40} paid [\d.]+ ETH/)
})

test('multi-user demo: three accounts commit, the keeper reveals, the solver settles, all withdraw', { skip: !enabled, timeout: 660_000 }, async () => {
  const r = await run('scripts/demo-multi.sh')
  assert.equal(r.code, 0, (r.out + r.err).slice(-3000))
  assert.match(r.out, /== done/)
  assert.doesNotMatch(r.out + r.err, /FAIL/)
})
