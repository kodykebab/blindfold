import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Q96 } from '../price.mjs'
import { peerTotals, solvePeer } from '../peer.mjs'
const E = 10n ** 18n
const o = (id, sell, amount, minimum = 0n) => ({ id, zeroForOne: sell, amountIn: amount, minAmountOut: minimum })
const run = (orders, price = Q96) => solvePeer({ orders, priceX96: price, simulate: async (m) => {
  const t = peerTotals(orders, price, m)
  return { ok: t.validLimits && t.out0 > 0n && t.out1 > 0n && t.in0 >= t.out0 && t.in1 >= t.out1 }
} })

test('100 sells and 50 buys cross 50 at the fixed price', async () => {
  const orders = [o(0n, true, 100n * E, 90n * E), o(1n, false, 50n * E, 45n * E)]
  assert.deepEqual(await run(orders), { priceX96: Q96, peer: { id: 0n, amountIn: 50n * E } })
})
test('buy-heavy zero-minimum orders cross without changing price', async () => {
  const orders = [o(0n, false, 100n * E), o(1n, true, 50n * E)]
  const result = await run(orders)
  assert.equal(result.priceX96, Q96)
  assert.equal(result.peer.amountIn, 50n * E)
})
test('equal limits share a fraction and are independent of reveal order', async () => {
  const orders = [o(0n, true, 100n * E, 90n * E), o(1n, true, 50n * E, 45n * E), o(2n, false, 75n * E)]
  const result = await run(orders)
  assert.deepEqual(result, await run([...orders].reverse()))
  assert.equal(result.peer.amountIn, 50n * E)
  assert.deepEqual(peerTotals(orders, Q96, result.peer), { in0: 75n * E, out0: 75n * E, in1: 75n * E, out1: 75n * E, validLimits: true })
})
test('better limits fill before worse ones, including a fully filled boundary', async () => {
  const orders = [o(0n, true, 50n, 40n), o(1n, true, 50n, 45n), o(2n, false, 50n)]
  assert.deepEqual((await run(orders)).peer, { id: 0n, amountIn: 50n })
})
test('one-sided orders and incompatible limits do not produce a candidate', async () => {
  assert.equal(await run([o(0n, true, 100n)]), null)
  assert.equal(await run([o(0n, true, 100n, 110n), o(1n, false, 50n)]), null)
})
test('integer crossing accounts for both token surpluses independently', async () => {
  const orders = [o(0n, true, 100n), o(1n, false, 2n), o(2n, false, 2n)]
  const p = Q96 * 98n / 100n
  const result = await run(orders, p)
  assert.ok(result)
  const t = peerTotals(orders, p, result.peer)
  assert.ok(t.in0 >= t.out0 && t.in1 >= t.out1)
})
test('never returns a chain-rejected candidate or swallows transport errors', async () => {
  const orders = [o(0n, true, 100n), o(1n, false, 50n)]
  assert.equal(await solvePeer({ orders, priceX96: Q96, simulate: async () => ({ ok: false }) }), null)
  await assert.rejects(solvePeer({ orders, priceX96: Q96, simulate: async () => { throw new Error('RPC unavailable') } }), /RPC unavailable/)
})
test('small integer batches conserve assets and only simulate balanced candidates', async () => {
  for (let a = 1n; a <= 40n; a++) for (let b = 1n; b <= 40n; b++) {
    const orders = [o(0n, true, a), o(1n, false, b)]
    const result = await run(orders)
    assert.ok(result)
    const t = peerTotals(orders, Q96, result.peer)
    assert.equal(t.in0, a < b ? a : b)
    assert.equal(t.in0, t.out0)
    assert.equal(t.in1, t.out1)
  }
})
