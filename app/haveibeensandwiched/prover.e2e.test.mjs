// Browser acceptance for reload recovery, backup refusal and the backup reminder, against a real local chain.
// Opt-in: PROVER_E2E=1 node --test app/haveibeensandwiched/prover.e2e.test.mjs (admission off, recorded drand).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { root, command, checkAccessibilityAndNoRawErrors, stageMatches, setupStack } from './browser-stack.mjs'

const enabled = process.env.PROVER_E2E === '1'
const CLI = join(root, 'packages/client/cli.mjs')

async function placeOrder(page, origin) {
  await page.goto(`${origin}/trade`)
  await page.waitForLoadState('networkidle')
  await page.fill('#amount-in', '10')
  await page.fill('#minimum-out', '9')
  await page.click('#preview')
  await page.waitForSelector('#confirm:not([disabled])', { timeout: 15000 })
  await page.click('#confirm')
}

test('a page reloaded mid-commit reconnects to the local job and shows the committed order', { skip: !enabled, timeout: 120000 }, async () => {
  const { page, origin, teardown } = await setupStack()
  try {
    await placeOrder(page, origin)
    await page.waitForFunction(() => /RUNNING|STARTING/.test(document.querySelector('#job-state')?.textContent ?? ''), null, { timeout: 15000 })
    await page.reload()
    await page.waitForLoadState('networkidle')
    // The saved job id brings the page back to the same command; tracking then shows the order.
    assert.match(await stageMatches(page, /Waiting for reveal/i, 45000), /Waiting for reveal/i)
    await checkAccessibilityAndNoRawErrors(page)
  } finally { await teardown() }
})

test('a tampered backup is refused with a clear reason and local state is unchanged', { skip: !enabled, timeout: 120000 }, async () => {
  const { page, origin, env, dir, teardown } = await setupStack()
  try {
    await placeOrder(page, origin)
    await stageMatches(page, /Waiting for reveal/i, 45000)
    const file = join(dir, 'backup.json'), tampered = join(dir, 'tampered.json'), after = join(dir, 'after.json')
    await command(CLI, ['export-state', file], env)
    const backup = JSON.parse(readFileSync(file, 'utf8'))
    backup.commitments[0].salt = `0x${'00'.repeat(32)}`
    writeFileSync(tampered, JSON.stringify(backup))
    await page.setInputFiles('#restore-file', tampered)
    await page.waitForFunction(() => /FAILED/.test(document.querySelector('#job-state')?.textContent ?? ''), null, { timeout: 30000 })
    assert.match(await page.locator('#output').textContent(), /order or salt in the backup was changed/)
    await command(CLI, ['export-state', after], env)
    assert.deepEqual(JSON.parse(readFileSync(after, 'utf8')).commitments, JSON.parse(readFileSync(file, 'utf8')).commitments, 'state unchanged')
    await checkAccessibilityAndNoRawErrors(page)
  } finally { await teardown() }
})

test('the backup reminder survives reloads until a backup is exported and confirmed', { skip: !enabled, timeout: 120000 }, async () => {
  const { page, origin, teardown } = await setupStack()
  try {
    await placeOrder(page, origin)
    await stageMatches(page, /Waiting for reveal/i, 45000)
    const reminder = page.locator('#backup-reminder')
    assert.equal(await reminder.isVisible(), true)
    await page.reload(); await page.waitForLoadState('networkidle')
    assert.equal(await reminder.isVisible(), true, 'still shown after a reload')
    await page.click('#backup-confirm')
    assert.equal(await reminder.isVisible(), true, 'confirming without exporting does not clear it')
    assert.match(await page.locator('#backup-reminder-note').textContent(), /Export a backup first/)
    const download = page.waitForEvent('download', { timeout: 30000 })
    await page.click('[data-action="backup-export"]')
    await download
    await page.waitForFunction(() => /Backup exported/.test(document.querySelector('#backup-reminder-note')?.textContent ?? ''), null, { timeout: 15000 })
    await page.click('#backup-confirm')
    assert.equal(await reminder.isVisible(), false)
    await page.reload(); await page.waitForLoadState('networkidle')
    assert.equal(await reminder.isVisible(), false, 'stays cleared after a reload')
  } finally { await teardown() }
})
