// Browser acceptance test for order tracking, cleanup and withdrawal.
// Opt-in: ORDERS_E2E=1 node --test app/haveibeensandwiched/orders.e2e.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { root, out, user, sleep, command, checkAccessibilityAndNoRawErrors, stageMatches, jobDone, setupStack } from './browser-stack.mjs'
import { artifactPath } from '../../packages/solver/artifacts.mjs'

const enabled = process.env.ORDERS_E2E === '1'

test('Beacon delay: keeper waits when round is unavailable, then reveals once available', { skip: !enabled, timeout: 90000 }, async (t) => {
  let stack
  try {
    stack = await setupStack({ emptyDrand: true })
  } catch (err) {
    if (err.code === 'EPERM' || err.message?.includes('EPERM')) {
      t.skip('Skipped in sandboxed environment: anvil spawn requires unsandboxed execution (spawn EPERM)')
      return
    }
    throw err
  }
  const { page, origin, settlement, read, env, drandFile, realDrandData, jumpTo, teardown } = stack

  try {
    await page.goto(`${origin}/trade`)
    await page.waitForLoadState('networkidle')

    // Commit through page
    await page.fill('#amount-in', '10')
    await page.fill('#minimum-out', '9')
    await page.click('#preview')
    await page.waitForSelector('#confirm:not([disabled])', { timeout: 15000 })
    await page.click('#confirm')
    await jobDone(page)

    // Move chain time to revealOpens
    const revealOpens = await read(settlement, 'BlindfoldSettlement', 'revealOpens', [0n])
    await jumpTo(revealOpens)

    // Run keeper once: round is unavailable
    const keeperOut1 = await command(join(root, 'packages/keeper/keeper.mjs'), ['--once'], env)
    const st1 = JSON.parse(keeperOut1.trim().split('\n').at(-1))
    assert.ok(st1.waitingBeacon.length > 0, `keeper should report round in waitingBeacon: ${JSON.stringify(st1)}`)

    // In page: refresh tracking
    await page.click('#orders [data-action="track"]')
    await sleep(1000)

    // The row must still say "Waiting for reveal"
    const stage1 = await stageMatches(page, /Waiting for reveal/i)
    assert.match(stage1, /Waiting for reveal/i)

    // Now make round available
    writeFileSync(drandFile, JSON.stringify(realDrandData))

    // Run keeper again
    const keeperOut2 = await command(join(root, 'packages/keeper/keeper.mjs'), ['--once'], env)
    const st2 = JSON.parse(keeperOut2.trim().split('\n').at(-1))
    assert.equal(st2.revealed, 1, `keeper should reveal 1 order: ${JSON.stringify(st2)}`)

    // In page: refresh tracking
    await page.click('#orders [data-action="track"]')
    await sleep(1000)

    // The row must now say "Waiting for settlement"
    const stage2 = await stageMatches(page, /Waiting for settlement/i)
    assert.match(stage2, /Waiting for settlement/i)

    await checkAccessibilityAndNoRawErrors(page)
  } finally {
    await teardown()
  }
})

test('Keeper outage: user reveals order manually, solver settles, and trader withdraws', { skip: !enabled, timeout: 90000 }, async (t) => {
  let stack
  try {
    stack = await setupStack({ emptyDrand: false })
  } catch (err) {
    if (err.code === 'EPERM' || err.message?.includes('EPERM')) {
      t.skip('Skipped in sandboxed environment: anvil spawn requires unsandboxed execution (spawn EPERM)')
      return
    }
    throw err
  }
  const { page, origin, settlement, token1, read, env, dir, jumpTo, teardown } = stack

  try {
    await page.goto(`${origin}/trade`)
    await page.waitForLoadState('networkidle')

    // Commit through page
    await page.fill('#amount-in', '10')
    await page.fill('#minimum-out', '9')
    await page.click('#preview')
    await page.waitForSelector('#confirm:not([disabled])', { timeout: 15000 })
    await page.click('#confirm')
    await jobDone(page)

    // Move chain time to reveal window
    const revealOpens = await read(settlement, 'BlindfoldSettlement', 'revealOpens', [0n])
    await jumpTo(revealOpens)

    // Never run the keeper. Refresh tracking on the page.
    await page.click('#orders [data-action="track"]')
    await sleep(1000)

    // The row's next step must be "Reveal now"
    const revealBtn = page.getByRole('button', { name: /Reveal order/ }) // its aria-label; the visible text says "Reveal now"
    await revealBtn.waitFor({ state: 'visible', timeout: 10000 })

    // Click it and accept confirmation dialog
    page.once('dialog', async (dialog) => {
      await dialog.accept()
    })
    await revealBtn.click()
    await jobDone(page)

    // Submit matching counter-order from user 11 so auction clears
    const env11 = { ...env, CLIENT_ACCOUNT_INDEX: '11', CLIENT_STATE: join(dir, 'user11') }
    await command(join(root, 'packages/client/cli.mjs'), ['deposit', 'token0', '20'], env11)
    await command(join(root, 'packages/client/cli.mjs'), ['deposit', 'token1', '20'], env11)
    await command(join(root, 'packages/client/cli.mjs'), ['commit', 'buy', '10', '9'], env11)
    await command(join(root, 'packages/client/cli.mjs'), ['cleanup'], env11)

    // Move time past revealCloses
    const revealCloses = await read(settlement, 'BlindfoldSettlement', 'revealCloses', [0n])
    await jumpTo(revealCloses)

    // Run solver once
    const solverOut = await command(join(root, 'packages/solver/solver.mjs'), ['--once', '--json'], {
      ...env,
      SETTLEMENT_ARTIFACT: artifactPath(out, 'BlindfoldSettlement'),
    })
    const solverSt = JSON.parse(solverOut.trim())
    assert.equal(solverSt.settled.length, 1, `solver should settle batch: ${JSON.stringify(solverSt)}`)

    // In page: refresh tracking
    await page.click('#orders [data-action="track"]')
    await sleep(1000)

    // Row must say Filled or Partly filled
    const stage = await stageMatches(page, /Filled|Partly filled/i)
    assert.match(stage, /Filled|Partly filled/i)

    // "Withdraw all" must appear
    const withdrawBtn = page.getByRole('button', { name: /Withdraw all token1/ }) // sold token0, so the proceeds are token1
    await withdrawBtn.waitFor({ state: 'visible', timeout: 10000 })

    const before = await read(token1, 'MockERC20', 'balanceOf', [user(10).address])
    await withdrawBtn.click()
    await jobDone(page)

    const after = await read(token1, 'MockERC20', 'balanceOf', [user(10).address])
    assert.ok(after > before, `balance should increase after withdraw: before ${before}, after ${after}`)

    await checkAccessibilityAndNoRawErrors(page)
  } finally {
    await teardown()
  }
})

test('Expiry: unsettled batch expires, cleanup releases vault, and trader withdraws', { skip: !enabled, timeout: 90000 }, async (t) => {
  let stack
  try {
    stack = await setupStack({ emptyDrand: false })
  } catch (err) {
    if (err.code === 'EPERM' || err.message?.includes('EPERM')) {
      t.skip('Skipped in sandboxed environment: anvil spawn requires unsandboxed execution (spawn EPERM)')
      return
    }
    throw err
  }
  const { page, origin, settlement, token0, read, env, jumpTo, teardown } = stack

  try {
    await page.goto(`${origin}/trade`)
    await page.waitForLoadState('networkidle')

    // Commit through page
    await page.fill('#amount-in', '10')
    await page.fill('#minimum-out', '9')
    await page.click('#preview')
    await page.waitForSelector('#confirm:not([disabled])', { timeout: 15000 })
    await page.click('#confirm')
    await jobDone(page)

    // Move to revealOpens and run keeper
    const revealOpens = await read(settlement, 'BlindfoldSettlement', 'revealOpens', [0n])
    await jumpTo(revealOpens)
    await command(join(root, 'packages/keeper/keeper.mjs'), ['--once'], env)

    // Never run solver! Move past settleCloses
    const settleCloses = await read(settlement, 'BlindfoldSettlement', 'settleCloses', [0n])
    await jumpTo(settleCloses)

    // In page: refresh tracking
    await page.click('#orders [data-action="track"]')
    await sleep(1000)

    // Row must say "Expired" or offer "Clean up"
    const cleanupBtn = page.getByRole('button', { name: /Clean up/ }).first()
    await cleanupBtn.waitFor({ state: 'visible', timeout: 10000 })

    // Click "Clean up" and confirm dialog
    page.once('dialog', async (dialog) => {
      await dialog.accept()
    })
    await cleanupBtn.click()
    await jobDone(page)

    // Withdrawal summary must change to "Nothing blocks withdrawal"
    await page.waitForSelector('#withdrawal-summary:has-text("Nothing blocks withdrawal")', { timeout: 15000 })
    const summary = await page.locator('#withdrawal-summary').innerText()
    assert.match(summary, /Nothing blocks withdrawal/i)

    // "Withdraw all" must appear and succeed
    const withdrawBtn = page.getByRole('button', { name: /Withdraw all/ }).first()
    await withdrawBtn.waitFor({ state: 'visible', timeout: 10000 })

    const before = await read(token0, 'MockERC20', 'balanceOf', [user(10).address])
    await withdrawBtn.click()
    await jobDone(page)

    const after = await read(token0, 'MockERC20', 'balanceOf', [user(10).address])
    assert.ok(after > before, `balance should increase after withdraw: before ${before}, after ${after}`)

    await checkAccessibilityAndNoRawErrors(page)
  } finally {
    await teardown()
  }
})
