import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { keccak256, parseEther, recoverTypedDataAddress } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { maxPayoutFor, receiptDomain, receiptTypes } from '../lib.mjs'
import { createLeakyRpc } from '../rpc.mjs'

const MNEMONIC = 'test test test test test test test test test test test junk' // anvil's public test accounts
const signer = mnemonicToAccount(MNEMONIC, { addressIndex: 4 })
const user = mnemonicToAccount(MNEMONIC, { addressIndex: 10 })
const ROUTER = '0x' + 'c0'.repeat(20)
const REGISTRY = '0x' + 'e0'.repeat(20)

/** A fake chain: answers a few methods and logs every request it gets. */
async function upstream() {
  const seen = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const { id, method, params } = JSON.parse(body)
    seen.push(method)
    const reply = method === 'eth_blockNumber' ? { result: '0x10' }
      : method === 'eth_chainId' ? { result: '0x7a69' }
      : method === 'eth_sendRawTransaction' && params[0].endsWith('00') ? { error: { code: -32003, message: 'nonce too low' } }
      : method === 'eth_sendRawTransaction' ? { result: keccak256(params[0]) }
      : { error: { code: -32601, message: 'unexpected' } }
    res.end(JSON.stringify({ jsonrpc: '2.0', id, ...reply }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() }
}

const sign = (to, data = '0x1234') =>
  user.signTransaction({ to, data, value: parseEther('10'), nonce: 0, gas: 300_000n, maxFeePerGas: 3n, maxPriorityFeePerGas: 2n, chainId: 31337 })

function leaky(chain, log) {
  return createLeakyRpc({
    upstream: chain.url, signer, registry: REGISTRY, chainId: 31337, now: () => 1_700_000_000,
    cover: async (tx) => (tx.to === ROUTER ? { amountIn: parseEther('10'), quoteOut: parseEther('9.8'), minOut: parseEther('9.5') } : null),
    onLeak: async (raw) => log.push(`leak:${chain.seen.includes('eth_sendRawTransaction') ? 'after' : 'before'} forward`),
    onReceipt: (entry) => log.push(entry),
  })
}

test('signs a receipt before inclusion, leaks the tx, then forwards it', async () => {
  const chain = await upstream()
  const log = []
  const raw = await sign(ROUTER)
  const res = await leaky(chain, log).handle({ jsonrpc: '2.0', id: 7, method: 'eth_sendRawTransaction', params: [raw] })
  chain.close()
  assert.equal(res.result, keccak256(raw), 'the tx was forwarded')
  assert.equal(res.id, 7)
  const [entry, leak] = log
  assert.equal(leak, 'leak:before forward')
  const r = entry.receipt
  assert.equal(r.txHash, keccak256(raw))
  assert.equal(r.chainId, '31337')
  assert.equal(r.acceptedAt, '1700000000')
  assert.equal(r.maxBlock, String(0x10 + 10), 'head + 10 blocks')
  assert.equal(r.beneficiary, user.address, 'the tx sender')
  assert.equal(r.maxPayout, String(maxPayoutFor(parseEther('10'), parseEther('9.8'), parseEther('9.5'))))
  const message = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'txHash' || k === 'beneficiary' ? v : BigInt(v)]))
  const by = await recoverTypedDataAddress({
    domain: receiptDomain(31337, REGISTRY), types: receiptTypes, primaryType: 'Protected', message, signature: entry.sig,
  })
  assert.equal(by, signer.address, 'signed by the bonded RPC key')
})

test('uncovered txs get no receipt but still leak and go through; other methods are proxied', async () => {
  const chain = await upstream()
  const log = []
  const rpc = leaky(chain, log)
  const raw = await sign('0x' + 'dd'.repeat(20))
  const res = await rpc.handle({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] })
  assert.equal(res.result, keccak256(raw))
  assert.deepEqual(log, ['leak:before forward'])
  assert.equal((await rpc.handle({ jsonrpc: '2.0', id: 2, method: 'eth_chainId', params: [] })).result, '0x7a69')
  chain.close()
})

test('an upstream rejection comes back as a JSON-RPC error', async () => {
  const chain = await upstream()
  let raw = await sign(ROUTER, '0x00')
  // the fake rejects raw txs ending in 00; keep signing until the signature ends that way
  for (let i = 1; !raw.endsWith('00'); i++) raw = await sign(ROUTER, '0x' + i.toString(16).padStart(4, '0'))
  const res = await leaky(chain, []).handle({ jsonrpc: '2.0', id: 3, method: 'eth_sendRawTransaction', params: [raw] })
  chain.close()
  assert.deepEqual(res.error, { code: -32003, message: 'nonce too low' })
})

test('a failing leak listener does not stop the tx from going out', async () => {
  const chain = await upstream()
  const rpc = createLeakyRpc({
    upstream: chain.url, signer, registry: REGISTRY, chainId: 31337, cover: async () => null,
    onLeak: async () => { throw new Error('bot crashed') },
  })
  const raw = await sign(ROUTER)
  const res = await rpc.handle({ jsonrpc: '2.0', id: 4, method: 'eth_sendRawTransaction', params: [raw] })
  chain.close()
  assert.equal(res.result, keccak256(raw))
})
