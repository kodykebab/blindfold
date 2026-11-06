// Through the real extension, the bridge page and the test wallet on anvil 8563. EXT_E2E=1 and a built extension.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseEther } from 'viem'
import { startChain, user, DEPOSIT, Q96 } from '../lib/chain.mjs'
import { launch, stopBridge, EXTENSION_DIST } from '../lib/browser.mjs'
import { RDNS } from '../lib/anvil-wallet.mjs'
import { call, onboard, openApp, run, storageDump, until, DRAND, PASSPHRASE } from '../lib/extension.mjs'

const skip = process.env.EXT_E2E !== '1' || (!existsSync(join(EXTENSION_DIST, 'manifest.json')) && 'no extension build: npm run build in packages/extension')
const me = user(10)
const eq = (a, b) => a?.toLowerCase() === b?.toLowerCase()
let c, b

before(async () => {
  if (skip) return
  c = await startChain()
  for (const t of [c.dep.token0, c.dep.token1]) await c.mint(me.address, t, parseEther('100'))
})
after(async () => {
  if (skip) return
  await b?.close()
  await stopBridge()
  await c?.stop()
})

const ours = () => [c.dep.vault, c.dep.settlement, c.dep.token0, c.dep.token1]
/** Every transaction the wallet was asked to sign: only deployment contracts, never a message signature. */
function assertOnlyDeploymentCalls(wallet) {
  for (const x of wallet.log) assert.doesNotMatch(x.method, /^(personal_sign|eth_sign|eth_signTypedData)/)
  for (const x of wallet.log.filter((x) => x.method === 'eth_sendTransaction')) assert.ok(ours().some((a) => eq(a, x.params[0].to)), `signed a call to ${x.params[0].to}`)
}
const vault = (token, who = me.address) => c.read(c.dep.vault, 'BlindfoldVault', 'balanceOf', [who, token])
const wallet = (token, who = me.address) => c.read(token, 'MockERC20', 'balanceOf', [who])

test('I2: the extension sees the wallet list, the account and chain changes from the bridge', { skip }, async () => {
  b = await launch({ wallet: { accounts: [me, user(11)] } })
  const { app } = await onboard(b, c.dep)
  let s = await call(app, 'session')
  assert.deepEqual(s.wallets.map((w) => w.rdns), [RDNS])
  assert.deepEqual([s.bridge, s.wallet.accounts[0], s.wallet.chainId], [true, me.address.toLowerCase(), '0x7a69'])
  await b.wallet.setAccounts([user(11), me])
  await until(async () => eq((await call(app, 'session')).wallet.accounts[0], user(11).address), 'account change')
  await b.wallet.setAccounts([me, user(11)])
  await b.wallet.setChain('0x1')
  await until(async () => (await call(app, 'session')).wallet.chainId === '0x1', 'chain change')
  await b.wallet.setChain('0x7a69')
  await until(async () => (await call(app, 'session')).wallet.chainId === '0x7a69', 'chain back')
  s = await call(app, 'session')
  assert.match(await app.locator('#session').textContent(), new RegExp(`account ${me.address.toLowerCase()} on chain 31337`))
})

test('E1: fund and withdraw with no orders (approve + deposit signed through the bridge)', { skip }, async () => {
  const app = await openApp(b)
  await app.locator('#deposit-amount').fill('10')
  await app.locator('button[data-run="deposit"]').click()
  await until(async () => (await vault(c.dep.token0)) === parseEther('10'), 'deposit landed', 30_000)
  let r = await run(app, 'status')
  assert.equal(r.state, 'done', r.error)
  assert.match(JSON.stringify(r.result.balances), /"available":"10 TK.".*"withdrawable":"10 TK."/)
  r = await run(app, 'withdraw', { token: 'token0', amount: 'all' })
  assert.equal(r.state, 'done', r.error)
  assert.equal(await vault(c.dep.token0), 0n)
  assert.equal(await wallet(c.dep.token0), parseEther('100'))
  assertOnlyDeploymentCalls(b.wallet)
})

const S = () => c.dep.settlement
const readS = (fn, args = []) => c.read(S(), 'BlindfoldSettlement', fn, args)
const open = () => c.read(c.dep.vault, 'BlindfoldVault', 'openCommitments', [me.address])
const exported = async (app) => {
  const r = await run(app, 'export')
  assert.equal(r.state, 'done', r.error)
  return JSON.parse(r.result)
}
/** The counterparty commits straight to the chain (any ciphertext is accepted without admission). */
async function counterparty(i, batch, order, salt) {
  const tin = order.zeroForOne ? c.dep.token0 : c.dep.token1
  for (const [token, amount] of [[tin, order.amountIn], [c.dep.depositToken, DEPOSIT]]) {
    await c.mint(user(i).address, token, amount)
    await c.write(token, 'MockERC20', 'approve', [c.dep.vault, amount], user(i))
    await c.write(c.dep.vault, 'BlindfoldVault', 'deposit', [token, amount], user(i))
  }
  await c.write(S(), 'BlindfoldSettlement', 'commit', [batch, await readS('orderHash', [batch, order, salt]), '0x00'], user(i))
}

test('E2: commit, reveal, settle and withdraw without proofs; no plaintext order or salt in storage', { skip }, async () => {
  const app = await openApp(b)
  await app.locator('#side').selectOption('sell')
  await app.locator('#amount-in').fill('10')
  await app.locator('#min-out').fill('9')
  await app.locator('button[data-run="commit"]').click()
  await until(async () => (await open()) === 1n, 'commit landed', 60_000)
  await until(async () => /committed/.test(await app.locator('#out').textContent()), 'commit job done', 30_000)
  const [mine] = (await exported(app)).commitments
  assert.equal(typeof mine.id, 'string') // "0n": the receipt's commit id was saved
  const batch = BigInt(mine.batchId.replace(/n$/, ''))
  const dump = await storageDump(app)
  assert.ok(!dump.includes(mine.salt.slice(2)), 'salt stored in plain text')
  assert.ok(!dump.toLowerCase().includes(mine.hash.slice(2).toLowerCase()), 'order hash stored in plain text') // state is sealed as a whole

  const theirs = { order: { owner: user(11).address, zeroForOne: false, amountIn: parseEther('10'), minAmountOut: parseEther('9') }, salt: `0x${'11'.repeat(32)}` }
  await counterparty(11, batch, theirs.order, theirs.salt)

  await c.warp(await readS('revealOpens', [batch]))
  let r = await run(app, 'cleanup', { dryRun: false })
  assert.equal(r.state, 'done', r.error)
  assert.match(JSON.stringify((await run(app, 'track')).result), /revealed/) // the extension revealed its own saved order
  await c.write(S(), 'BlindfoldSettlement', 'reveal', [1n, theirs.order, theirs.salt], user(1))
  await c.warp(await readS('revealCloses', [batch]))
  await c.write(S(), 'BlindfoldSettlement', 'settle', [batch, Q96], user(1))

  r = await run(app, 'track')
  assert.equal(r.state, 'done', r.error)
  assert.match(JSON.stringify(r.result), /filled/)
  for (const token of ['token0', 'token1']) {
    r = await run(app, 'withdraw', { token, amount: 'all' })
    assert.equal(r.state, 'done', r.error)
  }
  // sold 10 TKA for 10 TKB at price 1; revealing its own order earned back the whole deposit
  assert.equal(await wallet(c.dep.token0), parseEther('90'))
  assert.equal(await wallet(c.dep.token1), parseEther('110'))
  assert.equal(await open(), 0n)
  assertOnlyDeploymentCalls(b.wallet)
})

test('S5: wrong chain: the wallet is on another chain and refuses to switch; nothing is signed', { skip }, async () => {
  const app = await openApp(b)
  await b.wallet.setChain('0x1')
  b.wallet.reject.add('wallet_switchEthereumChain')
  const sent = b.wallet.sent.length
  const r = await run(app, 'deposit', { token: 'token0', amount: '1' })
  b.wallet.reject.clear()
  await b.wallet.setChain('0x7a69')
  assert.equal(r.state, 'failed')
  assert.match(r.error, /4001|reject/i)
  assert.equal(b.wallet.sent.length, sent)
  assert.ok(!b.wallet.log.slice(-5).some((x) => x.method === 'eth_sendTransaction'))
})

test('S5: wrong contract: a deployment whose vault is not the settlement\'s is refused before signing', { skip }, async () => {
  const app = await openApp(b)
  const attacker = user(5).address
  await call(app, 'config', { rpcUrl: c.dep.rpc, deployment: { ...c.dep, vault: attacker }, drand: DRAND })
  const sent = b.wallet.sent.length
  const r = await run(app, 'deposit', { token: 'token0', amount: '1' })
  await call(app, 'config', { rpcUrl: c.dep.rpc, deployment: c.dep, drand: DRAND })
  assert.equal(r.state, 'failed', 'deposit to a vault the settlement does not use went ahead')
  assert.equal(b.wallet.sent.length, sent, `signed: ${JSON.stringify(b.wallet.sent.slice(sent))}`)
  assert.equal(await c.read(c.dep.token0, 'MockERC20', 'allowance', [me.address, attacker]), 0n)
})

let profile
test('F1: crash after the order is saved and before the commit is sent: the order is kept, nothing is stuck', { skip }, async () => {
  let app = await openApp(b)
  await call(app, 'config', { rpcUrl: c.dep.rpc, deployment: c.dep, drand: DRAND })
  b.wallet.hold = async (_, tx) => { if (eq(tx.to, S())) await new Promise(() => {}) } // the commit never leaves the wallet
  const commits = await readS('commitCount')
  const from = b.wallet.log.length
  run(app, 'commit', { side: 'sell', amountIn: '2', minOut: '1' }).catch(() => {})
  await until(() => b.wallet.log.slice(from).some((x) => x.method === 'eth_sendTransaction' && eq(x.params[0].to, S())), 'wallet asked to sign the commit', 60_000)
  profile = b.profile
  await b.close({ keepProfile: true }) // crash: the browser goes away mid-request

  b = await launch({ profile, wallet: { accounts: [me, user(11)] } })
  app = await openApp(b)
  await app.locator('#passphrase').fill(PASSPHRASE)
  await app.locator('button[data-call="unlock"]').click()
  await until(async () => (await call(app, 'session')).unlocked, 'unlocked after restart')
  const bridge = await b.bridgePage()
  await bridge.getByRole('button', { name: 'Blindfold test wallet' }).click()
  await until(async () => (await call(app, 'session')).wallet?.accounts?.[0], 'wallet after restart')

  assert.equal(await readS('commitCount'), commits, 'nothing was committed')
  const state = await exported(app)
  const saved = state.commitments.filter((x) => x.id == null)
  assert.equal(saved.length, 1, `the unsent order and its salt survived the crash: ${JSON.stringify(state)}`)
  assert.ok(!(await storageDump(app)).includes(saved[0].salt.slice(2)), 'salt stored in plain text')
  const r = await run(app, 'blockers')
  assert.equal(r.state, 'done', r.error)
  assert.equal(await open(), 0n)
})

test('F2: crash after the commit is sent and before it is mined: the extension recovers it and can reveal it', { skip }, async () => {
  let app = await openApp(b)
  await c.automine(false)
  const commits = await readS('commitCount')
  let job
  run(app, 'commit', { side: 'sell', amountIn: '2', minOut: '1' }).then((r) => { job = r }, (e) => { job = e.message })
  const tx = await until(() => b.wallet.sent.find((x) => eq(x.to, S()))?.hash ?? (job && assert.fail(JSON.stringify(job))), 'commit sent to the mempool', 60_000)
  await until(async () => (await exported(app)).commitments.some((x) => x.tx === tx), 'extension saved the commit hash before inclusion')
  await b.close({ keepProfile: true })
  await c.automine(true)
  await c.mine()
  assert.equal(await readS('commitCount'), commits + 1n)

  b = await launch({ profile, wallet: { accounts: [me, user(11)] } })
  app = await openApp(b)
  await app.locator('#passphrase').fill(PASSPHRASE)
  await app.locator('button[data-call="unlock"]').click()
  await until(async () => (await call(app, 'session')).unlocked, 'unlocked after restart')
  const bridge = await b.bridgePage()
  await bridge.getByRole('button', { name: 'Blindfold test wallet' }).click()
  await until(async () => (await call(app, 'session')).wallet?.accounts?.[0], 'wallet after restart')

  let r = await run(app, 'track')
  assert.equal(r.state, 'done', r.error)
  assert.match(JSON.stringify(r.result), /committed/)
  const [, batch] = await c.read(S(), 'BlindfoldSettlement', 'commitments', [commits]) // {committer, batchId, status, hash}
  await c.warp(await readS('revealOpens', [batch]))
  r = await run(app, 'cleanup', { dryRun: false })
  assert.equal(r.state, 'done', r.error)
  assert.match(JSON.stringify((await run(app, 'track')).result), /revealed/) // the salt saved before sending was enough
  await c.warp(await readS('settleCloses', [batch]))
  r = await run(app, 'cleanup', { dryRun: false }) // nobody settled: expire
  assert.equal(r.state, 'done', r.error)
  for (const token of ['token0', 'token1']) assert.equal((await run(app, 'withdraw', { token, amount: 'all' })).state, 'done')
  assert.equal(await open(), 0n)
  assertOnlyDeploymentCalls(b.wallet)
})
