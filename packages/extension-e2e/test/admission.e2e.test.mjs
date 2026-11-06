// E3: real-proof admission through the extension and the installed prover-helper, then reveal, settle and withdraw.
// Needs `bash packages/proof-bench/check-admission.sh` (local-prover, parameters, verifier artifacts). EXT_E2E=1.
// Same chain setup as packages/client/test/admission-e2e.test.mjs: anvil starts in the past so the batch's drand
// round (1000000) is in the recorded fixture, and the extension's tlock check decrypts the helper's ciphertext.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEther } from 'viem'
import { startChain, user, Q96 } from '../lib/chain.mjs'
import { launch, stopBridge, EXTENSION_DIST } from '../lib/browser.mjs'
import { onboard, run } from '../lib/extension.mjs'
import { hasGo, installHelper, realProverReady, sha256File, REAL } from '../lib/helper.mjs'

const skip = process.env.EXT_E2E !== '1' || (!existsSync(join(EXTENSION_DIST, 'manifest.json')) && 'no extension build')
  || (!hasGo && 'no go toolchain') || (!realProverReady() && 'no local-prover/parameters: run packages/proof-bench/check-admission.sh')
const me = user(10)
let c, b, installed, profile

before(async () => {
  if (skip) return
  const manifestSha256 = sha256File(join(REAL.params, 'manifest.json'))
  c = await startChain({ timestamp: 1692803367n + (1000000n - 3n) * 3n - 900n, admission: { params: REAL.params, manifestSha256 }, schedule: { batchLength: 900, settleLength: 30 } })
  for (const t of [c.dep.token0, c.dep.token1]) await c.mint(me.address, t, parseEther('100'))
  profile = mkdtempSync(join(tmpdir(), 'blindfold-e3-'))
  installed = installHelper(profile, REAL)
  b = await launch({ profile })
})
after(async () => {
  if (skip) return
  await b?.close()
  await stopBridge()
  await c?.stop()
  rmSync(installed, { recursive: true, force: true })
})

test('E3: two orders admitted with real proofs from the helper, revealed, settled at price 1 and withdrawn', { skip, timeout: 1_800_000 }, async () => {
  const { app } = await onboard(b, c.dep)
  const S = c.dep.settlement, read = (fn, args = []) => c.read(S, 'AdmittedSettlement', fn, args)
  const batch = await read('currentBatch')
  for (const [side, step] of [['sell', 1n], ['buy', 2n]]) {
    const r = await run(app, 'commit', { side, amountIn: '1', minOut: '0.000000000000000001' })
    assert.equal(r.state, 'done', `${r.error}\n${r.log?.join('\n')}`)
    assert.equal(typeof r.result.admitted, 'string')
    assert.equal((await read('admissionState', [me.address]))[2], step) // {batch, root, step}: funding advanced
  }
  assert.equal(await read('commitCount'), 2n)
  assert.ok(b.wallet.log.filter((x) => x.method === 'eth_sendTransaction').every((x) => [S, c.dep.vault, c.dep.token0, c.dep.token1].some((a) => a.toLowerCase() === x.params[0].to.toLowerCase())))

  await c.warp(await read('revealOpens', [batch]))
  let r = await run(app, 'cleanup', { dryRun: false })
  assert.equal(r.state, 'done', r.error)
  await c.warp(await read('revealCloses', [batch]))
  await c.write(S, 'AdmittedSettlement', 'settle', [batch, Q96], user(1))
  for (const token of ['token0', 'token1']) {
    r = await run(app, 'withdraw', { token, amount: 'all' })
    assert.equal(r.state, 'done', r.error)
  }
  assert.equal(await c.read(c.dep.vault, 'BlindfoldVault', 'openCommitments', [me.address]), 0n)
})
