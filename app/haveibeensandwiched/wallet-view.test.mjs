import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWalletView, walletMismatch } from './wallet-view.mjs'

const account = '0x1111111111111111111111111111111111111111'
test('wallet inspection responds to account and chain changes without requesting signatures', async () => {
  const listeners = new Map(), calls = []
  let accounts = [account], chainId = '0x7a69'
  const provider = { request: async ({ method }) => { calls.push(method); if (method === 'eth_requestAccounts' || method === 'eth_accounts') return accounts; if (method === 'eth_chainId') return chainId; throw Error('unexpected request') },
    on: (name, handler) => listeners.set(name, handler), removeListener: (name) => listeners.delete(name) }
  const win = new EventTarget(); win.ethereum = provider
  let state
  const wallet = createWalletView(win, (value) => { state = value })
  assert.equal(state.wallets.length, 1)
  await wallet.connect('injected')
  assert.equal(state.selected.account, account)
  assert.equal(walletMismatch(state.selected, { account, network: 'network 31337' }), null)
  chainId = '0x1'; listeners.get('chainChanged')()
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(walletMismatch(state.selected, { account, network: 'network 31337' }), /network differ/)
  accounts = []; listeners.get('accountsChanged')()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(state.selected, null)
  assert.ok(calls.every((method) => ['eth_requestAccounts', 'eth_accounts', 'eth_chainId'].includes(method)))
  wallet.close()
})
test('a different or unchecked CLI account blocks guarded actions', () => {
  const wallet = { account, chainId: '0x7a69' }
  assert.match(walletMismatch(wallet, null), /Load CLI/)
  assert.match(walletMismatch(wallet, { account: '0x2222222222222222222222222222222222222222', network: 'network 31337' }), /account differ/)
})
