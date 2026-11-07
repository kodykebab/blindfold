// Harness self-check, no browser: the E2 deployment really settles a crossing batch at price 1. EXT_E2E=1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEther } from 'viem'
import { startChain, user, DEPOSIT } from '../lib/chain.mjs'

test('harness: deploy, commit, reveal, settle at price 1 and withdraw without the extension', { skip: process.env.EXT_E2E !== '1', timeout: 120_000 }, async () => {
  const c = await startChain()
  try {
    const block = await c.pub.getBlockNumber({ cacheTime: 0 })
    await assert.rejects(startChain(), /port 8563 already in use/)
    assert.equal(await c.pub.getBlockNumber({ cacheTime: 0 }), block, 'a second harness must not deploy to the first chain')
    const { dep } = c
    const S = dep.settlement
    const b = await c.read(S, 'BlindfoldSettlement', 'currentBatch')
    const orders = [[10, true], [11, false]].map(([i, zeroForOne]) => ({
      i, salt: `0x${String(i).padStart(64, '0')}`,
      order: { owner: user(i).address, zeroForOne, amountIn: parseEther('10'), minAmountOut: parseEther('9') },
    }))
    for (const { i, order, salt } of orders) {
      const tin = order.zeroForOne ? dep.token0 : dep.token1
      for (const [token, amount] of [[tin, order.amountIn], [dep.depositToken, DEPOSIT]]) {
        await c.mint(user(i).address, token, amount)
        await c.write(token, 'MockERC20', 'approve', [dep.vault, amount], user(i))
        await c.write(dep.vault, 'BlindfoldVault', 'deposit', [token, amount], user(i))
      }
      const hash = await c.read(S, 'BlindfoldSettlement', 'orderHash', [b, order, salt])
      await c.write(S, 'BlindfoldSettlement', 'commit', [b, hash, '0x00'], user(i))
    }
    await c.warp(await c.read(S, 'BlindfoldSettlement', 'revealOpens', [b]))
    for (const [id, { order, salt }] of orders.entries()) await c.write(S, 'BlindfoldSettlement', 'reveal', [BigInt(id), order, salt], user(1))
    await c.warp(await c.read(S, 'BlindfoldSettlement', 'revealCloses', [b]))
    await c.write(S, 'BlindfoldSettlement', 'settlePeer', [b, 0n, parseEther('10')], user(1))
    assert.equal(await c.read(S, 'BlindfoldSettlement', 'finalized', [b]), true)
    // seller got 10 token1, buyer 10 token0; both withdraw
    for (const [i, token] of [[10, dep.token1], [11, dep.token0]]) {
      assert.equal(await c.read(dep.vault, 'BlindfoldVault', 'openCommitments', [user(i).address]), 0n)
      await c.write(dep.vault, 'BlindfoldVault', 'withdraw', [token, parseEther('10')], user(i))
      assert.equal(await c.read(token, 'MockERC20', 'balanceOf', [user(i).address]), parseEther('10'))
    }
  } finally {
    await c.stop()
  }
})

test('harness: recorded drand round and explicit block interval stay fixed while proofs wait', { skip: process.env.EXT_E2E !== '1' }, async () => {
  const timestamp = 1692803367n + (1000000n - 3n) * 3n - 900n
  const c = await startChain({ timestamp, timestampInterval: 1, schedule: { start: Number(timestamp), batchLength: 900, settleLength: 30 } })
  try {
    const S = c.dep.settlement
    const b = await c.read(S, c.contract, 'currentBatch')
    assert.equal(await c.read(S, c.contract, 'targetRound', [b]), 1000000n)
    const latest = () => c.pub.getBlock({ blockTag: 'latest', cacheTime: 0 })
    const before = (await latest()).timestamp
    await new Promise((resolve) => setTimeout(resolve, 2100))
    await c.mine()
    assert.equal((await latest()).timestamp, before + 1n)
    const opens = await c.read(S, c.contract, 'revealOpens', [b])
    await c.warp(opens)
    assert.equal((await latest()).timestamp, opens)
    await c.mine()
    assert.equal((await latest()).timestamp, opens + 1n)
  } finally { await c.stop() }
})
