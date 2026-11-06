import { test } from 'node:test'
import assert from 'node:assert/strict'
import { solveExternal } from '../external.mjs'

test('external search stays inside the band and finds either residual direction', async () => {
  for (const target of [9990n, 10010n]) {
    const tried = []
    const result = await solveExternal({ referenceX96: 10000n, deviationBps: 10,
      simulate: async (p) => { tried.push(p); return { ok: p === target } } })
    assert.equal(result.priceX96, target)
    assert.equal(result.external, true)
    assert.equal(tried[0], 10000n)
    assert.ok(tried.every((p) => p >= 9990n && p <= 10010n))
    assert.equal(new Set(tried).size, tried.length)
  }
})
test('external search bounds work and propagates transport failure', async () => {
  let calls = 0
  assert.equal(await solveExternal({ referenceX96: 10000n, deviationBps: 100,
    simulate: async () => { calls++; return { ok: false } } }), null)
  assert.equal(calls, 201)
  await assert.rejects(solveExternal({ referenceX96: 10000n, deviationBps: 1,
    simulate: async () => { throw new Error('RPC offline') } }), /RPC offline/)
})
test('external search deduplicates prices and rejects invalid policy', async () => {
  let calls = 0
  await solveExternal({ referenceX96: 1n, deviationBps: 100, simulate: async () => { calls++; return {ok:false} } })
  assert.equal(calls, 1)
  await assert.rejects(solveExternal({ referenceX96: 0n, deviationBps: 100 }), /invalid/)
})
