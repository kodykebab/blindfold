// Through the real extension, the bridge page and the test wallet on anvil 8563. EXT_E2E=1 and a built extension.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseEther } from 'viem'
import { startChain, user, DEPOSIT, Q96 } from '../lib/chain.mjs'
import { launch, stopBridge, EXTENSION_DIST } from '../lib/browser.mjs'
import { RDNS } from '../lib/anvil-wallet.mjs'
import { call, onboard, openApp, run, storageDump, until, PASSPHRASE } from '../lib/extension.mjs'

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
