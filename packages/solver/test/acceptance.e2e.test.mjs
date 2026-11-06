// Every fill outcome on one local v4 stack: a full fill, a partial fill and an unfilled order in one settled batch,
// then a batch the solver never settles, which expires. Real client CLI, keeper and solver; recorded drand.
// Opt-in (needs anvil and built contracts): ACCEPT_E2E=1 node --test test/acceptance.e2e.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatUnits, parseEther, parseEventLogs, toHex } from 'viem'
import { localChain, user, DRAND, DEPOSIT } from '../../client/test/chain.mjs'
import { artifactPath } from '../artifacts.mjs'

const enabled = process.env.ACCEPT_E2E === '1'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const out = process.env.CONTRACTS_OUT || join(root, 'contracts/out')
// batch 0 targets the recorded drand round 1,000,000 with 60-second batches, as in the local-stack test
const START = 1692803367 + 3 * 999997 - 60
const run = (file, args, env) => new Promise((resolve) => execFile(process.execPath, [join(root, file), ...args], { env: { ...process.env, ...env }, timeout: 60_000 },
  (e, stdout, stderr) => resolve({ code: e ? e.code : 0, out: stdout, err: stderr })))
const last = (text) => JSON.parse(text.trim().split('\n').at(-1))

// A sells with a loose limit, B with a 0.9 limit and C with a 0.99 limit. Selling all of A and B through the pool moves
// its price well below 0.9, so no uniform price fills both: the solver fills A, clears B partially at its limit and
// leaves C, whose limit is above the clearing price, unfilled.
const ORDERS = { A: { i: 10, amountIn: '100', minOut: '50' }, B: { i: 11, amountIn: '1000', minOut: '900' }, C: { i: 12, amountIn: '100', minOut: '99' } }

test('full, partial and unfilled orders settle in one batch, an unsettled batch expires, and everyone withdraws everything', { skip: !enabled, timeout: 240_000 }, async (t) => {
  const c = await localChain({ timestamp: START, schedule: { start: START, batchLength: 60 }, v4: true })
  try {
    const lp = await c.deploy('PoolModifyLiquidityTest', [c.manager])
    for (const token of [c.token0, c.token1]) {
      await c.mint(user(0).address, token, 10n ** 30n)
      await c.write(token, 'MockERC20', 'approve', [lp, (1n << 256n) - 1n])
    }
    await c.write(lp, 'PoolModifyLiquidityTest', 'modifyLiquidity', [c.pool, { tickLower: -60000, tickUpper: 60000, liquidityDelta: 10n ** 22n, salt: toHex(0n, { size: 32 }) }, '0x'])
    assert.equal(await c.read(c.settlement, 'BlindfoldSettlement', 'targetRound', [0n]), 1000000n)
    const funded = parseEther('2000')
    for (const { i } of Object.values(ORDERS)) for (const token of [c.token0, c.token1]) await c.mint(user(i).address, token, funded)

    const env = { RPC_URL: c.rpc, DEPLOYMENTS: c.deployments, DRAND, CONTRACTS_OUT: out, KEEPER_INDEX: '1', SETTLEMENT_ARTIFACT: artifactPath(out, 'BlindfoldSettlement') }
    const sched = async (b) => Object.fromEntries(await Promise.all(['revealOpens', 'revealCloses', 'settleCloses'].map(async (n) => [n, await c.read(c.settlement, 'BlindfoldSettlement', n, [b])])))
    const ids = {}
    for (const [name, o] of Object.entries(ORDERS)) {
      const r = await c.cli(o.i, ['commit', 'sell', o.amountIn, o.minOut])
      assert.equal(r.code, 0, r.err)
      ids[name] = BigInt(r.out.match(/committed #(\d+)/)[1])
    }
    const s0 = await sched(0n)
    await c.warp(s0.revealOpens)
    const keeper = last((await run('packages/keeper/keeper.mjs', ['--once'], env)).out)
    assert.equal(keeper.revealed, 3, JSON.stringify(keeper))

    await c.warp(s0.revealCloses)
    const from = await c.pub.getBlockNumber()
    const solved = await run('packages/solver/solver.mjs', ['--once', '--json'], env)
    assert.equal(solved.code, 0, solved.out + solved.err)
    const status = last(solved.out)
    assert.deepEqual(status.errors, [])
    assert.equal(status.settled.length, 1)
    const [route] = status.settled
    assert.equal(route.batch, '0')
    assert.equal(route.orders, 3)
    assert.match(route.route, new RegExp(`^limit group represented by ${ids.B}, representative input \\d+$`), 'B is the marginal order')
    t.diagnostic(`solver route: ${route.route} at priceX96 ${route.priceX96}`)

    // on-chain outcome per order
    const abi = c.art('BlindfoldSettlement').abi
    const logs = parseEventLogs({ abi, logs: await c.pub.getLogs({ address: c.settlement, fromBlock: from }) })
    const filled = new Map(logs.filter((l) => l.eventName === 'Filled').map((l) => [l.args.id, l.args]))
    const unfilled = new Set(logs.filter((l) => l.eventName === 'Unfilled').map((l) => l.args.id))
    const amount = (x) => parseEther(x)
    assert.equal(filled.get(ids.A).amountIn, amount(ORDERS.A.amountIn), 'A fills fully')
    const partial = filled.get(ids.B)
    assert.ok(partial.amountIn > 0n && partial.amountIn < amount(ORDERS.B.amountIn), 'B fills partially')
    assert.equal(BigInt(route.route.match(/representative input (\d+)$/)[1]), partial.amountIn)
    assert.ok(partial.amountOut * amount(ORDERS.B.amountIn) >= amount(ORDERS.B.minOut) * partial.amountIn, 'B keeps its limit on the part that filled')
    assert.ok(unfilled.has(ids.C) && !filled.has(ids.C), 'C is unfilled')
    const price = BigInt(route.priceX96)
    assert.ok(amount(ORDERS.C.minOut) * (1n << 96n) > amount(ORDERS.C.amountIn) * price, 'C\'s limit is above the clearing price')
    assert.equal(await c.read(c.settlement, 'BlindfoldSettlement', 'finalized', [0n]), true)

    // what each user sees: state, executed input, received output and unused input
    const units = (v) => formatUnits(v, 18).replace('.', '\\.')
    const row = async (i, id) => {
      const r = await c.cli(i, ['track'])
      assert.equal(r.code, 0, r.err)
      return r.out.split('\n').find((l) => l.startsWith(`#${id} `))
    }
    assert.match(await row(10, ids.A), new RegExp(`^#${ids.A} batch 0: filled \\(sell ${amount('100')}\\) → got ${units(filled.get(ids.A).amountOut)} TK. \\[full fill: 100 TK. of 100 TK.\\]$`))
    assert.match(await row(11, ids.B), new RegExp(`^#${ids.B} batch 0: filled \\(sell ${amount('1000')}\\) → got ${units(partial.amountOut)} TK. \\[partial fill: ${units(partial.amountIn)} TK. of 1000 TK.\\]$`))
    assert.match(await row(12, ids.C), new RegExp(`^#${ids.C} batch 0: unfilled \\(sell ${amount('100')}\\)$`))
    // unused input: nothing locked, and the vault holds exactly what was deposited minus what executed
    const vault = (i, token) => c.read(c.vault, 'BlindfoldVault', 'balanceOf', [user(i).address, token])
    for (const [name, o] of Object.entries(ORDERS)) {
      const executed = filled.get(ids[name])?.amountIn ?? 0n
      assert.equal(await c.read(c.vault, 'BlindfoldVault', 'lockedOf', [user(o.i).address, c.token0]), 0n, `${name} has nothing locked`)
      assert.equal(await vault(o.i, c.token0), amount(o.amountIn) - executed, `${name}'s unused input is free again`)
    }

    // batch 1: A trades again; it is revealed but the solver never runs, so it expires after its settle window
    let r = await c.cli(10, ['commit', 'sell', '10', '5'])
    assert.equal(r.code, 0, r.err)
    const expiring = BigInt(r.out.match(/committed #(\d+)/)[1])
    assert.match(r.out, /in batch 1/)
    const s1 = await sched(1n)
    await c.warp(s1.revealOpens)
    r = await c.cli(10, ['cleanup']) // no recorded round for batch 1: the user reveals from the saved order
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, new RegExp(`#${expiring} batch 1 \\(committed\\): reveal`))
    await c.warp(s1.settleCloses)
    r = await c.cli(10, ['cleanup'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, new RegExp(`#${expiring} batch 1 \\(revealed\\): expire`))
    assert.match(r.out, /nothing blocks withdrawal/)
    assert.match(await row(10, expiring), new RegExp(`^#${expiring} batch 1: expired \\(sell ${amount('10')}\\)$`))
    assert.equal(await c.read(c.settlement, 'BlindfoldSettlement', 'clearingPriceX96', [1n]), 0n, 'batch 1 never settled')

    // everyone withdraws everything; the vault owes them nothing more and no commitment is open
    for (const { i } of Object.values(ORDERS)) {
      for (const token of ['token0', 'token1']) {
        r = await c.cli(i, ['withdraw', token, 'all'])
        assert.equal(r.code, 0, r.err)
      }
      assert.equal(await c.read(c.vault, 'BlindfoldVault', 'openCommitments', [user(i).address]), 0n)
      for (const token of [c.token0, c.token1]) assert.equal(await vault(i, token), 0n)
    }
    // A, B and C each got their deposits back minus the keeper's reveal bounty; A's own batch-1 reveal kept its bounty
    const wallet = (i) => c.read(c.token1, 'MockERC20', 'balanceOf', [user(i).address])
    assert.equal(await wallet(12), funded - DEPOSIT / 5n)
  } finally { c.stop() }
})
