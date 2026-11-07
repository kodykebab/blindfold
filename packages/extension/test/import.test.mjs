// U4: import refuses entries that don't hash right or don't match the chain; exports move between CLI and extension.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flows } from '../src/flows.mjs'
import { orderHash, replacer } from '../src/core.mjs'
import { stateStore } from '../src/vault.mjs'
import { fundingRoot } from '../../client/admission-state.mjs'
import { parseState } from '../../client/state.mjs'
import { abi, dep, memoryArea, mockChain, owner } from './mock.mjs'

const salt = `0x${'03'.repeat(32)}`
const order = { owner, zeroForOne: true, amountIn: 10n ** 18n, minAmountOut: 9n * 10n ** 17n }
const hash = orderHash(dep.chainId, dep.settlement, 3n, order, salt)
const opening = { batch: 3n, step: 1n, totals: [10n ** 18n, 0n], blind: `0x${'cc'.repeat(32)}` }
opening.root = fundingRoot(dep, owner, opening)
const good = { chainId: dep.chainId, settlement: dep.settlement, owner, commitments: [{ id: 4n, batchId: 3n, round: 42n, hash, order, salt }], admission: opening }
const onchain = { commitments: ([id]) => [owner, 3n, 1, id === 4n ? hash : `0x${'00'.repeat(32)}`], admissionState: [3n, opening.root, 1n], openCommitments: 1n }

async function setup(reads = onchain) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const area = memoryArea(), states = stateStore(area, key)
  const store = { load: () => states.load(dep, owner), write: (s) => states.write(dep, owner, s) }
  return { area, store, f: flows({ dep, abi, owner, pub: mockChain({ reads }), store }) }
}
const text = (s) => JSON.stringify(s, replacer)

test('U4 a matching export imports and merges by hash', async () => {
  const { f, store } = await setup()
  await store.write({ ...good, commitments: [{ id: null, batchId: 2n, round: 1n, hash: `0x${'ee'.repeat(32)}`, order, salt }], admission: undefined })
  assert.deepEqual(await f.importState(text(good)), { imported: 1, saved: 2 })
  const s = await store.load()
  assert.deepEqual(s.commitments.map((c) => c.hash), [`0x${'ee'.repeat(32)}`, hash])
  assert.deepEqual(s.admission, opening)
})

test('U4 refused: order and salt that do not hash to the entry', async () => {
  const { f, area } = await setup()
  await assert.rejects(f.importState(text({ ...good, commitments: [{ ...good.commitments[0], salt: `0x${'04'.repeat(32)}` }] })), /do not hash/)
  assert.deepEqual(Object.keys(area.data), []) // nothing written
})

test('U4 refused: an entry the chain has a different commitment for (stale or foreign)', async () => {
  const { f, area } = await setup()
  await assert.rejects(f.importState(text({ ...good, commitments: [{ ...good.commitments[0], id: 5n }] })), /stale or foreign/)
  assert.deepEqual(Object.keys(area.data), [])
})

test('U4 refused: another owner, chain or settlement', async () => {
  const { f } = await setup()
  await assert.rejects(f.importState(text({ ...good, owner: dep.settlement })), /state belongs to/)
  await assert.rejects(f.importState(text({ ...good, chainId: 1 })), /another chain or settlement/)
})

test('U4 refused: a funding opening that does not hash to its root, or does not match admissionState', async () => {
  const { f } = await setup()
  await assert.rejects(f.importState(text({ ...good, admission: { ...opening, totals: [0n, 0n] } })), /does not match its root/)
  const stale = await setup({ ...onchain, admissionState: [3n, `0x${'12'.repeat(32)}`, 2n] })
  await assert.rejects(stale.f.importState(text(good)), /stale or missing/)
})

test('U4 exports use the CLI state format both ways', async () => {
  const { f, store } = await setup()
  await store.write(good)
  const exported = await f.exportState()
  assert.deepEqual(parseState(exported), good) // the CLI reads the extension's export
  const fresh = await setup()
  await fresh.f.importState(JSON.stringify(good, (_, v) => (typeof v === 'bigint' ? `${v}n` : v), 2)) // and vice versa
  assert.deepEqual(await fresh.store.load(), good)
})
