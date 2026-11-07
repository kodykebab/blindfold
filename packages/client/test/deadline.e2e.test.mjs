// Batch-deadline boundaries and an interrupted commit, through the real CLI on its own anvil.
// Opt-in (needs anvil and built contracts): DEADLINE_E2E=1 node --test test/deadline.e2e.test.mjs
// Each boundary transaction is pinned to an exact second: warp(t) mines a block at t, pin(t) fixes the next block's time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEther } from 'viem'
import { localChain, user, CLI, DRAND, DEPOSIT } from './chain.mjs'
import { loadAbi } from '../lib.mjs'

const enabled = process.env.DEADLINE_E2E === '1'
const reviver = (_, v) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)
const stateFile = (c, i) => join(c.dir, 'state', `31337-${c.settlement}-${user(i).address}.json`.toLowerCase())
const savedState = (c, i) => JSON.parse(readFileSync(stateFile(c, i), 'utf8'), reviver)

async function until(check, what, ms = 30_000) {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await check()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function setup() {
  // long batches, so funding several accounts in real time never runs into commitsClose
  const c = await localChain({ schedule: { batchLength: 300 } })
  const abi = loadAbi('BlindfoldSettlement')
  const pin = (t) => c.pub.request({ method: 'evm_setNextBlockTimestamp', params: [Number(t)] })
  const latest = async () => (await c.pub.getBlock({ blockTag: 'latest' })).timestamp
  const nonce = (i) => c.pub.getTransactionCount({ address: user(i).address, blockTag: 'pending' })
  const sched = async (b) => Object.fromEntries(await Promise.all(['commitsClose', 'revealOpens', 'revealCloses', 'settleCloses']
    .map(async (n) => [n, await c.read(c.settlement, 'BlindfoldSettlement', n, [b])])))
  const simulate = (i, functionName, args, blockTag) =>
    c.pub.simulateContract({ account: user(i).address, address: c.settlement, abi, functionName, args, blockTag })
  // fund the vault up front, so a commit is a single transaction and lands exactly one block after the CLI reads
  const fund = async (i) => {
    for (const t of [c.token0, c.token1]) await c.mint(user(i).address, t, parseEther('100'))
    for (const [tok, amt] of [['token0', '10'], ['token1', '5']]) assert.equal((await c.cli(i, ['deposit', tok, amt])).code, 0)
  }
  return { c, pin, latest, nonce, sched, simulate, fund }
}

test('every deadline boundary through the CLI agrees with the contract to the second', { skip: !enabled, timeout: 180_000 }, async () => {
  const { c, pin, latest, nonce, sched, simulate, fund } = await setup()
  try {
    for (const i of [10, 11, 12]) await fund(i)
    const s = await sched(0n)
    assert.equal(await c.read(c.settlement, 'BlindfoldSettlement', 'currentBatch'), 0n)
    let r = await c.cli(11, ['commit', 'sell', '10', '9'])
    assert.equal(r.code, 0, r.err)

    // commit landing at commitsClose − 1: accepted
    await c.warp(s.commitsClose - 2n)
    await pin(s.commitsClose - 1n)
    r = await c.cli(10, ['commit', 'sell', '10', '9'], { CLIENT_MIN_LEAD_SECONDS: '0' })
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /committed #1 to round/)
    assert.equal(await latest(), s.commitsClose - 1n, 'the commit landed on commitsClose − 1')
    assert.deepEqual(await c.read(c.settlement, 'BlindfoldSettlement', 'commitIdsOf', [0n]), [0n, 1n])

    // a commit read now would land at commitsClose: the CLI refuses before encrypting or paying gas
    const before = { n: await nonce(12), eth: await c.pub.getBalance({ address: user(12).address }) }
    r = await c.cli(12, ['commit', 'sell', '10', '9'], { CLIENT_MIN_LEAD_SECONDS: '0' })
    assert.equal(r.code, 1)
    assert.match(r.err, /preflight failed:\s+batch 0 closes in 1s; wait for the next one/)
    assert.equal(await nonce(12), before.n, 'no transaction sent')
    assert.equal(await c.pub.getBalance({ address: user(12).address }), before.eth, 'no gas spent')
    // and the contract agrees: the same commit is fine now but reverts once its block is at commitsClose
    const hash = `0x${'11'.repeat(32)}`
    await simulate(12, 'commit', [0n, hash, '0x'], 'latest')
    await pin(s.commitsClose)
    await assert.rejects(simulate(12, 'commit', [0n, hash, '0x'], 'pending'), /NotCurrentBatch/)

    // reveal landing at revealCloses − 1: accepted
    await c.warp(s.revealCloses - 2n)
    r = await c.cli(10, ['blockers'])
    assert.match(r.out, /#1 batch 0 \(committed\): reveal/)
    await pin(s.revealCloses - 1n)
    r = await c.cli(10, ['cleanup'])
    assert.equal(r.code, 0, r.err)
    assert.equal(await latest(), s.revealCloses - 1n, 'the reveal landed on revealCloses − 1')
    assert.equal(Number((await c.read(c.settlement, 'BlindfoldSettlement', 'commitments', [1n]))[2]), 2, 'revealed')

    // a reveal read now would land at revealCloses: cleanup waits and sends nothing
    const n11 = await nonce(11)
    r = await c.cli(11, ['cleanup'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /#0 batch 0 \(committed\): wait 1s — reveal window closes in 1s, too soon for a reveal to land; it can be slashed after/)
    assert.equal(await nonce(11), n11, 'no transaction sent')
    // and the contract agrees: the reveal is fine now but reverts at revealCloses
    const [{ order, salt }] = savedState(c, 11).commitments
    await simulate(11, 'reveal', [0n, order, salt], 'latest')
    await pin(s.revealCloses)
    await assert.rejects(simulate(11, 'reveal', [0n, order, salt], 'pending'), /OutsideRevealWindow/)
    await c.warp(s.revealCloses)
    r = await c.cli(11, ['cleanup'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /#0 batch 0 \(committed\): slash/)
    assert.match(r.out, /nothing blocks withdrawal/)

    // settle window: one second before settleCloses cleanup waits, at settleCloses it expires the batch
    await c.warp(s.settleCloses - 1n)
    r = await c.cli(10, ['cleanup'])
    assert.match(r.out, /#1 batch 0 \(revealed\): wait 1s — revealed, waiting for settlement/)
    assert.equal(await c.read(c.settlement, 'BlindfoldSettlement', 'finalized', [0n]), false)
    await c.warp(s.settleCloses)
    r = await c.cli(10, ['cleanup'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /#1 batch 0 \(revealed\): expire/)
    assert.match(r.out, /nothing blocks withdrawal/)
    assert.equal(await c.read(c.settlement, 'BlindfoldSettlement', 'finalized', [0n]), true)
    for (const tok of ['token0', 'token1']) {
      r = await c.cli(10, ['withdraw', tok, 'all'])
      assert.equal(r.code, 0, r.err)
    }
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'openCommitments', [user(10).address]), 0n)
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'balanceOf', [user(10).address, c.token0]), 0n)
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'balanceOf', [user(10).address, c.token1]), 0n)
  } finally { c.stop() }
})

test('a commit killed after sending its transaction is tracked and recoverable, not lost', { skip: !enabled, timeout: 180_000 }, async () => {
  const { c, nonce, sched, fund } = await setup()
  try {
    await fund(10)
    const s = await sched(0n)
    // hold the transaction in the mempool, so the CLI is provably past sending and still waiting to print
    await c.pub.request({ method: 'evm_setAutomine', params: [false] })
    const sent = await nonce(10)
    const cli = spawn(process.execPath, [CLI, 'commit', 'sell', '10', '9'], {
      env: { ...process.env, RPC_URL: c.rpc, DEPLOYMENTS: c.deployments, CLIENT_ACCOUNT_INDEX: '10', DRAND, CLIENT_STATE: join(c.dir, 'state') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    cli.stdout.on('data', (d) => { out += d })
    await until(async () => (await nonce(10)) > sent, 'the commit transaction in the mempool')
    cli.kill('SIGKILL')
    await new Promise((r) => cli.once('exit', r))
    assert.match(out, /costs:/)
    assert.doesNotMatch(out, /committed #/, 'killed before it reported the commit')
    assert.ok(existsSync(`${stateFile(c, 10)}.lock`), 'the killed command left its lock')
    const [saved] = savedState(c, 10).commitments
    assert.equal(saved.id, null, 'saved before sending; the id was never recorded')
    await c.pub.request({ method: 'evm_mine', params: [] })
    await c.pub.request({ method: 'evm_setAutomine', params: [true] })

    // the order reached the chain and the client still finds it
    let r = await c.cli(10, ['status'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /open commitments: 1/)
    r = await c.cli(10, ['track'])
    assert.match(r.out, /#0 batch 0: committed \(sealed\)/)
    r = await c.cli(10, ['blockers'])
    assert.match(r.out, /#0 batch 0 \(committed\): wait \d+s — sealed until its drand round/)

    // cleanup clears the dead process's lock and reveals from the saved order, matched by hash
    await c.warp(s.revealOpens)
    r = await c.cli(10, ['blockers'])
    assert.match(r.out, /#0 batch 0 \(committed\): reveal — own saved order/)
    r = await c.cli(10, ['cleanup'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.err, /removed a stale state lock left by exited process \d+/)
    assert.match(r.out, /#0 batch 0 \(committed\): reveal/)
    r = await c.cli(10, ['track'])
    assert.match(r.out, /#0 batch 0: revealed \(sell 10 TKA for at least 9 TKB\)/)
    await c.warp(s.settleCloses)
    r = await c.cli(10, ['cleanup'])
    assert.match(r.out, /nothing blocks withdrawal/)
    r = await c.cli(10, ['withdraw', 'token0', 'all'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /withdrew 10 TK./)
    // revealing it ourselves kept the bounty: the whole deposit is back
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'balanceOf', [user(10).address, c.token1]), DEPOSIT)
  } finally { c.stop() }
})
