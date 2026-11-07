// verify-deployment against a fresh local deployment: a clean pass, a wrong manifest field, and swapped vault code.
// Opt-in (needs anvil and built contracts): VERIFY_E2E=1 node --test scripts/verify-deployment.e2e.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localChain } from '../packages/client/test/chain.mjs'

const enabled = process.env.VERIFY_E2E === '1'
const SCRIPT = fileURLToPath(new URL('./verify-deployment.mjs', import.meta.url))
const verify = (rpc, file) => new Promise((resolve) => execFile(process.execPath, [SCRIPT, file], { env: { ...process.env, RPC_URL: rpc }, timeout: 60_000 },
  (e, out, err) => resolve({ code: e ? e.code : 0, out, err })))

test('verify-deployment passes a fresh deployment and names each mismatch', { skip: !enabled, timeout: 180_000 }, async () => {
  const c = await localChain({ v4: true })
  try {
    let r = await verify(c.rpc, c.deployments)
    assert.equal(r.code, 0, r.out + r.err)
    for (const name of ['settlement bytecode', 'vault bytecode', 'hook bytecode', 'vault operator', 'hook permissions', 'depositAmount', 'schedule.batchLength']) {
      assert.match(r.out, new RegExp(`^ok +${name}: `, 'm'))
    }
    assert.match(r.out, /verify-deployment: everything matches/)

    // a deployment file that records the wrong deposit
    const dep = JSON.parse(readFileSync(c.deployments, 'utf8'))
    const wrong = join(c.dir, 'wrong-deposit.json')
    writeFileSync(wrong, JSON.stringify({ ...dep, depositAmount: '1' }))
    r = await verify(c.rpc, wrong)
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /^MISMATCH depositAmount: settlement 5000000000000000000, deployment 1$/m)
    assert.match(r.out, /1 mismatch\(es\): depositAmount$/m)

    // the vault's code replaced with something else
    await c.pub.request({ method: 'anvil_setCode', params: [c.vault, await c.pub.getCode({ address: c.token0 })] })
    r = await verify(c.rpc, c.deployments)
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /^MISMATCH vault bytecode: mismatch at 0x[0-9a-fA-F]{40}$/m)
    assert.match(r.out, /^ok +settlement bytecode: match$/m)
  } finally { c.stop() }
})

// Needs generated development parameters (packages/proof-bench/README.md); scripts/e2e.sh --real-proof sets them.
test('with admission on, verifier addresses and code match the parameters', { skip: !enabled || !process.env.ADMISSION_PARAMS, timeout: 180_000 }, async () => {
  const params = process.env.ADMISSION_PARAMS
  const { createHash } = await import('node:crypto')
  const manifestSha256 = createHash('sha256').update(readFileSync(join(params, 'manifest.json'))).digest('hex')
  const c = await localChain({ admission: { params, manifestSha256 }, fee: 1n })
  try {
    let r = await verify(c.rpc, c.deployments)
    assert.equal(r.code, 0, r.out + r.err)
    for (const name of ['admission manifest', 'preparationVerifier', 'preparationVerifier bytecode', 'onlineVerifier', 'onlineVerifier bytecode']) {
      assert.match(r.out, new RegExp(`^ok +${name}: `, 'm'))
    }
    const dep = JSON.parse(readFileSync(c.deployments, 'utf8'))
    const swapped = join(c.dir, 'swapped-verifiers.json')
    writeFileSync(swapped, JSON.stringify({ ...dep, admission: { ...dep.admission, onlineVerifier: dep.admission.preparationVerifier } }))
    r = await verify(c.rpc, swapped)
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /^MISMATCH onlineVerifier: /m)
    // the online verifier's code replaced with the preparation verifier's
    await c.pub.request({ method: 'anvil_setCode', params: [dep.admission.onlineVerifier, await c.pub.getCode({ address: dep.admission.preparationVerifier })] })
    r = await verify(c.rpc, c.deployments)
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /^MISMATCH onlineVerifier bytecode: mismatch/m)
  } finally { c.stop() }
})
