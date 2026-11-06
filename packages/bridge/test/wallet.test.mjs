import { test } from 'node:test'
import assert from 'node:assert/strict'
import { atomicSupport, discover, ensureChain, sendCalls } from '../public/wallet.mjs'
import { ACCOUNT, mockProvider, walletLike } from './mock-provider.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fast = { interval: 1, timeout: 1000 }
const CHAIN = { chainId: '0x7a69', chainName: 'Anvil', rpcUrls: ['http://127.0.0.1:8563'], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }
const CALLS = [{ to: `0x${'11'.repeat(20)}`, data: '0x095ea7b3' }, { to: `0x${'22'.repeat(20)}`, data: '0x47e7ef24' }]
const announce = (win, info, provider) => win.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))

test('wallets: EIP-6963 discovery asks, takes each wallet once, drops bad entries and non-data icons', async () => {
  const win = new EventTarget()
  let asked = 0
  win.addEventListener('eip6963:requestProvider', () => asked++)
  const found = []
  discover(win, (w) => found.push(w), { legacyAfter: 5 })
  assert.equal(asked, 1)
  const p = mockProvider()
  announce(win, { uuid: 'u1', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' }, p)
  announce(win, { uuid: 'u1', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' }, p)
  announce(win, { uuid: 'u2', name: 'Evil', icon: 'https://evil.example/x.png', rdns: 'x.evil' }, p)
  announce(win, { uuid: 'u3', name: 'No provider' }, {})
  assert.deepEqual(found.map((w) => w.info), [
    { uuid: 'u1', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' },
    { uuid: 'u2', name: 'Evil', icon: '', rdns: 'x.evil' },
  ])
  assert.equal(found[0].provider, p)
})

test('wallets: legacy window.ethereum only when nobody announces', async () => {
  const legacy = new EventTarget()
  legacy.ethereum = mockProvider()
  const a = []
  discover(legacy, (w) => a.push(w), { legacyAfter: 5 })
  await sleep(20)
  assert.deepEqual(a.map((w) => w.info), [{ uuid: 'injected', name: 'Browser wallet', icon: '', rdns: 'injected' }])

  const both = new EventTarget()
  both.ethereum = mockProvider()
  both.addEventListener('eip6963:requestProvider', () => announce(both, { uuid: 'u1', name: 'W', icon: '', rdns: 'w' }, both.ethereum))
  const b = []
  discover(both, (w) => b.push(w), { legacyAfter: 5 })
  await sleep(20)
  assert.deepEqual(b.map((w) => w.info.uuid), ['u1'])
})

test('wallet.atomic: EIP-5792 v2 atomic status, v1 atomicBatch, and no support', async () => {
  for (const [caps, want] of [
    [{ '0x7a69': { atomic: { status: 'supported' } } }, true],
    [{ '0x7a69': { atomic: { status: 'ready' } } }, true],
    [{ '0x0': { atomic: { status: 'supported' } } }, true],
    [{ '0x7a69': { atomicBatch: { supported: true } } }, true],
    [{ '0x7a69': { atomic: { status: 'unsupported' } } }, false],
    [{ '0x1': { atomic: { status: 'supported' } } }, false],
    [{}, false],
  ]) {
    const p = mockProvider({ wallet_getCapabilities: caps })
    assert.equal(await atomicSupport(p, ACCOUNT, '0x7a69'), want, JSON.stringify(caps))
    assert.deepEqual(p.calls[0].params, [ACCOUNT, ['0x7a69']])
  }
  assert.equal(await atomicSupport(mockProvider(), ACCOUNT, '0x7a69'), false) // method unsupported
})

test('send chain: already there, switch, and 4902 then wallet_addEthereumChain', async () => {
  let p = walletLike()
  await ensureChain(p, CHAIN)
  assert.deepEqual(p.methods(), ['eth_chainId'])

  p = walletLike({ chainId: '0x1' })
  await ensureChain(p, CHAIN)
  assert.equal(p.wallet.chainId, '0x7a69')
  assert.ok(!p.methods().includes('wallet_addEthereumChain'))

  p = walletLike({ chainId: '0x1', known: ['0x1'] })
  await ensureChain(p, CHAIN)
  assert.deepEqual(p.methods(), ['eth_chainId', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain', 'eth_chainId'])
  assert.deepEqual(p.calls[2].params, [CHAIN])
})

test('send chain: user rejects the switch (4001), or the wallet stays put (WRONG_CHAIN)', async () => {
  const p = walletLike({ chainId: '0x1' })
  p.handlers.wallet_switchEthereumChain = () => { throw { code: 4001, message: 'rejected' } }
  await assert.rejects(ensureChain(p, CHAIN), { code: 4001 })
  p.handlers.wallet_switchEthereumChain = null
  await assert.rejects(ensureChain(p, CHAIN), { code: 'WRONG_CHAIN' })
})

test('send sequential: one transaction at a time, each mined before the next, with chainId', async () => {
  const p = walletLike({ minedAfter: 2 })
  const sent = []
  const r = await sendCalls(p, { from: ACCOUNT, chainId: '0x7a69', calls: CALLS, atomic: false }, { ...fast, onSent: (s) => sent.push(s) })
  assert.equal(r.atomic, false)
  assert.equal(r.hashes.length, 2)
  assert.deepEqual(r.receipts.map((x) => x.status), ['0x1', '0x1'])
  assert.deepEqual(sent, [{ index: 0, hash: r.hashes[0] }, { index: 1, hash: r.hashes[1] }])
  assert.deepEqual(p.methods(), ['eth_sendTransaction', 'eth_getTransactionReceipt', 'eth_getTransactionReceipt', 'eth_getTransactionReceipt',
    'eth_sendTransaction', 'eth_getTransactionReceipt', 'eth_getTransactionReceipt', 'eth_getTransactionReceipt'])
  assert.deepEqual(p.wallet.sent[0], { from: ACCOUNT, chainId: '0x7a69', ...CALLS[0] })
})

test('send sequential: a revert stops the rest; a rejection keeps what was already sent', async () => {
  let p = walletLike({ revert: [0] })
  await assert.rejects(sendCalls(p, { from: ACCOUNT, chainId: '0x7a69', calls: CALLS }, fast), (e) => {
    assert.equal(e.code, 'REVERTED')
    assert.equal(e.hashes.length, 1)
    assert.equal(e.receipts[0].status, '0x0')
    return true
  })
  assert.equal(p.wallet.sent.length, 1)

  p = walletLike()
  const send = p.handlers.eth_sendTransaction
  p.handlers.eth_sendTransaction = (params) => { if (p.wallet.sent.length) throw { code: 4001, message: 'User rejected' }; return send(params) }
  await assert.rejects(sendCalls(p, { from: ACCOUNT, chainId: '0x7a69', calls: CALLS }, fast), (e) => {
    assert.deepEqual([e.code, e.hashes.length, e.receipts.length], [4001, 1, 1])
    return true
  })
})

test('send sequential: TIMEOUT when nothing is mined', async () => {
  const p = walletLike({ minedAfter: Infinity })
  await assert.rejects(sendCalls(p, { from: ACCOUNT, chainId: '0x7a69', calls: CALLS.slice(0, 1) }, { interval: 1, timeout: 10 }),
    (e) => e.code === 'TIMEOUT' && e.hashes.length === 1)
})

test('send atomic: wallet_sendCalls v2 with atomicRequired, then wallet_getCallsStatus until final', async () => {
  const p = walletLike({ atomic: 'supported' })
  let n = 0
  p.handlers.wallet_getCallsStatus = () => (++n < 3 ? { status: 100 } : { status: 200, receipts: [{ transactionHash: '0xbb', status: '0x1' }] })
  const sent = []
  const r = await sendCalls(p, { from: ACCOUNT, chainId: '0x7a69', calls: CALLS, atomic: true }, { ...fast, onSent: (s) => sent.push(s) })
  assert.deepEqual(r, { atomic: true, hashes: ['0xbb'], receipts: [{ transactionHash: '0xbb', status: '0x1' }] })
  assert.deepEqual(sent, [{ callsId: 'batch-1' }])
  assert.deepEqual(p.wallet.batch, { version: '2.0.0', chainId: '0x7a69', from: ACCOUNT, atomicRequired: true, calls: CALLS })
  assert.ok(!p.methods().includes('eth_sendTransaction'))
})

test('send atomic: v1 string id and CONFIRMED; a failed batch is REVERTED', async () => {
  const p = walletLike({ atomic: 'supported' })
  p.handlers.wallet_sendCalls = () => 'v1-id'
  p.handlers.wallet_getCallsStatus = ([id]) => ({ status: 'CONFIRMED', receipts: [{ transactionHash: `0x${id.length}`, status: '0x1' }] })
  assert.deepEqual((await sendCalls(p, { from: ACCOUNT, chainId: '0x7a69', calls: CALLS, atomic: true }, fast)).hashes, ['0x5'])
  p.handlers.wallet_getCallsStatus = { status: 500, receipts: [{ transactionHash: '0xbb', status: '0x0' }] }
  await assert.rejects(sendCalls(p, { from: ACCOUNT, chainId: '0x7a69', calls: CALLS, atomic: true }, fast), (e) => e.code === 'REVERTED' && e.hashes[0] === '0xbb')
})

test('send atomic: falls back to one by one when the wallet cannot batch, not when the user rejects', async () => {
  for (const code of [4200, -32601, 5700, 5710, 5740, 5750, 5760]) {
    const p = walletLike({ atomic: 'supported' })
    p.handlers.wallet_sendCalls = () => { throw { code, message: 'no' } }
    const r = await sendCalls(p, { from: ACCOUNT, chainId: '0x7a69', calls: CALLS, atomic: true }, fast)
    assert.equal(r.atomic, false, String(code))
    assert.equal(p.wallet.sent.length, 2)
  }
  const p = walletLike({ atomic: 'supported' })
  p.handlers.wallet_sendCalls = () => { throw { code: 4001, message: 'User rejected' } }
  await assert.rejects(sendCalls(p, { from: ACCOUNT, chainId: '0x7a69', calls: CALLS, atomic: true }, fast), { code: 4001 })
  assert.ok(!p.methods().includes('eth_sendTransaction'))
})

test('send atomic: a successful response without a usable ID never resends the calls', async () => {
  for (const response of [undefined, null, {}, { id: '' }, { id: 123 }, '', '   ']) {
    const p = walletLike({ atomic: 'supported' })
    p.handlers.wallet_sendCalls = () => { p.wallet.sent.push(...CALLS); return response }
    await assert.rejects(
      sendCalls(p, { from: ACCOUNT, chainId: '0x7a69', calls: CALLS, atomic: true }, fast),
      (e) => e.code === 'UNKNOWN_OUTCOME' && /check the wallet before retrying/.test(e.message),
    )
    assert.deepEqual(p.methods(), ['wallet_sendCalls'])
    assert.equal(p.wallet.sent.length, CALLS.length) // the mock accepted the batch once
  }
})
