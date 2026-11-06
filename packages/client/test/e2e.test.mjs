// Local anvil run of the real CLI. Needs `forge build` in contracts/ and anvil on PATH:
//   CLIENT_E2E=1 npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseEther } from 'viem'
import { localChain, user, DEPOSIT } from './chain.mjs'

const enabled = process.env.CLIENT_E2E === '1'
const reviver = (_, v) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)
const savedState = (c) => {
  const dir = join(c.dir, 'state')
  return JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8'), reviver)
}

test('S10: preflight, commit, track and withdraw through the CLI', { skip: !enabled, timeout: 120_000 }, async () => {
  const c = await localChain()
  try {
    const u = user(10).address
    await c.mint(u, c.token0, parseEther('100'))
    await c.mint(u, c.token1, parseEther('100'))

    let r = await c.cli(10, ['status'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /wallet 100 TK.\s+\| available 0 TK. \| reserved 0 TK. \| withdrawable 0/)

    // preflight catches the missing vault funds before anything is sent; --dry-run sends nothing
    r = await c.cli(10, ['commit', 'sell', '10', '9', '--dry-run'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /funding TK.: need 10 TK., vault free 0 TK., deposit 10 TK. first \(needs approval\)/)
    assert.match(r.out, /funding TK.: need 5 TK., vault free 0 TK., deposit 5 TK. first/)
    assert.match(r.out, /dry run: nothing sent/)
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'openCommitments', [u]), 0n)

    r = await c.cli(10, ['commit', 'sell', '500', '9'])
    assert.equal(r.code, 1)
    assert.match(r.err, /preflight failed:\s+not enough/)

    // commit funds the shortfall itself, encrypts and saves the order + salt
    r = await c.cli(10, ['commit', 'sell', '10', '9'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /committed #0 to round \d+/)
    const [saved] = savedState(c).commitments
    assert.equal(saved.id, 0n)
    assert.equal(saved.order.amountIn, parseEther('10'))

    r = await c.cli(10, ['track'])
    assert.match(r.out, new RegExp(`#0 batch ${saved.batchId}: committed \\(sealed\\)`))
    r = await c.cli(10, ['withdraw', 'token0', 'all'])
    assert.equal(r.code, 1)
    assert.match(r.err, /1 open commitment\(s\) block withdrawals/)
    r = await c.cli(10, ['status'])
    assert.match(r.out, /open commitments: 1/)

    // a keeper reveals from the saved plaintext, nobody settles, anyone expires: input unlocks
    await c.warp(await c.read(c.settlement, 'BlindfoldSettlement', 'revealOpens', [saved.batchId]))
    await c.write(c.settlement, 'BlindfoldSettlement', 'reveal', [0n, saved.order, saved.salt], user(1))
    r = await c.cli(10, ['status'])
    assert.match(r.out, /available 0 TKA \| reserved 10 TKA \| withdrawable 0 TKA\n\s+TKB .*available 4 TKB/)
    await c.warp(await c.read(c.settlement, 'BlindfoldSettlement', 'settleCloses', [saved.batchId]))
    await c.write(c.settlement, 'BlindfoldSettlement', 'expire', [saved.batchId], user(1))

    r = await c.cli(10, ['track'])
    assert.match(r.out, new RegExp(`#0 batch ${saved.batchId}: expired \\(sell 10000000000000000000\\)`))
    r = await c.cli(10, ['withdraw', 'token0', 'all'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /withdrew 10 TK./)
    // deposit came back minus the 20% bounty
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'balanceOf', [u, c.token1]), DEPOSIT - DEPOSIT / 5n)
  } finally {
    c.stop()
  }
})
