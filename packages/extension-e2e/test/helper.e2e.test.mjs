// INTERFACES.md "Extension <-> prover helper" through real Chrome native messaging from the real extension: install.sh
// registers the host in the test profile only (HOME is a temp dir, so no real browser is touched), with a stub
// local-prover and a stub parameter manifest. Covers the envelope, hello, and the error codes that need no proof.
// Real proofs are E3 (needs the real local-prover). EXT_E2E=1.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from '../lib/chain.mjs'
import { launch, stopBridge, EXTENSION_DIST, EXTENSION_ID } from '../lib/browser.mjs'
import { openApp } from '../lib/extension.mjs'
import { hasGo, installHelper, sha256File as sha } from '../lib/helper.mjs'

const skip = process.env.EXT_E2E !== '1' || (!existsSync(join(EXTENSION_DIST, 'manifest.json')) && 'no extension build')
  || (!existsSync(join(ROOT, 'packages/prover-helper/install.sh')) && 'no prover-helper') || (!hasGo && 'no go toolchain')
let dir, b, installed

before(async () => {
  if (skip) return
  dir = mkdtempSync(join(tmpdir(), 'blindfold-helper-e2e-'))
  const prover = join(dir, 'local-prover'), params = join(dir, 'params'), profile = join(dir, 'profile')
  writeFileSync(prover, '#!/bin/sh\necho "stub local-prover: no proofs here" >&2\nexit 1\n')
  chmodSync(prover, 0o755)
  mkdirSync(params)
  writeFileSync(join(params, 'manifest.json'), '{"stub":true}\n')
  installed = installHelper(profile, { prover, params })
  b = await launch({ profile })
  Object.assign(b, { prover, params })
})
after(async () => {
  if (skip) return
  await b?.close()
  await stopBridge()
  for (const d of [dir, installed]) rmSync(d, { recursive: true, force: true })
})

/** Open one native port from the extension page, send `requests`, collect one answer each (or the disconnect). */
const exchange = (page, requests) => page.evaluate((requests) => new Promise((resolve) => {
  const port = chrome.runtime.connectNative('xyz.blindfold.prover')
  const got = []
  port.onMessage.addListener((m) => { got.push(m); if (got.length === requests.length) { port.disconnect(); resolve({ got }) } })
  port.onDisconnect.addListener(() => resolve({ got, error: chrome.runtime.lastError?.message ?? null }))
  for (const r of requests) port.postMessage(r)
}), requests)

test('helper: the installed host manifest allows only this extension', { skip }, () => {
  const m = JSON.parse(readFileSync(join(b.profile, 'NativeMessagingHosts', 'xyz.blindfold.prover.json'), 'utf8'))
  assert.equal(m.name, 'xyz.blindfold.prover')
  assert.equal(m.type, 'stdio')
  assert.deepEqual(m.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`])
})

test('helper: hello through native messaging returns the v1 fields and the pinned hashes', { skip }, async () => {
  const app = await openApp(b)
  const { got, error } = await exchange(app, [{ id: 'h1', cmd: 'hello' }])
  assert.equal(error, undefined, error)
  assert.deepEqual(got, [{ id: 'h1', ok: true, result: {
    protocol: 1, version: got[0].result?.version, chainId: '31337', developmentOnly: true,
    manifestSha256: sha(join(b.params, 'manifest.json')), proverSha256: sha(b.prover),
  } }])
  assert.match(got[0].result.version, /^\d+\.\d+\.\d+$/)
})

test('helper: error envelope and codes: E_SESSION, E_VERSION, E_BAD_REQUEST, E_PARAMS, E_CHAIN, E_PROVER', { skip }, async () => {
  const app = await openApp(b)
  const pin = sha(join(b.params, 'manifest.json'))
  const request = { chainId: '31337', settlement: `0x${'11'.repeat(20)}`, owner: `0x${'22'.repeat(20)}`, batch: '0', round: '1', step: '0',
    totals: ['0', '0'], budgets: ['0', '0'], oldBlind: `0x${'00'.repeat(32)}`, zeroForOne: true, amount: '1', minimum: '1', salt: `0x${'33'.repeat(32)}` }
  const { got } = await exchange(app, [
    { id: 'e1', cmd: 'online', protocol: 1, session: 'no-such-session' },
    { id: 'e2', cmd: 'prepare', protocol: 2, manifestSha256: pin, request },
    { id: 'e3', cmd: 'sign' },
    { id: 'e4', cmd: 'prepare', protocol: 1, manifestSha256: 'ab'.repeat(32), request },
    { id: 'e5', cmd: 'prepare', protocol: 1, manifestSha256: pin, request: { ...request, chainId: '1' } },
    { id: 'e6', cmd: 'prepare', protocol: 1, manifestSha256: pin, request },
  ])
  assert.deepEqual(got.map((m) => [m.id, m.ok, m.error?.code]), [
    ['e1', false, 'E_SESSION'], ['e2', false, 'E_VERSION'], ['e3', false, 'E_BAD_REQUEST'],
    ['e4', false, 'E_PARAMS'], ['e5', false, 'E_CHAIN'], ['e6', false, 'E_PROVER'],
  ])
  for (const m of got) assert.deepEqual(Object.keys(m).sort(), ['error', 'id', 'ok'])
  for (const m of got) assert.equal(typeof m.error.message, 'string')
  assert.ok(!JSON.stringify(got).includes('33'.repeat(32)), 'an error message echoed the salt')
})

test('helper: a web page cannot reach the native host', { skip }, async () => {
  const page = await b.bridgePage()
  assert.equal(await page.evaluate(() => typeof globalThis.chrome?.runtime?.connectNative), 'undefined')
})
