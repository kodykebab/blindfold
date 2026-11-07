// Shared real-chain browser harness for the opt-in page e2e tests (orders, prover/backup). Not a test file itself.
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from '../../packages/extension-e2e/node_modules/playwright/index.mjs'
import { artifactPath } from '../../packages/solver/artifacts.mjs'

// viem comes from the client package, so the page package keeps no runtime dependencies.
const require = createRequire(new URL('../../packages/client/package.json', import.meta.url))
const { createPublicClient, createWalletClient, defineChain, getCreate2Address, http, toHex } = require('viem')
const { mnemonicToAccount } = require('viem/accounts')
export const root = fileURLToPath(new URL('../../', import.meta.url))
export const out = process.env.CONTRACTS_OUT || join(root, 'contracts/out')
export const art = (name) => JSON.parse(readFileSync(artifactPath(out, name), 'utf8'))
export const mnemonic = 'test test test test test test test test test test test junk'
export const user = (i) => mnemonicToAccount(mnemonic, { addressIndex: i })
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function freePort() {
  const s = createServer().listen(0, '127.0.0.1')
  await once(s, 'listening')
  const p = s.address().port
  await new Promise((r) => s.close(r))
  return p
}

export const command = (file, args, env) =>
  new Promise((resolve, reject) =>
    execFile(process.execPath, [file, ...args], { env, timeout: 60000 }, (error, stdout, stderr) =>
      error ? reject(Error(`${file}: ${stderr || stdout || error.message}`)) : resolve(stdout)
    )
  )

export async function checkAccessibilityAndNoRawErrors(page) {
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
export async function stageMatches(page, re, timeout = 20000) {
  const cell = page.locator('#orders-table-body td:nth-child(3)').first()
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(250)) {
    const text = (await cell.textContent().catch(() => '')) ?? '' // textContent: CSS uppercases the visible label
    if (re.test(text)) return text
  }
  return (await cell.textContent().catch(() => '')) ?? ''
}

/** Wait for the page's current job to finish; a failure reports what the page showed. */
export async function jobDone(page, timeout = 60000) {
  const state = page.locator('#job-state')
  await page.waitForFunction(() => /COMPLETE|FAILED|DISCONNECTED/.test(document.querySelector('#job-state')?.textContent ?? ''), null, { timeout })
  const text = await state.textContent()
  if (!/COMPLETE/.test(text)) throw new Error(`job ended ${text}: ${await page.locator('#output').textContent().catch(() => '')}`)
}

export async function setupStack({ emptyDrand = false } = {}) {
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

