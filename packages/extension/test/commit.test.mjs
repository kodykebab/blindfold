// Commit and admission flows: private state is saved before the transaction that depends on it, the sent hash before
// it is mined, and the funding opening is reconciled with admissionState(owner) afterwards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bytesToHex, decodeAbiParameters, decodeFunctionData, keccak256 } from 'viem'
import { flows } from '../src/flows.mjs'
import { orderHash } from '../src/core.mjs'
import { stateStore } from '../src/vault.mjs'
import { initialFunding, nextFunding, ZERO } from '../../client/admission-state.mjs'
import { abi, committedLog, dep, memoryArea, mockChain, owner } from './mock.mjs'

const TX = `0x${'ab'.repeat(32)}`

async function setup({ admission = true, prove } = {}) {
  const pub = mockChain()
  if (!admission) pub.table.admissionRequired = false
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const states = stateStore(memoryArea(), key)
  const store = { load: () => states.load(dep, owner), write: (s) => states.write(dep, owner, s) }
  const seen = { sent: [], checks: [] }
  const d = admission ? dep : { ...dep, admission: 'off' }
  let f
  const ctx = {
    dep: d, abi, owner, pub, store,
    prove: prove ?? (async ({ request: r }) => {
      seen.request = r
      const o = { owner: r.owner, zeroForOne: r.zeroForOne, amountIn: BigInt(r.amount), minAmountOut: BigInt(r.minimum) }
      const newBlind = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
      const next = (seen.next = nextFunding(dep, owner, initialFunding(), BigInt(r.batch), o, newBlind))
      return { ciphertext: '0xdead', ciphertextHash: keccak256('0xdead'), newBlind, oldRoot: ZERO, newRoot: next.root, orderHash: orderHash(r.chainId, r.settlement, BigInt(r.batch), o, r.salt),
        preparation: { seal: '0x01', journal: '0x02' }, online: { seal: '0x03', journal: '0x04' } }
    }),
    tlock: { encrypt: async () => '0xbeef', check: async (...a) => seen.checks.push(a) },
    async sendTx(tx, record) {
      const { functionName, args } = decodeFunctionData({ abi: abi.settlement, data: tx.data })
      seen.sent.push({ functionName, args, record, before: await store.load() })
      await f.recordSent(record, TX) // the worker does this on the bridge's `sent`
      seen.afterSent = await store.load()
      const hash = args[1]
      if (functionName === 'admit') pub.table.admissionState = [3n, seen.next.root, 1n] // mined
      pub.receipts[TX] = { status: 'success', logs: [committedLog({ commitId: 9n, batchId: 3n, hash })] }
      return TX
    },
  }
  f = flows(ctx)
  return { f, ctx, seen, store, pub }
}

test('admission: proof request, ciphertext check, pending saved before admit, hash saved before mining, reconciled after', async () => {
  const s = await setup()
  const r = await s.f.commit({ side: 'sell', amountIn: '1', minOut: '0.5' })
  const req = s.seen.request
  assert.deepEqual([req.chainId, req.batch, req.round, req.step, req.totals, req.oldBlind], ['31337', '3', '42', '0', ['0', '0'], ZERO])
  assert.deepEqual(req.budgets, [String(100n * 10n ** 18n), String(100n * 10n ** 18n - 6n)]) // deposit + fee leave token1's budget
  assert.equal(s.seen.checks.length, 1)
  assert.deepEqual(s.seen.checks[0].slice(0, 2), ['0xdead', 42n])

  const [admit] = s.seen.sent
  assert.equal(admit.functionName, 'admit')
  assert.equal(admit.record.kind, 'admit')
  const [batch, hash, ciphertext, proof] = admit.args
  assert.deepEqual([batch, ciphertext], [3n, '0xdead'])
  assert.deepEqual(decodeAbiParameters(Array(4).fill({ type: 'bytes' }), proof), ['0x01', '0x02', '0x03', '0x04'])
  // before the wallet saw it: the order, salt and pending transition were already durable
  const before = admit.before
  assert.equal(before.commitments[0].hash, hash)
  assert.equal(orderHash(dep.chainId, dep.settlement, 3n, before.commitments[0].order, before.commitments[0].salt), hash)
  assert.equal(before.admission.pending.hash, hash)
  assert.equal(before.admission.pending.tx, undefined)
  assert.equal(s.seen.afterSent.admission.pending.tx, TX) // persisted when sent, before mined

  const after = await s.store.load()
  assert.deepEqual(r.admitted, 9n)
  assert.deepEqual([after.commitments[0].id, after.commitments[0].tx], [9n, TX])
  assert.equal(after.admission.pending, undefined)
  assert.deepEqual([after.admission.step, after.admission.root, after.admission.totals], [1n, s.seen.next.root, [10n ** 18n, 0n]])
})

test('admission: a prover that disagrees on the transition stops before anything is saved or sent', async () => {
  const s = await setup({ prove: async () => ({ ciphertext: '0xdead', newBlind: `0x${'01'.repeat(32)}`, oldRoot: ZERO, newRoot: `0x${'02'.repeat(32)}`, orderHash: ZERO, preparation: {}, online: {} }) })
  await assert.rejects(s.f.commit({ side: 'buy', amountIn: '1', minOut: '1' }), /disagree/)
  assert.deepEqual(s.seen.sent, [])
  assert.equal((await s.store.load()).admission.pending, undefined)
})

test('admission: the worker dies after the wallet sent admit; resume waits for that hash and sends nothing new', async () => {
  const s = await setup()
  s.ctx.sendTx = async (tx, record) => { await s.f.recordSent(record, TX); throw new Error('bridge page disconnected') }
  await assert.rejects(s.f.commit({ side: 'sell', amountIn: '1', minOut: '0.5' }), /disconnected/)
  const saved = await s.store.load()
  assert.equal(saved.admission.pending.tx, TX)
  assert.equal(saved.commitments[0].id, null)
  // a fresh worker: the transaction is mined while it waits for the receipt
  const hash = saved.admission.pending.hash
  s.pub.waitForTransactionReceipt = async () => {
    s.pub.table.admissionState = [3n, saved.admission.pending.next.root, 1n]
    return { status: 'success', logs: [committedLog({ commitId: 9n, batchId: 3n, hash })] }
  }
  const again = flows({ ...s.ctx, sendTx: async () => assert.fail('resume must not send again') })
  assert.deepEqual(await again.resumeAdmission(), { admitted: 9n, tx: TX })
  const after = await s.store.load()
  assert.equal(after.commitments[0].id, 9n)
  assert.equal(after.admission.pending, undefined)
  assert.equal(after.admission.step, 1n)
  assert.match((await again.resumeAdmission()).resumed, /matches the chain/) // idempotent
})

test('without admission: the order is saved before commit is sent, its hash when sent, its id when mined', async () => {
  const s = await setup({ admission: false })
  const r = await s.f.commit({ side: 'buy', amountIn: '2', minOut: '1' })
  const [c] = s.seen.sent
  assert.equal(c.functionName, 'commit')
  assert.deepEqual(c.args.slice(0, 1).concat(c.args.slice(2)), [3n, '0xbeef'])
  assert.equal(c.before.commitments[0].hash, c.args[1])
  assert.equal(c.before.commitments[0].tx, undefined)
  assert.equal(s.seen.afterSent.commitments[0].tx, TX)
  assert.deepEqual(s.seen.checks[0], ['0xbeef', 42n, s.seen.checks[0][2]]) // the ciphertext is checked before sending
  assert.equal(r.committed, 9n)
  assert.equal((await s.store.load()).commitments[0].id, 9n)
})

test('recordSent saves only into the commitment or pending admission it names', async () => {
  const s = await setup()
  await s.store.write({ chainId: 31337, settlement: dep.settlement, owner, commitments: [{ id: null, hash: '0x01' }], admission: { pending: { hash: '0x02' } } })
  await s.f.recordSent({ kind: 'commit', hash: '0x01' }, TX)
  await s.f.recordSent({ kind: 'admit', hash: '0x02' }, TX)
  await s.f.recordSent({ kind: 'commit', hash: '0x09' }, TX) // unknown: ignored, nothing invented
  await s.f.recordSent({ kind: 'admit', hash: '0x09' }, '0xff')
  const st = await s.store.load()
  assert.deepEqual(st.commitments, [{ id: null, hash: '0x01', tx: TX }])
  assert.deepEqual(st.admission.pending, { hash: '0x02', tx: TX })
})
