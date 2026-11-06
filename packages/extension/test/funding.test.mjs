import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeFunctionData, getAddress } from 'viem'
import { flows } from '../src/flows.mjs'
import { abi, dep, mockChain, owner, T0 } from './mock.mjs'

const value = 10n ** 18n
const hash = `0x${'ab'.repeat(32)}`
function setup(allowance = 0n) {
  const pub = mockChain({ reads: { allowance } })
  const sent = []
  const ctx = { dep, abi, owner, pub, sendTx: async (tx) => { sent.push(tx); return hash } }
  return { f: flows(ctx), sent, pub }
}

test('deposit sends approval and deposit together and only simulates the independent approval', async () => {
  const { f, sent, pub } = setup()
  await f.deposit('token0', '1')
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].calls.map((c) => c.to), [T0, dep.vault])
  assert.deepEqual(sent[0].calls.map((c, i) => decodeFunctionData({ abi: i ? abi.vault : abi.erc20, data: c.data })), [
    { functionName: 'approve', args: [dep.vault, value] },
    { functionName: 'deposit', args: [getAddress(T0), value] },
  ])
  assert.deepEqual(pub.simulated, ['approve'])
})

test('deposit with sufficient allowance simulates and sends only deposit', async () => {
  const { f, sent, pub } = setup(value)
  await f.deposit('token0', '1')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].to, dep.vault)
  assert.equal(sent[0].calls, undefined)
  assert.deepEqual(pub.simulated, ['deposit'])
})

test('an approval simulation failure stops the wallet request', async () => {
  const { f, sent, pub } = setup()
  pub.simulateContract = async () => { throw new Error('approval refused') }
  await assert.rejects(f.deposit('token0', '1'), /approval refused/)
  assert.deepEqual(sent, [])
})

test('commit uses the same batched funding path before encryption and submission', async () => {
  const { f, sent, pub } = setup()
  pub.table.admissionRequired = false
  pub.table.freeBalance = () => 0n
  pub.table.balanceOf = () => 100n * value
  // Stop after funding: this checks the commit's shortfalls without manufacturing a commitment receipt.
  await assert.rejects(f.commit({ side: 'sell', amountIn: '1', minOut: '0.5' }), /encrypt/)
  assert.equal(sent.length, 2)
  for (const tx of sent) assert.equal(tx.calls.length, 2)
  assert.deepEqual(pub.simulated, ['approve', 'approve'])
})
