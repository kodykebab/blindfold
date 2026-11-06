// Local anvil run of the real CLI. Needs `forge build` in contracts/ and anvil on PATH:
//   CLIENT_E2E=1 npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
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

test('S4: cleanup clears mixed commitments in order, then every asset withdraws', { skip: !enabled, timeout: 120_000 }, async () => {
  const c = await localChain()
  try {
    const u = user(10).address
    await c.mint(u, c.token0, parseEther('100'))
    await c.mint(u, c.token1, parseEther('100'))
    for (const args of [['sell', '10', '9'], ['sell', '0', '0'], ['sell', '5', '4']]) {
      const r = await c.cli(10, ['commit', ...args])
      assert.equal(r.code, 0, r.err)
    }
    // lose the third order's salt: only a keeper could reveal it now
    const path = join(c.dir, 'state', readdirSync(join(c.dir, 'state'))[0])
    const state = savedState(c)
    const b = state.commitments[0].batchId
    state.commitments.pop()
    writeFileSync(path, JSON.stringify(state, (_, v) => (typeof v === 'bigint' ? `${v}n` : v)))

    let r = await c.cli(10, ['withdraw', 'token1', 'all'])
    assert.equal(r.code, 1)
    assert.match(r.err, /3 open commitment\(s\) block withdrawals of every token/)
    assert.match(r.err, /#2 batch \d+ \(committed\): wait \d+s — sealed until its drand round/)

    // reveal window: own saved orders get revealed, the lost one waits for a keeper or the slash
    await c.warp(await c.read(c.settlement, 'BlindfoldSettlement', 'revealOpens', [b]))
    r = await c.cli(10, ['cleanup'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /#0 .*: reveal/)
    assert.match(r.out, /#1 .*: reveal/)
    assert.match(r.out, /#2 .*: wait \d+s — order and salt not saved here/)
    assert.match(r.out, /2 commitment\(s\) still block withdrawal/)
    r = await c.cli(10, ['track'])
    assert.match(r.out, /#1 batch \d+: padding/)

    // after the reveal window: the lost one is slashed; the revealed order waits for settlement
    await c.warp(await c.read(c.settlement, 'BlindfoldSettlement', 'revealCloses', [b]))
    r = await c.cli(10, ['blockers'])
    assert.match(r.out, /#0 .*\(revealed\): wait \d+s — revealed, waiting for settlement/)
    assert.match(r.out, /#2 .*\(committed\): slash/)
    r = await c.cli(10, ['cleanup', '--dry-run'])
    assert.match(r.out, /dry run: nothing sent/)
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'openCommitments', [u]), 2n)
    r = await c.cli(10, ['cleanup'])
    assert.match(r.out, /1 commitment\(s\) still block withdrawal/)

    // nobody settles: after the deadline cleanup expires the batch
    await c.warp(await c.read(c.settlement, 'BlindfoldSettlement', 'settleCloses', [b]))
    r = await c.cli(10, ['cleanup'])
    assert.match(r.out, /#0 .*: expire/)
    assert.match(r.out, /nothing blocks withdrawal/)
    r = await c.cli(10, ['track'])
    assert.match(r.out, /#0 batch \d+: expired/)
    assert.match(r.out, /#2 batch \d+: slashed/)

    // token1 was never an order input; it was blocked anyway and now withdraws with token0
    for (const tok of ['token1', 'token0']) {
      r = await c.cli(10, ['withdraw', tok, 'all'])
      assert.equal(r.code, 0, r.err)
    }
    // the only loss is the slashed deposit minus the bounty this account earned for slashing it
    const wallet = (t) => c.read(t, 'MockERC20', 'balanceOf', [u])
    assert.equal(await wallet(c.token0), parseEther('100'))
    assert.equal(await wallet(c.token1), parseEther('100') - (DEPOSIT - DEPOSIT / 5n))
    // funding invariant: the vault holds exactly what its accounts are owed
    const owed = async (t) => (await Promise.all([u, user(9).address, c.settlement].map((a) => c.read(c.vault, 'BlindfoldVault', 'balanceOf', [a, t])))).reduce((x, y) => x + y)
    for (const t of [c.token0, c.token1]) assert.equal(await c.read(t, 'MockERC20', 'balanceOf', [c.vault]), await owed(t))
  } finally {
    c.stop()
  }
})
