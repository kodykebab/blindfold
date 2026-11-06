// Service outages: what the client, keeper and solver do when the RPC or drand is unreachable, and that work
// resumes once it is back. Opt-in (needs anvil and built contracts): OUTAGE_E2E=1 node --test scripts/outage.e2e.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localChain, user, DRAND } from '../packages/client/test/chain.mjs'

const enabled = process.env.OUTAGE_E2E === '1'
const root = fileURLToPath(new URL('../', import.meta.url))
const CLIENT = join(root, 'packages/client/cli.mjs'), KEEPER = join(root, 'packages/keeper/keeper.mjs'), SOLVER = join(root, 'packages/solver/solver.mjs')
// The chain starts where batch 0 targets the recorded drand round 1,000,000 (30 s batches), as in the keeper e2e.
const START = 1692803367 + 3 * 999997 - 30

const run = (file, args, env) => new Promise((resolve) => {
  const started = Date.now()
  execFile(process.execPath, [file, ...args], { env: { ...process.env, ...env }, timeout: 60_000 },
    (e, out, err) => resolve({ code: e ? (e.killed ? 'TIMEOUT' : e.code) : 0, out, err, seconds: (Date.now() - started) / 1000 }))
})
async function closedPort() { // a port nothing listens on
  const s = createServer().listen(0, '127.0.0.1'); await once(s, 'listening')
  const port = s.address().port; await new Promise((r) => s.close(r)); return port
}
const noStack = (text) => assert.ok(!/\n\s+at .+\(.*:\d+:\d+\)/.test(text), `no stack trace: ${text}`)

test('RPC down: client, keeper and solver each stop promptly with one readable error', { skip: !enabled, timeout: 180_000 }, async () => {
  const c = await localChain({ timestamp: START, schedule: { start: START } })
  try {
    const down = { RPC_URL: `http://127.0.0.1:${await closedPort()}`, DEPLOYMENTS: c.deployments, DRAND, CLIENT_STATE: join(c.dir, 'state'), CLIENT_ACCOUNT_INDEX: '10', KEEPER_INDEX: '1' }

    const client = await run(CLIENT, ['status'], down)
    assert.equal(client.code, 1, client.out + client.err)
    assert.match(client.err.trim(), /^client: cannot reach the RPC at http:\/\/127\.0\.0\.1:\d+; /)
    noStack(client.err)

    const keeper = await run(KEEPER, ['--once'], down)
    assert.equal(keeper.code, 1, keeper.out + keeper.err)
    assert.match(keeper.err, /keeper: cannot reach the RPC at /)
    noStack(keeper.err)

    const solver = await run(SOLVER, ['--once', '--json'], down)
    assert.equal(solver.code, 1, solver.out + solver.err)
    const status = JSON.parse(solver.out.trim().split('\n').at(-1))
    assert.equal(status.errors.length, 1); assert.match(status.errors[0].message, /cannot reach the RPC at /)

    for (const r of [client, keeper, solver]) assert.ok(r.seconds < 45, `stopped promptly (${r.seconds}s)`)

    // Once the RPC answers again, the same commands work with no manual cleanup.
    const up = { ...down, RPC_URL: c.rpc }
    assert.equal((await run(CLIENT, ['status'], up)).code, 0)
    assert.equal((await run(KEEPER, ['--once'], up)).code, 0)
    const solverUp = await run(SOLVER, ['--once', '--json'], up)
    assert.deepEqual(JSON.parse(solverUp.out.trim().split('\n').at(-1)).errors, [])
  } finally { c.stop() }
})

test('drand down: the keeper waits for the beacon without errors, then reveals once it is back', { skip: !enabled, timeout: 180_000 }, async () => {
  const c = await localChain({ timestamp: START, schedule: { start: START } })
  try {
    for (const t of [c.token0, c.token1]) await c.mint(user(10).address, t, 10n ** 20n)
    const committed = await c.cli(10, ['commit', 'sell', '10', '9'])
    assert.equal(committed.code, 0, committed.err)
    await c.warp(await c.read(c.settlement, 'BlindfoldSettlement', 'revealOpens', [0n]))

    // drand unreachable: a recorded client that knows no rounds, which fails exactly like a network outage.
    const fixture = JSON.parse(readFileSync(DRAND, 'utf8'))
    const empty = join(c.dir, 'drand-down.json')
    writeFileSync(empty, JSON.stringify({ ...fixture, rounds: {} }))
    const env = { RPC_URL: c.rpc, DEPLOYMENTS: c.deployments, KEEPER_INDEX: '1' }
    const waiting = await run(KEEPER, ['--once'], { ...env, DRAND: empty })
    assert.equal(waiting.code, 0, waiting.err)
    const st = JSON.parse(waiting.out.trim().split('\n').at(-1))
    assert.equal(st.revealed, 0); assert.equal(st.waitingBeacon.length, 1); assert.deepEqual(st.errors, [])

    // The user is not stuck meanwhile: blockers explains the wait.
    const blockers = await c.cli(10, ['blockers'], { DRAND: empty })
    assert.equal(blockers.code, 0, blockers.err)
    assert.match(blockers.out, /#0 batch 0/)

    const back = await run(KEEPER, ['--once'], { ...env, DRAND })
    assert.equal(back.code, 0, back.err)
    assert.equal(JSON.parse(back.out.trim().split('\n').at(-1)).revealed, 1)
  } finally { c.stop() }
})
