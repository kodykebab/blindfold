// Browser acceptance test for order tracking, cleanup and withdrawal.
// Opt-in: ORDERS_E2E=1 node --test app/haveibeensandwiched/orders.e2e.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, defineChain, getCreate2Address, http, toHex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { chromium } from '../../packages/extension-e2e/node_modules/playwright/index.mjs'
import { artifactPath } from '../../packages/solver/artifacts.mjs'

const enabled = process.env.ORDERS_E2E === '1'
const root = fileURLToPath(new URL('../../', import.meta.url))
const out = process.env.CONTRACTS_OUT || join(root, 'contracts/out')
const art = (name) => JSON.parse(readFileSync(artifactPath(out, name), 'utf8'))
const mnemonic = 'test test test test test test test test test test test junk'
const user = (i) => mnemonicToAccount(mnemonic, { addressIndex: i })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function freePort() {
  const s = createServer().listen(0, '127.0.0.1')
  await once(s, 'listening')
  const p = s.address().port
  await new Promise((r) => s.close(r))
  return p
}

const command = (file, args, env) =>
  new Promise((resolve, reject) =>
    execFile(process.execPath, [file, ...args], { env, timeout: 60000 }, (error, stdout, stderr) =>
      error ? reject(Error(`${file}: ${stderr || stdout || error.message}`)) : resolve(stdout)
    )
  )

async function checkAccessibilityAndNoRawErrors(page) {
  const text = await page.evaluate(() => document.body.innerText)
  assert.ok(!text.includes('client:'), 'page should never show raw client: output')
  assert.ok(!text.includes('at ModuleLoader.'), 'page should never display a stack trace')
  assert.ok(!text.includes('at async '), 'page should never display an async stack trace')
  assert.ok(!text.includes('ERR_MODULE_NOT_FOUND'), 'page should never display unhandled error codes')

  const buttons = await page.getByRole('button').all()
  for (const btn of buttons) {
    const isVisible = await btn.isVisible().catch(() => false)
    if (!isVisible) continue
    // aria-label, own text, a wrapping or for= <label> (file inputs), value, or title all give a button its name.
    const name = await btn.evaluate((el) => (el.getAttribute('aria-label') || el.innerText || [...(el.labels ?? [])].map((l) => l.innerText).join(' ') || el.value || el.title || '').trim())
    assert.ok(name.length > 0, `button should have a non-empty accessible name: ${await btn.evaluate((el) => el.outerHTML.slice(0, 120))}`)
  }
}

/** The first order row's stage once it matches `re` (a refresh is two chained jobs), or whatever it says after `timeout`. */
async function stageMatches(page, re, timeout = 20000) {
  const cell = page.locator('#orders-table-body td:nth-child(3)').first()
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(250)) {
    const text = (await cell.textContent().catch(() => '')) ?? '' // textContent: CSS uppercases the visible label
    if (re.test(text)) return text
  }
  return (await cell.textContent().catch(() => '')) ?? ''
}

/** Wait for the page's current job to finish; a failure reports what the page showed. */
async function jobDone(page, timeout = 60000) {
  const state = page.locator('#job-state')
  await page.waitForFunction(() => /COMPLETE|FAILED|DISCONNECTED/.test(document.querySelector('#job-state')?.textContent ?? ''), null, { timeout })
  const text = await state.textContent()
  if (!/COMPLETE/.test(text)) throw new Error(`job ended ${text}: ${await page.locator('#output').textContent().catch(() => '')}`)
}

async function setupStack({ emptyDrand = false } = {}) {
  const port = await freePort(), webPort = await freePort()
  const rpc = `http://127.0.0.1:${port}`, origin = `http://127.0.0.1:${webPort}`
  const batchLength = 60
  const start = 1692803367 + 3 * 999997 - 60
  const anvilBin = existsSync(join(process.env.HOME || '', '.foundry/bin/anvil'))
    ? join(process.env.HOME || '', '.foundry/bin/anvil')
    : 'anvil'
  const anvil = spawn(
    anvilBin,
    ['--silent', '--port', String(port), '--accounts', '20', '--gas-limit', '300000000', '--timestamp', String(start)],
    { stdio: 'ignore' }
  )

  const dir = mkdtempSync(join(tmpdir(), 'blindfold-orders-e2e-'))
  let web = null
  let browser = null

  const chain = defineChain({
    id: 31337,
    name: 'local',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  })
  const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 50 })
  const wallet = createWalletClient({ account: user(0), chain, transport: http(rpc) })

  for (let i = 0; ; i++) {
    try {
      await pub.getChainId()
      break
    } catch {
      if (i > 100) throw Error('Anvil did not start')
      await sleep(50)
    }
  }

  const wait = async (hash) => {
    const receipt = await pub.waitForTransactionReceipt({ hash })
    assert.equal(receipt.status, 'success')
    return receipt
  }
  const deploy = async (name, args = []) =>
    (await wait(await wallet.deployContract({ abi: art(name).abi, bytecode: art(name).bytecode.object, args }))).contractAddress
  const write = async (address, name, functionName, args = []) =>
    wait(await wallet.writeContract({ address, abi: art(name).abi, functionName, args }))
  const read = (address, name, functionName, args = []) =>
    pub.readContract({ address, abi: art(name).abi, functionName, args })

  const manager = await deploy('PoolManager', [user(0).address])
  const a = await deploy('MockERC20', ['Token A', 'TKA', 18])
  const b = await deploy('MockERC20', ['Token B', 'TKB', 18])
  const [token0, token1] = [a, b].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1))
  const vault = await deploy('BlindfoldVault', [])

  const settlement = await deploy('BlindfoldSettlement', [
    {
      manager,
      vault,
      depositToken: token1,
      depositAmount: 5n * 10n ** 18n,
      commitFee: 1n,
      bountyBps: 2000n,
      treasury: user(9).address,
      schedule: { start, batchLength, revealLength: 24, settleLength: 30 },
      toleranceBps: 100n,
    },
  ])
  await write(vault, 'BlindfoldVault', 'setOperator', [settlement])

  const factory = await deploy('AdmissionPoolFactory')
  const bytecodeHash = await read(factory, 'AdmissionPoolFactory', 'initCodeHash', [manager, settlement])
  let hooks, salt
  for (let i = 0n; i < 500000n; i++) {
    const candidate = toHex(i, { size: 32 }),
      address = getCreate2Address({ from: factory, salt: candidate, bytecodeHash })
    if ((BigInt(address) & 16383n) === 128n) {
      hooks = address
      salt = candidate
      break
    }
  }
  assert.ok(salt, 'hook salt found')
  await write(factory, 'AdmissionPoolFactory', 'deployHook', [manager, settlement, salt])

  const key = { currency0: token0, currency1: token1, fee: 3000, tickSpacing: 60, hooks }
  await write(manager, 'PoolManager', 'initialize', [key, 1n << 96n])
  await write(settlement, 'BlindfoldSettlement', 'initialize', [key])

  const lp = await deploy('PoolModifyLiquidityTest', [manager])
  for (const token of [token0, token1]) {
    await write(token, 'MockERC20', 'mint', [user(0).address, 10n ** 30n])
    await write(token, 'MockERC20', 'approve', [lp, (1n << 256n) - 1n])
  }
  await write(lp, 'PoolModifyLiquidityTest', 'modifyLiquidity', [
    key,
    { tickLower: -60000, tickUpper: 60000, liquidityDelta: 10n ** 22n, salt: toHex(0n, { size: 32 }) },
    '0x',
  ])

  for (const index of [10, 11]) {
    for (const token of [token0, token1]) {
      await write(token, 'MockERC20', 'mint', [user(index).address, 100n * 10n ** 18n])
    }
  }

  const deployment = join(dir, 'deployment.json')
  writeFileSync(
    deployment,
    JSON.stringify({ chainId: 31337, deployBlock: 0, vault, settlement, token0, token1, depositToken: token1, admission: 'off' })
  )

  const drandFixturePath = join(root, 'packages/client/test/fixtures/drand.json')
  const realDrandData = JSON.parse(readFileSync(drandFixturePath, 'utf8'))
  const drandFile = join(dir, 'drand.json')
  if (emptyDrand) {
    writeFileSync(drandFile, JSON.stringify({ public_key: realDrandData.public_key, chain_hash: realDrandData.chain_hash, rounds: {} }))
  } else {
    writeFileSync(drandFile, JSON.stringify(realDrandData))
  }

  const env = {
    ...process.env,
    RPC_URL: rpc,
    DEPLOYMENTS: deployment,
    CONTRACTS_OUT: out,
    DRAND: drandFile,
    MNEMONIC: mnemonic,
    PRIVATE_KEY: '',
    KEEPER_KEY: '',
    SOLVER_KEY: '',
    CLIENT_ACCOUNT_INDEX: '10',
    CLIENT_STATE: join(dir, 'user10'),
    PORT: String(webPort),
    OFFLINE: '1',
  }

  web = spawn(process.execPath, ['server.mjs'], {
    cwd: join(root, 'app/haveibeensandwiched'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await Promise.race([
    once(web.stdout, 'data'),
    once(web, 'exit').then(([code]) => {
      throw Error(`web server exited ${code}`)
    }),
  ])

  // Pre-fund user 10 in the vault so order commits succeed immediately
  await command(join(root, 'packages/client/cli.mjs'), ['deposit', 'token0', '25'], env)
  await command(join(root, 'packages/client/cli.mjs'), ['deposit', 'token1', '25'], env)

  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  if (process.env.ORDERS_E2E_DEBUG) page.on('request', (r) => { if (r.url().endsWith('/api/trade')) console.error(`page sent ${r.postData()}`) })

  const jumpTo = async (target) => {
    await pub.request({ method: 'evm_setNextBlockTimestamp', params: [Number(target) + 1] })
    await pub.request({ method: 'evm_mine', params: [] })
  }

  const teardown = async () => {
    if (browser) await browser.close().catch(() => {})
    if (web && web.exitCode === null) {
      web.kill()
      await once(web, 'exit').catch(() => {})
    }
    anvil.kill()
  }

  return {
    anvil,
    web,
    browser,
    page,
    pub,
    wallet,
    token0,
    token1,
    settlement,
    vault,
    env,
    origin,
    dir,
    drandFile,
    realDrandData,
    read,
    jumpTo,
    teardown,
  }
}

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
