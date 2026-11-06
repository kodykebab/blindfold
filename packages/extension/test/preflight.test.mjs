// U2: the commit flow's preflight refuses missing funding, approval, fee, past deadlines and the one-active-batch rule
// before any proving, encryption or transaction.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flows } from '../src/flows.mjs'
import { abi, dep, memoryArea, mockChain, owner, T0, T1 } from './mock.mjs'
import { stateStore } from '../src/vault.mjs'

const E18 = 10n ** 18n
async function setup(chainOpts = {}, { admission = true } = {}) {
  const pub = mockChain(chainOpts)
  if (!admission) pub.table.admissionRequired = false
  const calls = []
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const states = stateStore(memoryArea(), key)
  const ctx = {
    dep: admission ? dep : { ...dep, admission: 'off' }, abi, owner, pub,
    store: { load: () => states.load(dep, owner), write: (s) => states.write(dep, owner, s) },
    prove: async () => { calls.push('prove'); throw new Error('stop after preflight') },
    tlock: { encrypt: async () => { calls.push('encrypt'); throw new Error('stop after preflight') }, check: async () => calls.push('check') },
    sendTx: async (tx) => { calls.push(tx.to); return `0x${'aa'.repeat(32)}` },
  }
  return { f: flows(ctx), calls, pub }
}
const order = { side: 'sell', amountIn: '1', minOut: '0.9' }

test('U2 funded order passes preflight', async () => {
  const { f, calls } = await setup()
  const r = await f.commit({ ...order, dryRun: true })
  assert.ok(r.ok, r.problems.join())
  assert.deepEqual(calls, [])
  await assert.rejects(f.commit(order), /stop after preflight/) // passes preflight, reaches the prover
})

test('U2 missing funding: refused before proving or any transaction', async () => {
  const { f, calls } = await setup({ reads: { freeBalance: () => 0n } })
  await assert.rejects(f.commit(order), /not enough TK0|not enough 0x0+a00/i)
  assert.deepEqual(calls, [])
})

test('U2 fee: the deposit alone fits but deposit + fee does not', async () => {
  const { f, calls } = await setup({ reads: { freeBalance: ([, t]) => (t === T1 ? 5n : 10n * E18) } })
  const r = await f.commit({ ...order, dryRun: true })
  assert.ok(!r.ok)
  assert.match(r.problems.join(), /need 6, vault free 5/)
  await assert.rejects(f.commit(order), /preflight failed/)
  assert.deepEqual(calls, [])
})

test('U2 approval: a wallet-funded shortfall is approved and deposited before any proving', async () => {
  const { f, calls } = await setup({ reads: { freeBalance: () => 0n, balanceOf: () => 10n * E18, allowance: () => 0n } })
  const r = await f.commit({ ...order, dryRun: true })
  assert.ok(r.ok, r.problems.join())
  assert.match(r.funding.join('\n'), /needs approval/)
  await assert.rejects(f.commit(order), /stop after preflight/)
  // approve + deposit per token, all before the prover is asked
  assert.deepEqual(calls, [T0, dep.vault, T1, dep.vault, 'prove'])
})

test('U2 deadlines: a closed or closing batch is refused', async () => {
  for (const reads of [{ currentBatch: 3n, commitsClose: 1200n }]) {
    const near = await setup({ reads, now: 1150n }) // admission needs 60 s of lead for proving
    assert.match((await near.f.commit({ ...order, dryRun: true })).problems.join(), /closes in 50s/)
    await assert.rejects(near.f.commit(order), /preflight failed/)
    assert.deepEqual(near.calls, [])
  }
  const plain = await setup({ now: 1198n }, { admission: false })
  assert.match((await plain.f.commit({ ...order, dryRun: true })).problems.join(), /closes in 2s/)
  const full = await setup({ reads: { commitIdsOf: Array(64).fill(0n) } })
  assert.match((await full.f.commit({ ...order, dryRun: true })).problems.join(), /full/)
})

test('U2 one active batch per account: an open commitment in an earlier batch blocks a new one', async () => {
  const events = [{ eventName: 'Committed', args: { commitId: 7n, batchId: 2n, committer: owner, round: 9n, hash: `0x${'01'.repeat(32)}` } }]
  const { f, calls } = await setup({ events })
  const r = await f.commit({ ...order, dryRun: true })
  assert.match(r.problems.join(), /open commitments in batch 2: one active batch per account/)
  await assert.rejects(f.commit(order), /one active batch/)
  assert.deepEqual(calls, [])
  const same = await setup({ events: [{ ...events[0], args: { ...events[0].args, batchId: 3n } }] })
  assert.ok((await same.f.commit({ ...order, dryRun: true })).ok) // more orders in the same batch are fine
})

test('U2 amounts that do not fit uint128 or lack a minimum are refused', async () => {
  const { f, calls } = await setup({ reads: { freeBalance: () => 1n << 200n } })
  const r = await f.commit({ ...order, amountIn: String(1n << 128n), minOut: '0', dryRun: true })
  assert.match(r.problems.join(), /fit uint128/)
  assert.match((await f.commit({ ...order, minOut: '0', dryRun: true })).problems.join(), /no price protection/)
  assert.deepEqual(calls, [])
})

test('S5: a deployment whose vault is not the settlement\'s, or an RPC on another chain, is refused before any call', async () => {
  const foreign = await setup({ reads: { vault: '0x00000000000000000000000000000000000000ee' } })
  await assert.rejects(foreign.f.deposit('token0', '1'), /is not the settlement's vault/)
  await assert.rejects(foreign.f.commit(order), /is not the settlement's vault/)
  assert.deepEqual(foreign.calls, [])
  const other = await setup()
  other.pub.getChainId = async () => 1
  await assert.rejects(other.f.status(), /RPC serves chain 1, the deployment is for 31337/)
})
