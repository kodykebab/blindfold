// Browser acceptance for the order review: insufficient funds, and a balance or quote that changed after review.
// Opt-in: REVIEW_E2E=1 node --test app/haveibeensandwiched/review.e2e.test.mjs (admission off, local chain).
// Rejected signatures do not apply to this page: the local client signs; the extension's bridge tests cover 4001.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { root, sleep, command, checkAccessibilityAndNoRawErrors, setupStack } from './browser-stack.mjs'

const enabled = process.env.REVIEW_E2E === '1'
const CLI = join(root, 'packages/client/cli.mjs')
const confirmEnabled = (page) => page.evaluate(() => !document.querySelector('#confirm').disabled)
const reviewText = (page) => page.evaluate(() => document.querySelector('#review').textContent)
async function preview(page, amount) {
  await page.fill('#amount-in', amount)
  await page.fill('#minimum-out', '1')
  await page.click('#preview')
  await page.waitForFunction(() => /COMPLETE|FAILED/.test(document.querySelector('#job-state').textContent), null, { timeout: 30000 })
  await page.waitForFunction(() => !document.querySelector('#preview').disabled, null, { timeout: 30000 })
}

test('an order larger than the vault balance says fund first and cannot be confirmed', { skip: !enabled, timeout: 120000 }, async () => {
  const { page, origin, teardown } = await setupStack() // the vault holds 25 of each token
  try {
    await page.goto(`${origin}/trade`); await page.waitForLoadState('networkidle')
    await preview(page, '50')
    assert.match(await reviewText(page), /fund first|Fund first|deposit/i)
    assert.equal(await confirmEnabled(page), false, 'confirm stays off until the vault is funded')
    await checkAccessibilityAndNoRawErrors(page)
  } finally { await teardown() }
})

test('a balance that changed after review needs a fresh confirm, and nothing is sent meanwhile', { skip: !enabled, timeout: 180000 }, async () => {
  const { page, origin, env, teardown } = await setupStack()
  try {
    await page.goto(`${origin}/trade`); await page.waitForLoadState('networkidle')
    await preview(page, '10')
    assert.equal(await confirmEnabled(page), true, await reviewText(page))
    // The vault balance changes behind the page's back (another tab, another device).
    await command(CLI, ['deposit', 'token0', '3'], env)
    await page.click('#confirm')
    await page.waitForFunction(() => /changed since the last review/.test(document.querySelector('#review').textContent), null, { timeout: 30000 })
    const track = JSON.parse((await command(CLI, ['track', '--json'], env)).trim().split('\n').at(-1))
    assert.equal(track.orders.length, 0, 'no order was committed on the stale review')
    await checkAccessibilityAndNoRawErrors(page)
  } finally { await teardown() }
})

test('confirming after the quote went stale re-quotes before anything is committed', { skip: !enabled, timeout: 180000 }, async () => {
  const { page, origin, teardown } = await setupStack()
  try {
    await page.goto(`${origin}/trade`); await page.waitForLoadState('networkidle')
    await preview(page, '10')
    assert.equal(await confirmEnabled(page), true, await reviewText(page))
    await sleep(16_000) // older than QUOTE_STALE_SECONDS
    const sent = []
    page.on('request', (r) => { if (r.url().endsWith('/api/trade')) sent.push(JSON.parse(r.postData()).action) })
    await page.click('#confirm')
    await page.waitForFunction(() => /Waiting for reveal/i.test(document.querySelector('#orders-table-body')?.textContent ?? ''), null, { timeout: 60000 })
    // The pool can only be moved by the settlement, so the fresh quote matches and the order goes through,
    // but only after a new preview: a stale quote is never what gets confirmed.
    assert.deepEqual(sent.slice(0, 2), ['preflight', 'commit'])
  } finally { await teardown() }
})
