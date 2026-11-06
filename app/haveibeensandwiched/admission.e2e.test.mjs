// Browser acceptance with admission on and real proofs: prepare ahead, commit with only the online proof, and the
// page offering the next preparation once the submission used this one up.
// Opt-in, about 10 minutes (300 s batches, real Groth16 proofs):
//   ADMISSION_E2E=1 ADMISSION_PARAMS=… ADMISSION_PROVER=… CONTRACTS_OUT=… node --test app/haveibeensandwiched/admission.e2e.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { root, freePort, command, checkAccessibilityAndNoRawErrors } from './browser-stack.mjs'
import { chromium } from '../../packages/extension-e2e/node_modules/playwright/index.mjs'

const enabled = process.env.ADMISSION_E2E === '1'
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? '', sel)
async function job(page, start, timeout) {
  await start()
  await page.waitForFunction(() => /COMPLETE|FAILED/.test(document.querySelector('#job-state').textContent), null, { timeout })
  const state = await text(page, '#job-state')
  assert.match(state, /COMPLETE/, await text(page, '#output'))
  await page.waitForFunction(() => !document.querySelector('#preview').disabled, null, { timeout: 60000 }) // follow-up refresh done
}
const refresh = (page) => job(page, () => page.click('[data-action="status"]'), 60000)

test('prepare ahead, commit with only the online proof, then the page offers the next preparation', { skip: !enabled, timeout: 1_200_000 }, async (t) => {
  assert.ok(process.env.ADMISSION_PARAMS && process.env.ADMISSION_PROVER, 'needs prepared development parameters and a built prover')
  const port = await freePort()
  const stack = spawn(process.execPath, ['scripts/dev-stack.mjs'], { cwd: root, env: { ...process.env, WEB_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  stack.stdout.on('data', (b) => { log += b }); stack.stderr.on('data', (b) => { log += b })
  const browser = await chromium.launch({ headless: true })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`stack did not start: ${log.slice(-2000)}`)), 180000)
      stack.stdout.on('data', () => { if (/LOCAL_WEB_URL=/.test(log)) { clearTimeout(timer); resolve() } })
      stack.once('exit', (code) => { clearTimeout(timer); reject(Error(`stack exited ${code}: ${log.slice(-2000)}`)) })
    })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${port}/trade`); await page.waitForLoadState('networkidle')
    await refresh(page)
    const batch = Number((await text(page, '#batch-status')).match(/^batch (\d+)/)[1])
    assert.match(await text(page, '#preparation-state'), /Nothing is prepared/)
    assert.equal(await text(page, '#prepare-next'), `Prepare for batch ${batch + 1}`)

    // Fund the vault as the page's own account (dev-stack: account 10, state in its directory).
    const dir = log.match(/Local deployment and private state: (.+)/)[1].trim()
    const dep = JSON.parse(readFileSync(join(dir, 'blindfold.local.json'), 'utf8'))
    const cliEnv = { ...process.env, RPC_URL: dep.rpc, DEPLOYMENTS: join(dir, 'blindfold.local.json'), CLIENT_STATE: join(dir, 'state'), CLIENT_ACCOUNT_INDEX: '10', PRIVATE_KEY: '' }
    for (const token of ['token0', 'token1']) assert.match(await command(join(root, 'packages/client/cli.mjs'), ['deposit', token, '20'], cliEnv), /deposited/)
    await refresh(page)

    t.diagnostic(`preparing batch ${batch + 1} (real preparation proof)`)
    await job(page, () => page.click('#prepare-next'), 600000)
    await refresh(page)
    assert.match(await text(page, '#preparation-state'), new RegExp(`Prepared for batch ${batch + 1}`))
    assert.equal(await page.evaluate(() => document.querySelector('#prepare-next').hidden), true, 'no prepare action while one is ready')

    t.diagnostic(`waiting for batch ${batch + 1} to open`)
    for (let i = 0; i < 60; i++) {
      await refresh(page)
      if (Number((await text(page, '#batch-status')).match(/^batch (\d+)/)[1]) === batch + 1) break
      await new Promise((r) => setTimeout(r, 10000))
    }
    assert.match(await text(page, '#batch-status'), new RegExp(`^batch ${batch + 1} `))

    await page.fill('#amount-in', '10'); await page.fill('#minimum-out', '1')
    await job(page, () => page.click('#preview'), 120000)
    const sent = []
    page.on('request', (r) => { if (r.url().endsWith('/api/trade')) sent.push(JSON.parse(r.postData()).action) })
    await page.click('#confirm')
    // Poll what the page shows: the step list is hidden again as soon as the follow-up status refresh starts.
    let steps = '', last = '', admitted = '', inTable = false
    for (const end = Date.now() + 300000; Date.now() < end; await new Promise((r) => setTimeout(r, 1000))) {
      const snap = await page.evaluate(() => ({ state: document.querySelector('#job-state').textContent, output: document.querySelector('#output').textContent, orders: document.querySelector('#orders-table-body')?.textContent ?? '', steps: document.querySelector('#prover-steps').hidden ? '' : document.querySelector('#prover-steps').textContent }))
      if (snap.steps) steps = snap.steps
      if (/admitted/.test(snap.output)) admitted = snap.output
      last = `${snap.state} | ${snap.output}`
      // Durable signal: the order shows up in Your orders (the "admitted" message is replaced by the next refresh).
      if (/Waiting for reveal/i.test(snap.orders)) { inTable = true; break }
      if (sent.includes('commit') && /FAILED/.test(snap.state)) break
    }
    assert.ok(inTable, `order not tracked: ${last} | steps: ${steps} | requests: ${sent.join(',')}`)
    assert.match(steps, /Prove/, 'proving steps were shown')

    await page.waitForFunction(() => !document.querySelector('#preview').disabled, null, { timeout: 60000 })
    await refresh(page)
    assert.match(await text(page, '#preparation-state'), /Nothing is prepared \(a submission uses up its preparation\)/)
    assert.equal(await text(page, '#prepare-next'), `Prepare for batch ${batch + 2}`, 'the used preparation leads to the next one')
    await checkAccessibilityAndNoRawErrors(page)
  } finally {
    await browser.close()
    if (stack.exitCode === null) { stack.kill('SIGTERM'); await once(stack, 'exit') }
  }
})
