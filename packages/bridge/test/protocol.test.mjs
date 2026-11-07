// One test per row of INTERFACES.md "Extension <-> bridge page".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBridge } from '../public/protocol.mjs'
import { ACCOUNT, walletLike } from './mock-provider.mjs'

const CHAIN = { chainId: '0x7a69', chainName: 'Anvil', rpcUrls: ['http://127.0.0.1:8563'], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }
const CALLS = [{ to: `0x${'11'.repeat(20)}`, data: '0x095ea7b3' }, { to: `0x${'22'.repeat(20)}`, data: '0x47e7ef24', value: '0x0' }]
const SEND = { type: 'send', id: 'r1', from: ACCOUNT, chain: CHAIN, calls: CALLS }
const INFO = { uuid: 'u1', name: 'Test wallet', icon: '', rdns: 'xyz.blindfold.testwallet' }
const SIGNING = /sign/i // personal_sign, eth_sign, eth_signTypedData*: the bridge must never ask

async function setup(wallet = walletLike(), { connect = true } = {}) {
  const out = []
  const b = createBridge({ post: (m) => out.push(m), opts: { interval: 1, timeout: 1000 } })
  b.add({ info: INFO, provider: wallet })
  if (connect) await b.onMessage({ type: 'connect', uuid: 'u1' })
  out.length = 0
  return { b, out, wallet, last: () => out.at(-1) }
}
const settle = () => new Promise((r) => setTimeout(r, 10))

test('hello, wallets and wallet after every (re)connect', async () => {
  const { b, out } = await setup()
  b.sync()
  assert.deepEqual(out, [
    { type: 'hello', version: 1 },
    { type: 'wallets', wallets: [INFO] },
    { type: 'wallet', uuid: 'u1', name: 'Test wallet', rdns: INFO.rdns, accounts: [ACCOUNT], chainId: '0x7a69', atomic: false },
  ])
})

test('wallets: sent whenever a wallet is added', async () => {
  const { b, out } = await setup()
  b.add({ info: { ...INFO, uuid: 'u2', rdns: 'other' }, provider: walletLike() })
  assert.deepEqual(out, [{ type: 'wallets', wallets: [INFO, { ...INFO, uuid: 'u2', rdns: 'other' }] }])
})

test('connect by uuid or rdns: eth_requestAccounts, then wallet with atomic support', async () => {
  const w = walletLike({ atomic: 'supported' })
  const { b, out } = await setup(w, { connect: false })
  await b.onMessage({ type: 'connect', rdns: INFO.rdns })
  assert.equal(w.methods()[0], 'eth_requestAccounts')
  assert.deepEqual(out.at(-1), { type: 'wallet', uuid: 'u1', name: 'Test wallet', rdns: INFO.rdns, accounts: [ACCOUNT], chainId: '0x7a69', atomic: true })
})

test('error: unknown wallet, rejected connection, unknown type, send without an id', async () => {
  const w = walletLike()
  const { b, out } = await setup(w, { connect: false })
  await b.onMessage({ type: 'connect', uuid: 'nope' })
  w.handlers.eth_requestAccounts = () => { throw { code: 4001, message: 'User rejected the request.' } }
  await b.onMessage({ type: 'connect', uuid: 'u1' })
  await b.onMessage({ type: 'sign', data: '0x' })
  await b.onMessage({ ...SEND, id: undefined })
  await b.onMessage(null)
  assert.deepEqual(out.map((m) => [m.type, m.error.code]), [['error', 'NO_WALLET'], ['error', 4001], ['error', 'BAD_REQUEST'], ['error', 'BAD_REQUEST'], ['error', 'BAD_REQUEST']])
})

test('wallet: accountsChanged, chainChanged and disconnect re-send the wallet state', async () => {
  const { out, wallet } = await setup()
  wallet.wallet.accounts = [`0x${'b2'.repeat(20)}`]
  wallet.emit('accountsChanged', wallet.wallet.accounts)
  await settle()
  assert.deepEqual(out.at(-1).accounts, [`0x${'b2'.repeat(20)}`])
  wallet.wallet.chainId = '0x1'
  wallet.emit('chainChanged', '0x1')
  await settle()
  assert.equal(out.at(-1).chainId, '0x1')
  wallet.handlers.eth_accounts = () => { throw { code: 4900, message: 'disconnected' } }
  wallet.emit('disconnect')
  await settle()
  assert.deepEqual(out.at(-1).accounts, [])
})

test('wallet: events from a wallet that is no longer selected are ignored', async () => {
  const old = walletLike()
  const { b, out } = await setup(old)
  b.add({ info: { ...INFO, uuid: 'u2' }, provider: walletLike() })
  await b.onMessage({ type: 'connect', uuid: 'u2' })
  out.length = 0
  old.emit('accountsChanged', [])
  await settle()
  assert.deepEqual(out, [])
})

test('send -> sent per transaction, then result with receipts (sequential)', async () => {
  const { b, out, wallet } = await setup()
  await b.onMessage(SEND)
  assert.deepEqual(out.map((m) => m.type), ['sent', 'sent', 'result'])
  assert.deepEqual(out[0], { type: 'sent', id: 'r1', index: 0, hash: `0x${'0'.repeat(63)}1` })
  const r = out[2]
  assert.deepEqual([r.id, r.ok, r.atomic, r.hashes.length, r.receipts.length], ['r1', true, false, 2, 2])
  assert.deepEqual(wallet.wallet.sent[1], { from: ACCOUNT, chainId: '0x7a69', ...CALLS[1] })
  assert.ok(!wallet.methods().some((m) => SIGNING.test(m)))
})

test('send -> sent with callsId, then result (atomic, EIP-5792)', async () => {
  const { b, out, wallet } = await setup(walletLike({ atomic: 'supported' }))
  await b.onMessage(SEND)
  assert.deepEqual(out.map((m) => m.type), ['sent', 'result'])
  assert.deepEqual(out[0], { type: 'sent', id: 'r1', callsId: 'batch-1' })
  assert.deepEqual([out[1].ok, out[1].atomic, out[1].hashes], [true, true, [`0x${'b'.repeat(64)}`]])
  assert.ok(!wallet.methods().includes('eth_sendTransaction'))
  // a single call never batches
  out.length = 0
  await b.onMessage({ ...SEND, id: 'r2', calls: CALLS.slice(0, 1) })
  assert.deepEqual(out.map((m) => m.type), ['sent', 'result'])
  assert.equal(out[1].atomic, false)
})

test('result BAD_REQUEST: invalid from, chain, calls, data or value; nothing reaches the wallet', async () => {
  const { b, out, wallet } = await setup()
  const n = wallet.calls.length
  const bad = [
    { from: '0x1234' },
    { chain: { ...CHAIN, chainId: '31337' } },
    { chain: { ...CHAIN, rpcUrls: [] } },
    { chain: { ...CHAIN, nativeCurrency: { name: 'Ether', symbol: 'ETH' } } },
    { calls: [] },
    { calls: Array(9).fill(CALLS[0]) },
    { calls: [{ to: CALLS[0].to, data: '0x123' }] },
    { calls: [{ to: CALLS[0].to, data: `0x${'00'.repeat(128 * 1024 + 1)}` }] },
    { calls: [{ ...CALLS[0], value: '0x01' }] },
    { calls: [{ ...CALLS[0], to: 'vault' }] },
  ]
  for (const [i, patch] of bad.entries()) await b.onMessage({ ...SEND, id: `bad${i}`, ...patch })
  assert.deepEqual(out.map((m) => [m.type, m.id, m.ok, m.error.code]), bad.map((_, i) => ['result', `bad${i}`, false, 'BAD_REQUEST']))
  assert.equal(wallet.calls.length, n)
  // extra fields never reach the wallet
  out.length = 0
  await b.onMessage({ ...SEND, calls: [{ ...CALLS[0], gas: '0x1', from: `0x${'66'.repeat(20)}` }] })
  assert.deepEqual(wallet.wallet.sent.at(-1), { from: ACCOUNT, chainId: '0x7a69', ...CALLS[0] })
})

test('result NO_WALLET, WRONG_ACCOUNT, BUSY', async () => {
  let { b, out } = await setup(walletLike(), { connect: false })
  await b.onMessage(SEND)
  assert.equal(out[0].error.code, 'NO_WALLET')

  ;({ b, out } = await setup(walletLike({ accounts: [`0x${'b2'.repeat(20)}`] })))
  await b.onMessage(SEND)
  assert.equal(out[0].error.code, 'WRONG_ACCOUNT')

  const slow = walletLike({ minedAfter: 20 })
  ;({ b, out } = await setup(slow))
  const first = b.onMessage(SEND)
  await b.onMessage({ ...SEND, id: 'r2' })
  await first
  const results = out.filter((m) => m.type === 'result')
  assert.deepEqual(results.map((m) => [m.id, m.ok, m.error?.code]), [['r2', false, 'BUSY'], ['r1', true, undefined]])
})

test('result WRONG_CHAIN and 4001 on switch: refused before anything is signed; 4902 adds the chain', async () => {
  let w = walletLike({ chainId: '0x1' })
  w.handlers.wallet_switchEthereumChain = () => { throw { code: 4001, message: 'User rejected the request.' } }
  let { b, out } = await setup(w)
  await b.onMessage(SEND)
  assert.deepEqual([out[0].type, out[0].error.code], ['result', 4001])
  assert.equal(w.wallet.sent.length, 0)

  w = walletLike({ chainId: '0x1' })
  w.handlers.wallet_switchEthereumChain = null // claims success, stays on 0x1
  ;({ b, out } = await setup(w))
  await b.onMessage(SEND)
  assert.equal(out[0].error.code, 'WRONG_CHAIN')
  assert.equal(w.wallet.sent.length, 0)

  w = walletLike({ chainId: '0x1', known: ['0x1'] })
  ;({ b, out } = await setup(w))
  await b.onMessage(SEND)
  assert.ok(w.methods().includes('wallet_addEthereumChain'))
  assert.equal(out.at(-1).ok, true)
})

test('result REVERTED and user rejection carry what was already sent', async () => {
  const { b, out } = await setup(walletLike({ revert: [1] }))
  await b.onMessage(SEND)
  const r = out.at(-1)
  assert.deepEqual([r.ok, r.error.code, r.hashes.length, r.receipts.map((x) => x.status)], [false, 'REVERTED', 2, ['0x1', '0x0']])
})
