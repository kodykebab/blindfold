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

test('external partial search finds and shares a capacity-limited group in either direction', async () => {
  for (const sell of [true, false]) {
    const orders = [1000n, 500n].map((amountIn, i) => ({ id: BigInt(i), zeroForOne: sell,
      amountIn, minAmountOut: amountIn * 9n / 10n }))
    const result = await solveExternal({ referenceX96: 1n << 96n, deviationBps: 1, orders,
      simulate: async (p, m) => ({ ok: Boolean(m && m.amountIn <= 540n) }) })
    assert.equal(result.marginal.amountIn, 540n)
    assert.equal(result.marginal.id, 0n)
    assert.equal(result.external, true)
  }
})
test('external search does not finalize a batch with no fills', async () => {
  let calls = 0
  const orders = [{id:0n,zeroForOne:true,amountIn:100n,minAmountOut:200n}]
  assert.equal(await solveExternal({ referenceX96:1n<<96n,deviationBps:1,orders,
    simulate:async()=>{calls++;return {ok:true}} }),null)
  assert.equal(calls,0)
})
test('external search tests exact limit edges inside a basis point', async () => {
  const orders = [{id:0n,zeroForOne:true,amountIn:1n<<96n,minAmountOut:1000005n}]
  const result = await solveExternal({referenceX96:1000000n,deviationBps:1,orders,
    simulate:async(p)=>({ok:p===1000005n})})
  assert.equal(result.priceX96,1000005n)
})
test('external search reports deadline and budget exhaustion explicitly', async () => {
  await assert.rejects(solveExternal({referenceX96:10000n,deviationBps:10,now:()=>10,deadlineMs:10,
    simulate:async()=>{throw new Error('must not call')} }),/deadline/)
  await assert.rejects(solveExternal({referenceX96:10000n,deviationBps:10,maxSimulations:1,
    simulate:async()=>({ok:false})}),/budget/)
})

test('a slow successful simulation cannot return a candidate after the deadline', async () => {
  let clock = 0
  await assert.rejects(solveExternal({ referenceX96:10000n,deviationBps:1,deadlineMs:10,now:()=>clock,
    simulate:async()=>{clock=11;return {ok:true}} }),/deadline/)
})
