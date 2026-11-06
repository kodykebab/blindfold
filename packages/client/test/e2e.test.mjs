// Local anvil run of the real CLI. Needs `forge build` in contracts/ and anvil on PATH:
//   CLIENT_E2E=1 npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
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

test('S11: overlapping batch rejected before gas; state export, tamper refusal and restore', { skip: !enabled, timeout: 120_000 }, async () => {
  const c = await localChain()
  try {
    const u = user(10).address
    for (const i of [10, 11]) {
      await c.mint(user(i).address, c.token0, parseEther('100'))
      await c.mint(user(i).address, c.token1, parseEther('100'))
    }
    let r = await c.cli(10, ['commit', 'sell', '10', '9'])
    assert.equal(r.code, 0, r.err)
    r = await c.cli(10, ['commit', 'sell', '0', '0']) // a second order in the same batch is allowed
    assert.equal(r.code, 0, r.err)
    const b = savedState(c).commitments[0].batchId

    // next batch open, this one not revealed yet: refused before encrypting or sending anything
    await c.warp(await c.read(c.settlement, 'BlindfoldSettlement', 'commitsClose', [b]))
    const vaultT1 = await c.read(c.vault, 'BlindfoldVault', 'balanceOf', [u, c.token1])
    r = await c.cli(10, ['commit', 'buy', '1', '0.5'])
    assert.equal(r.code, 1)
    assert.match(r.err, new RegExp(`open commitments in batch ${b}: one active batch per account`))
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'openCommitments', [u]), 2n)
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'balanceOf', [u, c.token1]), vaultT1)
    assert.equal(savedState(c).commitments.length, 2)

    // back up, lose local state, then restore
    const backup = join(c.dir, 'backup.json')
    r = await c.cli(10, ['export-state', backup])
    assert.match(r.out, /exported 2 commitment\(s\)/)
    const stateDir = join(c.dir, 'state')
    rmSync(stateDir, { recursive: true })
    await c.warp(await c.read(c.settlement, 'BlindfoldSettlement', 'revealOpens', [b]))
    r = await c.cli(10, ['blockers'])
    assert.match(r.out, /#0 .*order and salt not saved here/)

    // a tampered salt, or another account's file, is refused and changes nothing
    const text = readFileSync(backup, 'utf8')
    const tampered = join(c.dir, 'tampered.json')
    writeFileSync(tampered, text.replace(/"salt": "0x[0-9a-f]{64}"/, `"salt": "0x${'00'.repeat(31)}01"`))
    r = await c.cli(10, ['import-state', tampered])
    assert.equal(r.code, 1)
    assert.match(r.err, /order and salt do not hash to it/)
    r = await c.cli(11, ['import-state', backup])
    assert.equal(r.code, 1)
    assert.match(r.err, /state belongs to/)
    assert.equal(existsSync(stateDir) ? readdirSync(stateDir).length : 0, 0)

    r = await c.cli(10, ['import-state', backup])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /imported; 2 commitment\(s\) saved/)
    r = await c.cli(10, ['cleanup'])
    assert.match(r.out, /#0 .*: reveal/)
    assert.match(r.out, /#1 .*: reveal/)
    r = await c.cli(10, ['track'])
    assert.match(r.out, /#0 batch \d+: revealed/)
    assert.match(r.out, /#1 batch \d+: padding/)
  } finally {
    c.stop()
  }
})


// ReleasePolicySettlement is #50's policy-only test harness, not a proof verifier.
// Enable only with that branch's generated artifacts; no ABI is copied here.
test('released commitment: real CLI cleanup, repeat cleanup, next batch and withdrawal', {
  skip: !enabled || process.env.CLIENT_RELEASE_E2E !== '1', timeout: 120_000,
}, async () => {
  const fee = parseEther('0.1')
  const c = await localChain({ settlementContract: 'ReleasePolicySettlement', fee })
  try {
    const u = user(10).address
    await c.mint(u, c.token0, parseEther('100'))
    await c.mint(u, c.token1, parseEther('100'))
    // This harness tests cleanup policy only; bypass admission directly in test setup.
    for (const token of [c.token0, c.token1]) {
      const amount = token === c.token1 ? DEPOSIT + fee : parseEther('10')
      await c.write(token, 'MockERC20', 'approve', [c.vault, amount], user(10))
      await c.write(c.vault, 'BlindfoldVault', 'deposit', [token, amount], user(10))
    }
    const b = await c.read(c.settlement, 'BlindfoldSettlement', 'currentBatch')
    await c.write(c.settlement, 'ReleasePolicySettlement', 'commit', [b, `0x${'01'.repeat(32)}`, '0x00'], user(10))
    let r = await c.cli(10, ['status'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /unrevealed deposit can be released/)
    await c.warp(await c.read(c.settlement, 'BlindfoldSettlement', 'revealCloses', [b]))
    r = await c.cli(10, ['cleanup', '--dry-run'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /: release — .*retains the fee/)
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'openCommitments', [u]), 1n)
    r = await c.cli(10, ['cleanup'])
    assert.equal(r.code, 0, r.err)
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'openCommitments', [u]), 0n)
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'balanceOf', [u, c.token1]), DEPOSIT)
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'balanceOf', [user(9).address, c.token1]), fee)
    r = await c.cli(10, ['track'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /#0 batch \d+: released/)
    const nonce = await c.pub.getTransactionCount({ address: u })
    for (const command of ['blockers', 'cleanup']) {
      r = await c.cli(10, [command])
      assert.equal(r.code, 0, r.err)
      assert.match(r.out, /nothing blocks withdrawal/)
    }
    assert.equal(await c.pub.getTransactionCount({ address: u }), nonce)
    // Move to a fresh batch so preflight cannot fail only because of lead time.
    const current = await c.read(c.settlement, 'BlindfoldSettlement', 'currentBatch')
    await c.warp(await c.read(c.settlement, 'BlindfoldSettlement', 'commitsClose', [current]))
    r = await c.cli(10, ['commit', 'sell', '1', '0.9', '--dry-run'])
    assert.equal(r.code, 1)
    assert.match(r.err, /deployment file must include the parameter manifest/)
    assert.doesNotMatch(r.out + r.err, /one active batch per account/)
    for (const token of ['token0', 'token1']) {
      r = await c.cli(10, ['withdraw', token, 'all'])
      assert.equal(r.code, 0, r.err)
    }
    assert.equal(await c.read(c.token1, 'MockERC20', 'balanceOf', [u]), parseEther('100') - fee)
  } finally { c.stop() }
})

test('fixes 4-5: quote-based limits, refusals without a usable market, resubmit after expiry', { skip: !enabled, timeout: 120_000 }, async () => {
  const c = await localChain({ market: true }) // a mock external market quoting 1 token1 per token0, no pool fee
  const plain = await localChain()
  try {
    const u = user(10).address
    for (const chain of [c, plain]) for (const tok of [chain.token0, chain.token1]) await chain.mint(u, tok, parseEther('100'))

    // no minimum given: the limit is the fresh quote less 50 bps by default, shown as a limit order
    let r = await c.cli(10, ['commit', 'sell', '10', '--dry-run'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /quote: 10 TKA ≈ 10 TKB at the market reference; limit 50 bps below it/)
    assert.match(r.out, /order: sell 10 TKA for at least 9\.95 TKB in batch 0, or you keep your funds/)
    r = await plain.cli(10, ['commit', 'sell', '10', '--dry-run'])
    assert.notEqual(r.code, 0)
    assert.match(r.err, /no external market to quote from/)
    // a market that cannot price now refuses the order before anything is sent
    const market = await c.read(c.settlement, 'BlindfoldSettlement', 'externalMarket')
    await c.write(market, 'MockExternalMarket', 'setFail', [true])
    r = await c.cli(10, ['commit', 'buy', '10', '--dry-run'])
    assert.notEqual(r.code, 0)
    assert.match(r.err, /cannot price this pair right now/)
    await c.write(market, 'MockExternalMarket', 'setFail', [false])

    r = await c.cli(10, ['commit', 'sell', '10', '--slippage', '100'])
    assert.equal(r.code, 0, r.err)
    assert.equal(savedState(c).commitments[0].order.minAmountOut, parseEther('9.9'))

    // nobody settles: the order is revealed, then expires
    await c.warp(await c.read(c.settlement, 'BlindfoldSettlement', 'revealOpens', [0n]))
    assert.equal((await c.cli(10, ['cleanup'])).code, 0)
    await c.warp(await c.read(c.settlement, 'BlindfoldSettlement', 'settleCloses', [0n]))
    r = await c.cli(10, ['cleanup'])
    assert.match(r.out, /expire/)
    r = await c.cli(10, ['track'])
    assert.match(r.out, /#0 batch 0: expired/)

    // resubmit places it again with a fresh quote, in the batch that is open now, and only once
    await c.write(market, 'MockExternalMarket', 'setPrice', [(2n << 96n)]) // the market moved: 2 TKB per TKA
    r = await c.cli(10, ['resubmit'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /resubmitting #0 \(expired in batch 0\): sell 10 TKA with a fresh quote; a new commitment pays the commit fee again/)
    assert.match(r.out, /for at least 19\.9 TKB/)
    const state = savedState(c)
    assert.equal(state.commitments.length, 2)
    assert.equal(state.commitments[0].resubmittedAs, state.commitments[1].hash)
    assert.ok(state.commitments[1].batchId > 0n)
    r = await c.cli(10, ['resubmit'])
    assert.notEqual(r.code, 0)
    assert.match(r.err, /no unfilled or expired order to resubmit/)
    // keep-ready only applies to proof-enforced deployments
    r = await c.cli(10, ['keep-ready', '--once'])
    assert.notEqual(r.code, 0)
    assert.match(r.err, /does not use proof-enforced admission/)
  } finally {
    c.stop()
    plain.stop()
  }
})

test('fix 6: a wiped device restores from the encrypted backup, reveals its own order and withdraws', { skip: !enabled, timeout: 120_000 }, async () => {
  const c = await localChain({ market: true })
  try {
    const u = user(10).address
    for (const tok of [c.token0, c.token1]) await c.mint(u, tok, parseEther('100'))
    let r = await c.cli(10, ['commit', 'sell', '10', '9'])
    assert.equal(r.code, 0, r.err)
    const backups = join(c.dir, 'backups')
    const file = join(backups, readdirSync(backups)[0])
    assert.doesNotMatch(readFileSync(file, 'utf8'), new RegExp(savedState(c).commitments[0].salt.slice(2)), 'the backup hides the salt')

    // the device loses its private state
    rmSync(join(c.dir, 'state'), { recursive: true, force: true })
    await c.warp(await c.read(c.settlement, 'BlindfoldSettlement', 'revealOpens', [0n]))
    r = await c.cli(10, ['cleanup', '--dry-run'])
    assert.match(r.out, /order and salt not saved here/)

    // another wallet's backup and a tampered one are refused; this wallet's restores
    r = await c.cli(11, ['restore-backup', file])
    assert.notEqual(r.code, 0); assert.match(r.err, /belongs to/)
    const tampered = join(c.dir, 'tampered.json')
    const b = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(tampered, JSON.stringify({ ...b, tag: (b.tag[0] === '0' ? '1' : '0') + b.tag.slice(1) }))
    r = await c.cli(10, ['restore-backup', tampered])
    assert.notEqual(r.code, 0); assert.match(r.err, /does not decrypt/)
    r = await c.cli(10, ['restore-backup'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /imported; 1 commitment/)

    // with the order and salt back, the user reveals their own order and, once the batch expires, withdraws
    r = await c.cli(10, ['cleanup'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /reveal/)
    await c.warp(await c.read(c.settlement, 'BlindfoldSettlement', 'settleCloses', [0n]))
    assert.equal((await c.cli(10, ['cleanup'])).code, 0)
    r = await c.cli(10, ['withdraw', 'token0', 'all'])
    assert.equal(r.code, 0, r.err)
    assert.equal(await c.read(c.token0, 'MockERC20', 'balanceOf', [u]), parseEther('100'))
  } finally {
    c.stop()
  }
})
