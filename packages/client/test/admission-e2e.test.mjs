import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { localChain, user, DEPOSIT, DRAND } from './chain.mjs'
import { initialFunding } from '../admission-state.mjs'
import { proveAdmission, consumePreparation } from '../admission.mjs'
import { loadState, writeState, parseState } from '../state.mjs'
import { newSalt, decrypt, drandClient } from '../lib.mjs'

// Explicit opt-in: fresh real proofs need local parameters and substantially more memory/time than unit tests.
test('real proofs: admission rejection, resumable submission, cumulative state, export/restore and release', { skip: !process.env.ADMISSION_PARAMS, timeout: 600000 }, async () => {
  const params = process.env.ADMISSION_PARAMS
  const manifestSha256 = process.env.ADMISSION_MANIFEST_SHA256
  assert.match(manifestSha256 ?? '', /^[0-9a-f]{64}$/)
  const timestamp = 1692803367n + (1000000n - 3n) * 3n - 600n // with the start pinned below, batch 1 targets round 1000000 (the recorded beacon)
  const c = await localChain({ timestamp, admission: { params, manifestSha256 }, schedule: { start: Number(timestamp), batchLength: 300, settleLength: 30 }, fee: 1n })
  const oldState = process.env.CLIENT_STATE
  try {
    process.env.CLIENT_STATE = join(c.dir, 'state')
    const dep = JSON.parse(readFileSync(c.deployments, 'utf8')), owner = user(10).address
    for (const token of [c.token0, c.token1]) {
      await c.mint(owner, token, 100n * 10n ** 18n)
      await c.write(token, 'MockERC20', 'approve', [c.vault, 100n * 10n ** 18n], user(10))
      await c.write(c.vault, 'BlindfoldVault', 'deposit', [token, 100n * 10n ** 18n], user(10))
    }
    assert.notEqual((await c.cli(10, ['prepare-admission', '-1'])).code, 0)
    const advanced = await c.cli(10, ['prepare-admission', '1'])
    assert.equal(advanced.code, 0, advanced.err)
    assert.equal(loadState(dep, owner).preparation.batch, '1')
    const beforeFailure = loadState(dep, owner).preparation
    const failedPrep = await c.cli(10, ['prepare-admission', '1'], { ADMISSION_PROVER: '/usr/bin/false' })
    assert.notEqual(failedPrep.code, 0)
    assert.deepEqual(loadState(dep, owner).preparation, beforeFailure)
    const wrongNetwork = join(c.dir, 'wrong-network.json')
    writeFileSync(wrongNetwork, JSON.stringify({ ...dep, chainId: 1 }))
    const foreign = await c.cli(10, ['prepare-admission', '1'], { DEPLOYMENTS: wrongNetwork })
    assert.notEqual(foreign.code, 0); assert.match(foreign.err, /RPC network differs/)

    // An early order goes into the current batch inline and leaves the later batch's preparation untouched.
    const early = await c.cli(10, ['commit', 'sell', '1', '1', '--dry-run'])
    assert.equal(early.code, 0, early.err); assert.match(early.out, /in batch 0/)
    assert.equal(loadState(dep, owner).preparation.batch, '1')
    await c.warp(await c.read(c.settlement, 'AdmittedSettlement', 'commitsClose', [0n]))
    const batch = await c.read(c.settlement, 'AdmittedSettlement', 'currentBatch')
    const round = await c.read(c.settlement, 'AdmittedSettlement', 'targetRound', [batch])
    const closes = await c.read(c.settlement, 'AdmittedSettlement', 'commitsClose', [batch])
    const funding = initialFunding(), salt = newSalt()
    const order = { owner, zeroForOne: true, amountIn: 10n ** 18n, minAmountOut: 1n }
    const prepared = consumePreparation(loadState(dep, owner), { dep, owner, batch, round }, (state) => writeState(dep, owner, state))
    const result = await proveAdmission({ dep, owner, batch, round, prepared, funding, budgets: [100n * 10n ** 18n, 100n * 10n ** 18n - DEPOSIT - 1n], order, salt })
    assert.equal(result.timings.advancePreparation, true)
    assert.equal(loadState(dep, owner).preparation, undefined)
    console.log('advance preparation measurements:', JSON.stringify({ preparationSeconds: prepared.elapsedSeconds, ...result.timings }))
    assert.equal(round, 1000000n)
    assert.deepEqual(await decrypt(result.ciphertext, drandClient(DRAND)), { order, salt })
    const args = [batch, result.hash, result.ciphertext, result.proof]
    const reject = async (args, who = user(10)) => {
      await assert.rejects(c.write(c.settlement, 'AdmittedSettlement', 'admit', args, who))
      assert.equal(await c.read(c.settlement, 'AdmittedSettlement', 'commitCount'), 0n)
      assert.equal(await c.read(c.vault, 'BlindfoldVault', 'openCommitments', [owner]), 0n)
    }
    await reject([batch, result.hash, `${result.ciphertext.slice(0, -2)}00`, result.proof])
    await reject(args, user(11))
    await reject([batch, result.hash, result.ciphertext, `${result.proof}00`])
    const mutated = `${result.proof.slice(0, -2)}${result.proof.endsWith('00') ? '01' : '00'}`
    await reject([batch, result.hash, result.ciphertext, mutated])
    await assert.rejects(c.write(c.settlement, 'AdmittedSettlement', 'commit', [batch, result.hash, result.ciphertext], user(10)))
    // Simulate an interruption after durable private state was written but before the transaction was sent.
    const saved = loadState(dep, owner)
    saved.commitments.push({ id: null, batchId: batch, round, hash: result.hash, order, salt })
    saved.admission = { ...funding, pending: { ...result, batch, closes } }
    writeState(dep, owner, saved)
    const submissionStart = performance.now()
    const resume = await c.cli(10, ['resume-admission'])
    console.log('isolated Anvil resume/submission/inclusion seconds:', (performance.now() - submissionStart) / 1000)
    assert.equal(resume.code, 0, resume.err)
    assert.equal(await c.read(c.settlement, 'AdmittedSettlement', 'commitCount'), 1n)
    const again = await c.cli(10, ['resume-admission'])
    assert.equal(again.code, 0, again.err)
    assert.equal(await c.read(c.settlement, 'AdmittedSettlement', 'commitCount'), 1n)
    await assert.rejects(c.write(c.settlement, 'AdmittedSettlement', 'admit', args, user(10)))
    const secondPrep = await c.cli(10, ['prepare-admission', String(batch)])
    assert.equal(secondPrep.code, 0, secondPrep.err)
    const buy = await c.cli(10, ['commit', 'buy', '1', '0.000000000000000001'])
    assert.equal(buy.code, 0, buy.err)
    const final = loadState(dep, owner)
    assert.equal(final.preparation, undefined)
    assert.match(buy.out, /generating the online admission proof/)
    assert.deepEqual(final.admission.totals, [10n ** 18n, 10n ** 18n])
    assert.equal(final.admission.step, 2n)
    const exported = join(c.dir, 'backup.json')
    assert.equal((await c.cli(10, ['export-state', exported])).code, 0)
    const restored = await c.cli(10, ['import-state', exported], { CLIENT_STATE: join(c.dir, 'restored') })
    assert.equal(restored.code, 0, restored.err)
    const bad = parseState(readFileSync(exported, 'utf8')); bad.admission.totals[0] = 0n
    writeFileSync(join(c.dir, 'bad.json'), JSON.stringify(bad, (_, v) => typeof v === 'bigint' ? `${v}n` : v))
    assert.notEqual((await c.cli(10, ['import-state', join(c.dir, 'bad.json')])).code, 0)
    const empty = await c.cli(10, ['commit', 'sell', '1', '1', '--dry-run'], { CLIENT_STATE: join(c.dir, 'empty') })
    assert.notEqual(empty.code, 0); assert.match(empty.err, /stale or missing/)
    // Exercise both ordinary execution and the unrevealed release policy from the same accepted state.
    await c.warp(closes - 1n)
    const late = await c.cli(10, ['commit', 'sell', '1', '1'])
    assert.notEqual(late.code, 0); assert.match(late.err, /preflight failed/)
    assert.equal(await c.read(c.settlement, 'AdmittedSettlement', 'commitCount'), 2n)
    const snapshot = await c.pub.request({ method: 'evm_snapshot' })
    await c.warp(await c.read(c.settlement, 'AdmittedSettlement', 'revealOpens', [batch]))
    for (const commitment of final.commitments) await c.write(c.settlement, 'AdmittedSettlement', 'reveal', [commitment.id, commitment.order, commitment.salt], user(10))
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'lockedOf', [owner, c.token0]), 10n ** 18n)
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'lockedOf', [owner, c.token1]), 10n ** 18n)
    await c.warp(await c.read(c.settlement, 'AdmittedSettlement', 'revealCloses', [batch]))
    const [first] = final.commitments
    await c.write(c.settlement, 'AdmittedSettlement', 'settlePeer', [batch, first.id, first.order.amountIn])
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'openCommitments', [owner]), 0n)
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'freeBalance', [owner, c.token0]), 100n * 10n ** 18n)
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'freeBalance', [owner, c.token1]), 100n * 10n ** 18n - 2n)
    for (const token of ['token0', 'token1']) {
      const withdraw = await c.cli(10, ['withdraw', token, 'all'])
      assert.equal(withdraw.code, 0, withdraw.err)
    }
    assert.equal(await c.pub.request({ method: 'evm_revert', params: [snapshot] }), true)
    await c.warp(await c.read(c.settlement, 'AdmittedSettlement', 'revealCloses', [batch]))
    const cleanup = await c.cli(10, ['cleanup'])
    assert.equal(cleanup.code, 0, cleanup.err)
    assert.equal(await c.read(c.vault, 'BlindfoldVault', 'openCommitments', [owner]), 0n)
    assert.equal((await c.cli(10, ['resume-admission'])).code, 0)
    assert.equal(loadState(dep, owner).admission.step, 0n)
  } finally {
    c.stop()
    if (oldState === undefined) delete process.env.CLIENT_STATE; else process.env.CLIENT_STATE = oldState
  }
})

test('real proofs: too little time left rolls the order into the next batch, using the key prepared for it', { skip: !process.env.ADMISSION_PARAMS, timeout: 600000 }, async () => {
  const params = process.env.ADMISSION_PARAMS
  const manifestSha256 = process.env.ADMISSION_MANIFEST_SHA256
  const timestamp = 1692803367n + (1000000n - 3n) * 3n - 600n
  const c = await localChain({ timestamp, admission: { params, manifestSha256 }, schedule: { start: Number(timestamp), batchLength: 300, settleLength: 30 }, fee: 1n })
  const oldState = process.env.CLIENT_STATE
  try {
    process.env.CLIENT_STATE = join(c.dir, 'state')
    const dep = JSON.parse(readFileSync(c.deployments, 'utf8')), owner = user(10).address
    for (const token of [c.token0, c.token1]) {
      await c.mint(owner, token, 100n * 10n ** 18n)
      await c.write(token, 'MockERC20', 'approve', [c.vault, 100n * 10n ** 18n], user(10))
      await c.write(c.vault, 'BlindfoldVault', 'deposit', [token, 100n * 10n ** 18n], user(10))
    }
    const close = await c.read(c.settlement, 'AdmittedSettlement', 'commitsClose', [0n])
    await c.warp(close - 40n)
    // with 40 s left, preparation picks the next batch by itself
    const prep = await c.cli(10, ['prepare-admission'])
    assert.equal(prep.code, 0, prep.err)
    assert.match(prep.out, /prepared batch 1 /)
    assert.equal(loadState(dep, owner).proving.preparation.length, 1)
    // a live chain from here on: blocks keep coming while the client proves and waits
    await c.warp(close - 35n)
    await c.pub.request({ method: 'evm_setIntervalMining', params: [1] }) // anvil takes seconds
    const r = await c.cli(10, ['commit', 'sell', '1', '0.9'])
    await c.pub.request({ method: 'evm_setIntervalMining', params: [0] })
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /the order goes into batch 1 and is submitted when it opens/)
    assert.match(r.out, /generating the online admission proof locally/)
    assert.match(r.out, /admitted #/)
    const ids = await c.read(c.settlement, 'AdmittedSettlement', 'commitIdsOf', [1n])
    assert.equal(ids.length, 1)
    assert.equal((await c.read(c.settlement, 'AdmittedSettlement', 'commitIdsOf', [0n])).length, 0)
    const state = loadState(dep, owner)
    assert.equal(state.preparation, undefined)
    assert.equal(state.commitments[0].batchId, 1n)
    assert.equal(state.proving.online.length, 1)
    // the key was used: keep-ready prepares the next one, then leaves it while it still serves
    let k = await c.cli(10, ['keep-ready', '--once'])
    assert.equal(k.code, 0, k.err)
    assert.match(k.out, /prepared batch \d+ /)
    const kept = loadState(dep, owner).preparation.batch
    k = await c.cli(10, ['keep-ready', '--once'])
    assert.equal(k.code, 0, k.err)
    assert.match(k.out, new RegExp(`a key for batch ${kept} is ready`))
  } finally {
    c.stop()
    if (oldState === undefined) delete process.env.CLIENT_STATE; else process.env.CLIENT_STATE = oldState
  }
})
