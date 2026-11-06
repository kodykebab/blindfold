// Keyboard and mobile checks on the trading page (no chain needed: the offline page server).
// Opt-in: A11Y_E2E=1 [BROWSER=firefox|webkit] node --test app/haveibeensandwiched/a11y.e2e.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { freePort } from './browser-stack.mjs'
import { chromium, firefox, webkit } from '../../packages/extension-e2e/node_modules/playwright/index.mjs'

const enabled = process.env.A11Y_E2E === '1'
// BROWSER=firefox|webkit after `npx playwright install firefox webkit`; Chromium by default.
const engine = { chromium, firefox, webkit }[process.env.BROWSER || 'chromium']
if (!engine) throw Error('BROWSER must be chromium, firefox or webkit')

async function withPage(viewport, fn) {
  const port = await freePort()
  const server = spawn(process.execPath, ['server.mjs'], { cwd: new URL('.', import.meta.url), env: { ...process.env, PORT: String(port), OFFLINE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  const browser = await engine.launch({ headless: true })
  try {
    await once(server.stdout, 'data')
    const page = await browser.newPage({ viewport })
    await page.goto(`http://127.0.0.1:${port}/trade`)
    await page.waitForLoadState('networkidle')
    await fn(page)
  } finally { await browser.close(); server.kill(); await once(server, 'exit') }
}

test('every enabled control is reachable with Tab and shows a visible focus ring', { skip: !enabled, timeout: 60000 }, async () => {
  await withPage({ width: 1280, height: 900 }, async (page) => {
    const wanted = await page.evaluate(() => [...document.querySelectorAll('button, input, select, a[href], textarea')]
      .filter((el) => !el.disabled && el.offsetParent && el.tabIndex >= 0 && el.type !== 'radio').map((el) => el.id || el.textContent.trim().slice(0, 30) || el.name))
    const reached = new Set()
    for (let i = 0; i < 120 && reached.size < wanted.length; i++) {
      await page.keyboard.press('Tab')
      const f = await page.evaluate(() => {
        const el = document.activeElement
        const s = getComputedStyle(el)
        return { key: el.id || el.textContent.trim().slice(0, 30) || el.name, ring: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 || s.boxShadow !== 'none' }
      })
      if (!wanted.includes(f.key)) continue
      assert.ok(f.ring, `${f.key} has no visible focus indicator`)
      reached.add(f.key)
    }
    assert.deepEqual(wanted.filter((k) => !reached.has(k)), [], 'controls never reached with Tab')
  })
})

test('at 375 px wide nothing scrolls sideways and every input has a label', { skip: !enabled, timeout: 60000 }, async () => {
  await withPage({ width: 375, height: 812 }, async (page) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px at 375px`)
    const wide = await page.evaluate(() => [...document.querySelectorAll('body *')]
      .filter((el) => el.offsetParent && !el.closest('[aria-hidden="true"]') && el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && getComputedStyle(el).position !== 'fixed') // decoration is clipped, not content
      .map((el) => el.id || el.className || el.tagName).slice(0, 5))
    assert.deepEqual(wide, [], 'elements wider than the screen')
    const unlabelled = await page.evaluate(() => [...document.querySelectorAll('input:not([type=hidden]), select, textarea')]
      .filter((el) => !(el.labels?.length || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'))).map((el) => el.id || el.name))
    assert.deepEqual(unlabelled, [], 'form fields without a label')
  })
})
