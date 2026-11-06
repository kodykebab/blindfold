// The bridge page in a real Chromium with the test wallet and a stand-in extension (same ID): discovery, connect,
// account/chain changes, approve+deposit one by one and as an EIP-5792 batch, rejection, wrong chain/account. EXT_E2E=1.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { encodeFunctionData, parseEther } from 'viem'
import { startChain, user, abi } from '../lib/chain.mjs'
import { launch, stopBridge, BRIDGE } from '../lib/browser.mjs'
import { fakeExtension } from '../lib/fake-extension.mjs'
import { RDNS } from '../lib/anvil-wallet.mjs'

const enabled = process.env.EXT_E2E === '1'
let c, b, page
const me = user(10)
const inbox = () => b.sw.evaluate(() => self.inbox)
const post = (m) => b.sw.evaluate((m) => self.post(m), m)
const clear = () => b.sw.evaluate(() => { self.inbox.length = 0 })
async function until(pred, what, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const v = pred(await inbox())
    if (v) return v
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(await inbox()).slice(0, 2000)}`)
}
const resultFor = (id) => until((m) => m.find((x) => x.type === 'result' && x.id === id), `result ${id}`)
const CHAIN = { chainId: '0x7a69', chainName: 'Anvil 8563', rpcUrls: ['http://127.0.0.1:8563'], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }
const approveDeposit = (amount) => [
  { to: c.dep.token0, data: encodeFunctionData({ abi: abi('MockERC20'), functionName: 'approve', args: [c.dep.vault, amount] }) },
  { to: c.dep.vault, data: encodeFunctionData({ abi: abi('BlindfoldVault'), functionName: 'deposit', args: [c.dep.token0, amount] }) },
]
const vaultBalance = () => c.read(c.dep.vault, 'BlindfoldVault', 'balanceOf', [me.address, c.dep.token0])

before(async () => {
  if (!enabled) return
  c = await startChain()
  await c.mint(me.address, c.dep.token0, parseEther('100'))
  b = await launch({ extension: fakeExtension(), wallet: { accounts: [me, user(11)] } })
  page = await b.bridgePage()
})
after(async () => {
  if (!enabled) return
  await b?.close()
  await stopBridge()
  await c?.stop()
})

test('bridge I2: hello and EIP-6963 discovery reach the extension from the bridge origin', { skip: !enabled }, async () => {
  await until((m) => m.some((x) => x.type === 'hello' && x.version === 1), 'hello')
  const { wallets } = await until((m) => m.findLast((x) => x.type === 'wallets' && x.wallets.length), 'wallets')
  assert.deepEqual(wallets.map((w) => [w.name, w.rdns]), [['Blindfold test wallet', RDNS]])
  assert.match(wallets[0].icon, /^data:image\/svg\+xml,/)
  assert.equal(await b.sw.evaluate(() => self.origin()), BRIDGE)
})

test('bridge I2: the user picks the wallet on the page; account and chain reach the extension', { skip: !enabled }, async () => {
  await page.getByRole('button', { name: 'Blindfold test wallet' }).click()
  const w = await until((m) => m.findLast((x) => x.type === 'wallet'), 'wallet')
  assert.deepEqual([w.rdns, w.accounts, w.chainId, w.atomic], [RDNS, [me.address.toLowerCase(), user(11).address.toLowerCase()], '0x7a69', false])
  assert.equal(await page.locator('#account').textContent(), me.address.toLowerCase())
})

test('bridge I2: accountsChanged and chainChanged are forwarded; the extension can connect by rdns', { skip: !enabled }, async () => {
  await clear()
  await b.wallet.setAccounts([user(11), me])
  let w = await until((m) => m.findLast((x) => x.type === 'wallet'), 'wallet after accountsChanged')
  assert.equal(w.accounts[0], user(11).address.toLowerCase())
  await b.wallet.setAccounts([me, user(11)])
  await b.wallet.setChain('0x1')
  w = await until((m) => m.findLast((x) => x.type === 'wallet' && x.chainId === '0x1' && x.accounts[0] === me.address.toLowerCase()), 'wallet on 0x1')
  await b.wallet.setChain('0x7a69')
  await clear()
  await post({ type: 'connect', rdns: RDNS })
  w = await until((m) => m.findLast((x) => x.type === 'wallet'), 'wallet after connect')
  assert.equal(w.chainId, '0x7a69')
})

test('bridge send: approve + deposit one by one when the wallet has no atomic batching', { skip: !enabled }, async () => {
  await clear()
  const before = await vaultBalance()
  await post({ type: 'send', id: 'seq-1', from: me.address, chain: CHAIN, calls: approveDeposit(parseEther('3')) })
  const r = await resultFor('seq-1')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(r.atomic, false)
  assert.deepEqual(r.receipts.map((x) => x.status), ['0x1', '0x1'])
  const sent = (await inbox()).filter((x) => x.type === 'sent' && x.id === 'seq-1')
  assert.deepEqual(sent.map((x) => [x.index, x.hash]), r.hashes.map((h, i) => [i, h]))
  assert.equal(await vaultBalance(), before + parseEther('3'))
  assert.match(await page.locator('#activity').textContent(), /Done: 2 transaction/)
})

test('bridge send: approve + deposit as one EIP-5792 batch when the wallet reports atomic support', { skip: !enabled }, async () => {
  b.wallet.atomic = true
  await clear()
  await post({ type: 'connect', rdns: RDNS }) // re-reads capabilities
  assert.equal((await until((m) => m.findLast((x) => x.type === 'wallet'), 'wallet')).atomic, true)
  const before = await vaultBalance()
  await post({ type: 'send', id: 'atomic-1', from: me.address, chain: CHAIN, calls: approveDeposit(parseEther('2')) })
  const r = await resultFor('atomic-1')
  assert.deepEqual([r.ok, r.atomic, r.receipts.length], [true, true, 2], JSON.stringify(r.error))
  assert.ok((await inbox()).some((x) => x.type === 'sent' && x.id === 'atomic-1' && x.callsId))
  assert.equal(await vaultBalance(), before + parseEther('2'))
  assert.ok(b.wallet.log.some((x) => x.method === 'wallet_sendCalls' && x.params[0].atomicRequired === true))
  b.wallet.atomic = false
})

test('bridge send: user rejection (4001) comes back as a result; nothing is sent', { skip: !enabled }, async () => {
  b.wallet.reject.add('eth_sendTransaction')
  const n = await c.pub.getTransactionCount({ address: me.address })
  await post({ type: 'send', id: 'rej-1', from: me.address, chain: CHAIN, calls: approveDeposit(1n).slice(0, 1) })
  const r = await resultFor('rej-1')
  b.wallet.reject.clear()
  assert.deepEqual([r.ok, r.error.code, r.hashes], [false, 4001, []])
  assert.equal(await c.pub.getTransactionCount({ address: me.address }), n)
})

test('bridge S5: wrong chain is switched back, an unknown chain is added (4902), a refused switch signs nothing', { skip: !enabled }, async () => {
  await b.wallet.setChain('0x1')
  await post({ type: 'send', id: 'chain-1', from: me.address, chain: CHAIN, calls: approveDeposit(1n).slice(0, 1) })
  assert.equal((await resultFor('chain-1')).ok, true)
  assert.equal(b.wallet.chainId, '0x7a69')

  b.wallet.known.delete('0x7a69')
  await b.wallet.setChain('0x1')
  await post({ type: 'send', id: 'chain-2', from: me.address, chain: CHAIN, calls: approveDeposit(1n).slice(0, 1) })
  assert.equal((await resultFor('chain-2')).ok, true)
  assert.ok(b.wallet.log.some((x) => x.method === 'wallet_addEthereumChain' && x.params[0].chainId === '0x7a69'))

  await b.wallet.setChain('0x1')
  b.wallet.reject.add('wallet_switchEthereumChain')
  const signed = b.wallet.signed().length
  await post({ type: 'send', id: 'chain-3', from: me.address, chain: CHAIN, calls: approveDeposit(1n).slice(0, 1) })
  const r = await resultFor('chain-3')
  b.wallet.reject.clear()
  assert.deepEqual([r.ok, r.error.code], [false, 4001])
  assert.equal(b.wallet.signed().length, signed)
  await b.wallet.setChain('0x7a69')
})

test('bridge: a request for another account is refused before signing; no message signature is ever requested', { skip: !enabled }, async () => {
  const signed = b.wallet.signed().length
  await post({ type: 'send', id: 'acct-1', from: user(11).address, chain: CHAIN, calls: approveDeposit(1n).slice(0, 1) })
  const r = await resultFor('acct-1')
  assert.deepEqual([r.ok, r.error.code], [false, 'WRONG_ACCOUNT'])
  assert.equal(b.wallet.signed().length, signed)
  assert.deepEqual(b.wallet.log.filter((x) => /^(personal_sign|eth_sign|eth_signTypedData)/.test(x.method)), [])
})

test('bridge: when the port drops mid-request it reconnects, re-sends its state, then the result it held', { skip: !enabled }, async () => {
  let release
  b.wallet.hold = () => new Promise((r) => { release = r })
  await clear()
  await post({ type: 'send', id: 'drop-1', from: me.address, chain: CHAIN, calls: approveDeposit(1n).slice(0, 1) })
  for (let i = 0; !release; i++) { assert.ok(i < 200, 'wallet never asked to send'); await new Promise((r) => setTimeout(r, 50)) }
  await b.sw.evaluate(() => self.drop())
  b.wallet.hold = null
  release()
  const r = await resultFor('drop-1')
  assert.equal(r.ok, true, JSON.stringify(r.error))
  const m = await inbox()
  const at = (pred) => m.findIndex(pred)
  assert.ok(at((x) => x.type === 'hello') < at((x) => x.type === 'result'), 'state is re-sent before the held result')
  assert.ok(m.some((x) => x.type === 'wallet' && x.accounts[0] === me.address.toLowerCase()))
})

test('bridge: a second bridge tab takes over (replaced); the first stops reconnecting instead of fighting', { skip: !enabled }, async () => {
  const second = await b.bridgePage()
  const flips = []
  await page.exposeFunction('__flip', (t) => flips.push(t))
  await page.evaluate(() => new MutationObserver(() => window.__flip(document.getElementById('extension').textContent))
    .observe(document.getElementById('extension'), { childList: true, characterData: true, subtree: true }))
  await second.waitForTimeout(3000)
  assert.match(await page.locator('#extension').textContent(), /another tab/)
  assert.match(await second.locator('#extension').textContent(), /Connected to the Blindfold extension/)
  assert.ok(flips.length <= 1, `first tab kept changing: ${flips}`)
  await second.close()
})
