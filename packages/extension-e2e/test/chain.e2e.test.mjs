// Harness self-check, no browser: the E2 deployment really settles a crossing batch at price 1. EXT_E2E=1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEther } from 'viem'
import { startChain, user, DEPOSIT, Q96 } from '../lib/chain.mjs'

test('harness: deploy, commit, reveal, settle at price 1 and withdraw without the extension', { skip: process.env.EXT_E2E !== '1', timeout: 120_000 }, async () => {
  const c = await startChain()
  try {
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
    await c.write(S, 'BlindfoldSettlement', 'settle', [b, Q96], user(1))
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
