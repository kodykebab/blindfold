// The extension side of bridge protocol v1 (INTERFACES.md): origin check, send format, sent-before-result, failures.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bridge } from '../src/bridge.mjs'
import { fakePort } from './port.mjs'

const ORIGIN = 'http://localhost:4317'
const call = { from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', to: '0x5FbDB2315678afecb367f032d93F642f64180aa3', data: '0x1234', chain: { chainId: 31337, rpcUrl: 'http://127.0.0.1:8545' } }

test('accepts only blindfold-bridge ports from the configured origin', () => {
  const b = bridge({ origin: ORIGIN })
  for (const p of [fakePort({ name: 'other' }), fakePort({ origin: 'http://127.0.0.1:4317' }), fakePort({ origin: 'https://evil.example' })]) {
    b.accept(p)
    assert.ok(p.disconnected)
  }
  assert.equal(b.connected(), false)
  assert.throws(() => b.send(call), /no bridge page connected; open http:\/\/localhost:4317\//)
  const good = fakePort()
  b.accept(good)
  assert.ok(!good.disconnected && b.connected())
})

test('wallet messages are passed on; send posts protocol v1 and resolves after onSent finished', async () => {
  const wallet = []
  const b = bridge({ origin: ORIGIN, onWallet: (m) => wallet.push(m.type) })
  const p = fakePort()
  b.accept(p)
  p.emit({ type: 'hello', version: 1 })
  p.emit({ type: 'wallets', wallets: [] })
  p.emit({ type: 'wallet', accounts: [call.from], chainId: '0x7a69' })
  assert.deepEqual(wallet, ['hello', 'wallets', 'wallet'])

  const order = []
  const done = b.send(call, async (hash) => { await new Promise((r) => setTimeout(r, 20)); order.push(`saved ${hash}`) })
  const [m] = p.posted
  assert.deepEqual(m, {
    type: 'send', id: m.id, from: call.from, calls: [{ to: call.to, data: '0x1234', value: '0x0' }],
    chain: { chainId: '0x7a69', chainName: 'Blindfold 31337', rpcUrls: ['http://127.0.0.1:8545'], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } },
  })
  p.emit({ type: 'sent', id: m.id, index: 0, hash: '0xaa' })
  p.emit({ type: 'result', id: m.id, ok: true, atomic: false, hashes: ['0xaa'], receipts: [] })
  const r = await done
  order.push('resolved')
  assert.deepEqual(order, ['saved 0xaa', 'resolved'])
  assert.deepEqual(r.hashes, ['0xaa'])
})

test('a wallet error rejects with its code; a dropped port rejects what is pending', async () => {
  const b = bridge({ origin: ORIGIN })
  const p = fakePort()
  b.accept(p)
  const rejected = b.send(call)
  p.emit({ type: 'result', id: p.posted[0].id, ok: false, error: { code: 4001, message: 'User rejected' }, hashes: [], receipts: [] })
  await assert.rejects(rejected, (e) => e.code === 4001 && /User rejected/.test(e.message))
  const lost = b.send(call)
  p.drop()
  await assert.rejects(lost, /bridge page disconnected/)
  assert.equal(b.connected(), false)
})

test('a newer bridge page replaces the old one and fails its pending request', async () => {
  const b = bridge({ origin: ORIGIN })
  const first = fakePort()
  b.accept(first)
  const pending = b.send(call)
  b.accept(fakePort())
  assert.ok(first.disconnected)
  assert.deepEqual(first.posted.at(-1), { type: 'replaced' }) // so the old tab stops reconnecting
  await assert.rejects(pending, /disconnected/)
  assert.ok(b.connected())
})
