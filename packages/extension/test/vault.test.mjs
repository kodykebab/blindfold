// U3: encrypted private state round-trips; a wrong passphrase fails; a flipped byte fails.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVault, ITERATIONS, stateStore, unlockVault } from '../src/vault.mjs'
import { dep, memoryArea, owner } from './mock.mjs'

const state = {
  chainId: 31337, settlement: dep.settlement, owner,
  commitments: [{ id: 4n, batchId: 7n, round: 1000000n, hash: `0x${'aa'.repeat(32)}`, salt: `0x${'03'.repeat(32)}`, order: { owner, zeroForOne: true, amountIn: (1n << 128n) - 1n, minAmountOut: 1n } }],
  admission: { batch: 7n, step: 1n, root: `0x${'bb'.repeat(32)}`, totals: [5n, 0n], blind: `0x${'cc'.repeat(32)}` },
}
const flip = (hex, i) => hex.slice(0, i) + (hex[i] === '0' ? '1' : '0') + hex.slice(i + 1)

test('U3 round trip with the production iteration count; nothing readable at rest', async () => {
  const area = memoryArea()
  const key = await createVault(area, 'correct horse battery staple')
  assert.equal(area.data.kdf.iterations, ITERATIONS)
  const store = stateStore(area, key)
  assert.deepEqual(await store.load(dep, owner), { chainId: 31337, settlement: dep.settlement, owner, commitments: [] })
  await store.write(dep, owner, state)
  assert.deepEqual(await store.load(dep, owner), state)
  const raw = JSON.stringify(area.data)
  for (const secret of ['03'.repeat(32), 'cc'.repeat(32), String((1n << 128n) - 1n)]) assert.ok(!raw.includes(secret)) // salt, blinding, amount
  // a later unlock with the same passphrase reads it back
  assert.deepEqual(await stateStore(area, await unlockVault(area, 'correct horse battery staple')).load(dep, owner), state)
})

test('U3 wrong passphrase fails', async () => {
  const area = memoryArea()
  await createVault(area, 'right', 1000)
  await assert.rejects(unlockVault(area, 'wrong'), /wrong passphrase/)
  await assert.rejects(createVault(area, 'again', 1000), /already set/)
  await assert.rejects(unlockVault(memoryArea(), 'right'), /no passphrase set/)
})

test('U3 a flipped byte in ciphertext or IV fails; a record moved to another account fails', async () => {
  const area = memoryArea()
  const key = await createVault(area, 'pw', 1000)
  const store = stateStore(area, key)
  await store.write(dep, owner, state)
  const slot = Object.keys(area.data).find((k) => k.startsWith('state:'))
  const box = area.data[slot]
  for (const i of [2, 40, box.ct.length - 1]) {
    area.data[slot] = { ...box, ct: flip(box.ct, i) }
    await assert.rejects(store.load(dep, owner), /cannot decrypt private state/)
  }
  area.data[slot] = { ...box, iv: flip(box.iv, 5) }
  await assert.rejects(store.load(dep, owner), /cannot decrypt/)
  area.data[slot] = box
  const other = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
  area.data[slot.replace(owner.toLowerCase(), other.toLowerCase())] = box
  await assert.rejects(store.load(dep, other), /cannot decrypt/)
  assert.deepEqual(await store.load(dep, owner), state)
})
