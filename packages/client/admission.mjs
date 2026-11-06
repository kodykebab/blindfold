import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeAbiParameters, toHex } from 'viem'
import { ROOT, orderHash } from './lib.mjs'
import { nextFunding } from './admission-state.mjs'

function localProcess(executable, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', (b) => { stdout += b; if (stdout.length > 2_000_000) child.kill() })
    child.stderr.on('data', (b) => { stderr = (stderr + b).slice(-2000) })
    child.on('error', reject)
    child.stdin.on('error', () => {})
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`local prover failed (${code}): ${stderr}`))
      try { resolve(JSON.parse(stdout)) } catch { reject(new Error('local prover returned invalid JSON')) }
    })
    child.stdin.end(input ?? '')
  })
}

/** Generate both proofs locally. Witness files are private and removed after the child exits. */
export async function proveAdmission({ dep, owner, batch, round, funding, budgets, order, salt, env = process.env }) {
  if (!dep.admission?.manifestSha256 || !/^[a-f0-9]{64}$/.test(dep.admission.manifestSha256)) throw new Error('deployment must pin the local admission parameter manifest')
  if (Number(dep.chainId) !== 31337) throw new Error('single-party development parameters are restricted to local chain 31337')
  const executable = env.ADMISSION_PROVER || join(ROOT, 'packages/proof-bench/results/local-prover')
  const params = env.ADMISSION_PARAMS || join(ROOT, 'packages/proof-bench/results/admission-params')
  const request = { chainId: String(dep.chainId), settlement: dep.settlement, owner, batch: String(batch), round: String(round),
    step: String(funding.step), totals: funding.totals.map(String), budgets: budgets.map(String), oldBlind: funding.blind,
    zeroForOne: order.zeroForOne, amount: String(order.amountIn), minimum: String(order.minAmountOut), salt }
  const fixture = await localProcess(executable, ['fixture-local'], JSON.stringify(request))
  const admission = fixture[2].admission, witness = fixture[3].order
  const next = nextFunding(dep, owner, funding, batch, order, toHex(Uint8Array.from(witness.new_blind)))
  const hash = orderHash(dep.chainId, dep.settlement, batch, order, salt)
  if (toHex(Uint8Array.from(admission.old_root)) !== funding.root || toHex(Uint8Array.from(admission.new_root)) !== next.root || toHex(Uint8Array.from(admission.order_hash)) !== hash) throw new Error('prover and client disagree on the funding transition')
  const dir = mkdtempSync(join(tmpdir(), 'blindfold-witness-'))
  try {
    const file = join(dir, 'fixture.json')
    writeFileSync(file, JSON.stringify(fixture), { mode: 0o600 })
    const run = (mode) => localProcess(executable, ['prove-local', params, dep.admission.manifestSha256, mode, file])
    // Sequential to bound memory on a local laptop.
    const prep = await run('preparation'), online = await run('online')
    const proof = encodeAbiParameters(Array.from({ length: 4 }, () => ({ type: 'bytes' })), [prep.seal, prep.journal, online.seal, online.journal])
    return { hash, ciphertext: toHex(Uint8Array.from(witness.ciphertext)), proof, next }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
