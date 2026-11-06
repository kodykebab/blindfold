// I1: only the bridge origin can connect. S4: an unknown website can't message the extension. Real extension. EXT_E2E=1.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { serve } from '../../bridge/server.mjs'
import { launch, stopBridge, BRIDGE, EXTENSION_ID, EXTENSION_DIST } from '../lib/browser.mjs'

const skip = process.env.EXT_E2E !== '1' || (!existsSync(join(EXTENSION_DIST, 'manifest.json')) && 'no extension build: npm run build in packages/extension')
let b, other

before(async () => {
  if (skip) return
  b = await launch()
  other = await serve(4318, '127.0.0.1') // the same page on another origin: an "unknown website"
})
after(async () => {
  if (skip) return
  await b?.close()
  other?.close()
  await stopBridge()
})

test('S4: other origins get no chrome.runtime to reach the extension, and the bridge page says so', { skip }, async () => {
  for (const url of ['http://127.0.0.1:4318/', 'http://localhost:4318/']) {
    const page = await b.context.newPage()
    await page.goto(url).catch(() => {}) // localhost:4318 may not be listening; about:blank-like error page then
    const reach = await page.evaluate(() => typeof globalThis.chrome?.runtime?.connect + typeof globalThis.chrome?.runtime?.sendMessage).catch(() => 'undefinedundefined')
    assert.equal(reach, 'undefinedundefined', url)
    if (url.startsWith('http://127')) assert.match(await page.locator('#extension').textContent(), /extension not found/)
    await page.close()
  }
})

test('I1: from the bridge origin, a port with the right name stays open; any other name is disconnected', { skip }, async () => {
  const page = await b.context.newPage()
  await page.goto(`${BRIDGE}/style.css`) // same origin, but not the bridge page, so no second port competes
  const outcome = (name) => page.evaluate(([id, name]) => new Promise((resolve) => {
    const p = chrome.runtime.connect(id, { name })
    p.onDisconnect.addListener(() => { void chrome.runtime.lastError; resolve('disconnected') })
    setTimeout(() => { resolve('open'); p.disconnect() }, 2000)
  }), [EXTENSION_ID, name])
  assert.equal(await outcome('blindfold-bridge'), 'open')
  assert.equal(await outcome('not-the-bridge'), 'disconnected')
  assert.equal(await outcome(''), 'disconnected')
  await page.close()
})

test('S4: one-shot messages from the bridge origin get no answer; the protocol is port-only', { skip }, async () => {
  const page = await b.bridgePage()
  const r = await page.evaluate((id) => new Promise((resolve) => {
    chrome.runtime.sendMessage(id, { type: 'send', id: 'x', from: '0x0000000000000000000000000000000000000001', calls: [] }, (res) => {
      resolve({ res: res ?? null, error: chrome.runtime.lastError?.message ?? null })
    })
  }), EXTENSION_ID)
  assert.equal(r.res, null, JSON.stringify(r))
  await page.close()
})

test('I1: the bridge page connects to the real extension and stays connected', { skip }, async () => {
  const page = await b.bridgePage()
  await page.waitForTimeout(2500)
  assert.match(await page.locator('#extension').textContent(), /Connected to the Blindfold extension/)
  assert.equal(new URL(page.url()).origin, BRIDGE)
  await page.close()
})
