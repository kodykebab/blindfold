// Local anvil run of the real keeper. Needs `forge build` in contracts/, anvil on PATH and packages/client installed:
//   KEEPER_E2E=1 npm test
// The chain starts at the time whose batch 0 targets drand round 1,000,000, so the recorded round in
// packages/client/test/fixtures decrypts it offline.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keccak256, parseEther, toHex } from 'viem'
import { localChain, user, DEPOSIT, DRAND } from '../../client/test/chain.mjs'

const enabled = process.env.KEEPER_E2E === '1'
const KEEPER = fileURLToPath(new URL('../keeper.mjs', import.meta.url))
// (start + 30 - genesis) / 3 + 1 + 2 == 1_000_000 for 30 s batches
const START = 1692803367 + 3 * 999997 - 30
const BOUNTY = DEPOSIT / 5n

function keeper(c, index, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [KEEPER, '--once'], {
      env: { ...process.env, RPC_URL: c.rpc, DEPLOYMENTS: c.deployments, DRAND, KEEPER_INDEX: String(index), ...env },
    }, (e, out, err) => {
      const line = out.trim().split('\n').pop()
      resolve({ code: e ? e.code : 0, err, st: line ? JSON.parse(line) : null })
    })
  })
}

async function setup() {
  const c = await localChain({ timestamp: START, schedule: { start: START } })
  assert.equal(await c.read(c.settlement, 'BlindfoldSettlement', 'targetRound', [0n]), 1000000n, 'chain aligned to the recorded round')
  for (const i of [10, 11, 12]) {
    await c.mint(user(i).address, c.token0, parseEther('100'))
    await c.mint(user(i).address, c.token1, parseEther('100'))
  }
  for (const [i, args] of [[10, ['sell', '10', '9']], [11, ['buy', '10', '9']]]) {
    const r = await c.cli(i, ['commit', ...args])
    assert.equal(r.code, 0, r.err)
  }
  // user 12 commits garbage: random hash, bytes that are not a tlock ciphertext
  const u12 = user(12)
  await c.write(c.token1, 'MockERC20', 'approve', [c.vault, DEPOSIT], u12)
  await c.write(c.vault, 'BlindfoldVault', 'deposit', [c.token1, DEPOSIT], u12)
  await c.write(c.settlement, 'BlindfoldSettlement', 'commit', [0n, keccak256(toHex('garbage')), toHex('not a ciphertext')], u12)
  const at = (f) => c.read(c.settlement, 'BlindfoldSettlement', f, [0n])
  return { c, at, status: async (id) => Number((await c.read(c.settlement, 'BlindfoldSettlement', 'commitments', [id]))[2]) }
}

test('S8: racing keepers reveal each order once, slash garbage, expire the unsettled batch', { skip: !enabled, timeout: 180_000 }, async () => {
  const { c, at, status } = await setup()
  try {
    const bal = (i) => c.read(c.vault, 'BlindfoldVault', 'balanceOf', [user(i).address, c.token1])
    const before = [await bal(1), await bal(6)]

    // before the round: nothing due
    let r = await keeper(c, 1)
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(r.st.due, { reveal: 0, slash: 0, expire: 0 })

    await c.warp(await at('revealOpens'))
    const [a, b] = await Promise.all([keeper(c, 1), keeper(c, 6)])
    assert.equal(a.code, 0, a.err)
    assert.equal(b.code, 0, b.err)
    // each order revealed exactly once; the other keeper's attempt counts as a lost race, not an error
    assert.equal(a.st.revealed + b.st.revealed, 2)
    const handled = (x) => x.st.revealed + x.st.lostRace + x.st.unopenable.length
    assert.equal(handled(a), a.st.due.reveal) // every due commitment revealed, lost to the other keeper, or unopenable
    assert.equal(handled(b), b.st.due.reveal)
    assert.equal(await status(0n), 2)
    assert.equal(await status(1n), 2)
    // the bounty goes to whoever's reveal landed
    assert.equal((await bal(1)) - before[0] + (await bal(6)) - before[1], 2n * BOUNTY)
    // garbage is never sent as a reveal
    assert.deepEqual([...a.st.unopenable, ...b.st.unopenable].map((x) => x.why), ['ciphertext does not decrypt', 'ciphertext does not decrypt'])
    assert.equal(await status(2n), 1)

    await c.warp(await at('revealCloses'))
    r = await keeper(c, 1)
    assert.equal(r.code, 0, r.err)
    assert.equal(r.st.slashed, 1)
    assert.equal(await status(2n), 3)
    const gasSlash = r.st.gas.slash

    // nobody settles: the keeper expires the batch so both users' inputs unlock
    await c.warp(await at('settleCloses'))
    r = await keeper(c, 1)
    assert.equal(r.code, 0, r.err)
    assert.equal(r.st.expired, 1)
    const gasExpire = r.st.gas.expire
    assert.ok(await c.read(c.settlement, 'BlindfoldSettlement', 'finalized', [0n]))
    for (const i of [10, 11, 12]) assert.equal(await c.read(c.vault, 'BlindfoldVault', 'openCommitments', [user(i).address]), 0n)

    // a second pass finds nothing left to do
    r = await keeper(c, 1)
    assert.deepEqual(r.st.due, { reveal: 0, slash: 0, expire: 0 })
    console.log('gas used:', JSON.stringify({ reveal: [...(a.st.gas.reveal ?? []), ...(b.st.gas.reveal ?? [])].map(String), slash: gasSlash, expire: gasExpire }))
  } finally {
    c.stop()
  }
})

test('S7: budget and balance floor stop the keeper; users recover without it', { skip: !enabled, timeout: 180_000 }, async () => {
  const { c, at, status } = await setup()
  try {
    await c.warp(await at('revealOpens'))
    const statusFile = join(c.dir, 'keeper-status.json')
    let r = await keeper(c, 1, { KEEPER_BUDGET_WEI: '0', KEEPER_STATUS: statusFile })
    assert.equal(r.code, 0, r.err)
    assert.equal(r.st.revealed, 0)
    assert.equal(r.st.skipped.length, 2)
    assert.match(r.st.skipped[0].why, /budget exhausted/)
    assert.deepEqual(JSON.parse(readFileSync(statusFile, 'utf8')).skipped, r.st.skipped) // monitors read the file
    r = await keeper(c, 1, { KEEPER_MIN_BALANCE_WEI: (10n ** 30n).toString() })
    assert.match(r.st.skipped[0].why, /below the .* wei floor/)
    assert.equal(await status(0n), 1)

    // keeper down for good: users clear their own commitments with the client, permissionlessly
    let u = await c.cli(10, ['cleanup'])
    assert.match(u.out, /#0 .*: reveal/)
    await c.warp(await at('revealCloses'))
    u = await c.cli(11, ['cleanup']) // user 11 lost nothing locally either; reveal window is over, so it slashes
    assert.match(u.out, /#1 .*: slash/)
    await c.warp(await at('settleCloses'))
    u = await c.cli(10, ['cleanup'])
    assert.match(u.out, /#0 .*: expire/)
    assert.match(u.out, /nothing blocks withdrawal/)
    for (const i of [10, 11]) assert.equal(await c.read(c.vault, 'BlindfoldVault', 'openCommitments', [user(i).address]), 0n)
    u = await c.cli(10, ['withdraw', 'token0', 'all'])
    assert.equal(u.code, 0, u.err)
    // a budgeted keeper resumes from the spend in its status file
    r = await keeper(c, 1, { KEEPER_BUDGET_WEI: (10n ** 18n).toString(), KEEPER_STATUS: statusFile })
    assert.equal(r.code, 0, r.err)
    assert.equal(r.st.slashed, 1) // the garbage commitment
    assert.ok(BigInt(r.st.spentWei) > 0n)
  } finally {
    c.stop()
  }
})
