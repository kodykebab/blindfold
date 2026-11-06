// Drives the real extension through its own page and the page <-> service worker messages the UI uses
// (packages/extension/src/app.mjs): {type: 'call', op, args} answers at once; {type: 'run', op, args} starts a job
// followed in chrome.storage.session under `job:<id>`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, RPC } from './chain.mjs'

export const PASSPHRASE = 'correct horse battery staple e2e'
export const DRAND = JSON.parse(readFileSync(join(ROOT, 'packages/client/test/fixtures/drand.json'), 'utf8')) // offline tlock

export async function openApp(b) {
  const page = await b.context.newPage()
  await page.goto(b.extensionUrl('app.html'))
  return page
}

export const call = (page, op, args = {}) => page.evaluate(async ([op, args]) => {
  const r = await chrome.runtime.sendMessage({ type: 'call', op, args })
  if (!r?.ok) throw new Error(r?.error ?? 'no answer')
  return r.result
}, [op, args])

/** Start a flow and wait for its job record: {state: 'done' | 'failed', result, error, log}. */
export const run = (page, op, args = {}) => page.evaluate(async ([op, args]) => {
  const r = await chrome.runtime.sendMessage({ type: 'run', op, args })
  if (!r?.ok) throw new Error(r?.error ?? `cannot run ${op}`)
  const key = `job:${r.result.job}`
  for (;;) {
    const rec = (await chrome.storage.session.get(key))[key]
    if (rec && rec.state !== 'running') { await chrome.storage.session.remove(key); return rec }
    await new Promise((ok) => setTimeout(ok, 100))
  }
}, [op, args])

/** Poll fn until it returns something truthy. */
export async function until(fn, what, ms = 15_000) {
  let last
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    last = await fn()
    if (last) return last
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)?.slice(0, 500)}`)
}

/**
 * First run through the UI: create the passphrase, paste the deployment (RPC 8563, recorded drand rounds), open the
 * bridge page and pick the test wallet there. Returns {app, bridge}.
 */
export async function onboard(b, dep, { passphrase = PASSPHRASE, deployment = dep } = {}) {
  const app = await openApp(b)
  await app.locator('#passphrase').fill(passphrase)
  await app.locator('button[data-call="setup"]').click()
  await until(async () => (await call(app, 'session')).unlocked, 'unlocked')
  await app.locator('#rpc-url').fill(RPC)
  await app.locator('#deployment').fill(JSON.stringify(deployment))
  await app.locator('#drand').fill(JSON.stringify(DRAND))
  await app.locator('button[data-call="config"]').click()
  await until(async () => (await call(app, 'session')).config?.deployment?.settlement === deployment.settlement, 'config saved')
  const bridge = await b.bridgePage()
  await bridge.getByRole('button', { name: 'Blindfold test wallet' }).click()
  await until(async () => (await call(app, 'session')).wallet?.accounts?.[0], 'wallet account in the extension')
  return { app, bridge }
}

/** Everything the extension keeps in chrome.storage (local and session), as one string, to grep for secrets. */
export const storageDump = (app) => app.evaluate(async () => JSON.stringify([await chrome.storage.local.get(null), await chrome.storage.session.get(null)]))
