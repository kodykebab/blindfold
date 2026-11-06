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
    let stdout = ''
    child.stdout.on('data', (b) => { stdout += b; if (stdout.length > 2_000_000) child.kill() })
    child.stderr.resume() // Prover diagnostics may contain private witness values; never forward them.
    child.on('error', reject)
    child.stdin.on('error', () => {})
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`local prover failed (${code}); check the local parameter files and request`))
      try { resolve(JSON.parse(stdout)) } catch { reject(new Error('local prover returned invalid JSON')) }
    })
    child.stdin.end(input ?? '')
  })
}

function proverConfig(dep, env) {
  if (!dep.admission?.manifestSha256 || !/^[a-f0-9]{64}$/.test(dep.admission.manifestSha256)) throw new Error('deployment must pin the local admission parameter manifest')
  if (Number(dep.chainId) !== 31337) throw new Error('single-party development parameters are restricted to local chain 31337')
  const executable = env.ADMISSION_PROVER || join(ROOT, 'packages/proof-bench/results/local-prover')
  const params = env.ADMISSION_PARAMS || join(ROOT, 'packages/proof-bench/results/admission-params')
  return { executable, params }
}
const context = (dep, owner, batch, round) => ({ chainId: String(dep.chainId), settlement: dep.settlement.toLowerCase(), owner: owner.toLowerCase(), batch: String(batch), round: String(round) })

async function proveFixture(config, pin, mode, fixture) {
  const dir = mkdtempSync(join(tmpdir(), 'blindfold-witness-'))
  try {
    const file = join(dir, 'fixture.json')
    writeFileSync(file, JSON.stringify(fixture), { mode: 0o600 })
    return await localProcess(config.executable, ['prove-local', config.params, pin, mode, file])
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** One private, order-independent preparation. Persist only under the existing state lock. */
export async function prepareAdmission({ dep, owner, batch, round, env = process.env }) {
  const config = proverConfig(dep, env)
  const started = performance.now()
  const { preparation, fixture } = await localProcess(config.executable, ['prepare-fixture-local'], JSON.stringify(context(dep, owner, batch, round)))
  const proof = await proveFixture(config, dep.admission.manifestSha256, 'preparation', fixture)
  return { version: 1, manifestSha256: dep.admission.manifestSha256, ...context(dep, owner, batch, round), preparation, proof,
    elapsedSeconds: (performance.now() - started) / 1000 }
}

export function validatePreparation(prepared, { dep, owner, batch, round }) {
  if (prepared?.version !== 1 || prepared.manifestSha256 !== dep.admission?.manifestSha256) throw new Error('preparation parameter identity changed; run prepare-admission again')
  for (const [key, value] of Object.entries(context(dep, owner, batch, round))) {
    if (prepared[key] !== value || prepared.preparation?.[key]?.toLowerCase() !== value) throw new Error('preparation account, deployment, batch or round changed; run prepare-admission again')
  }
  if (!/^0x[0-9a-f]+$/i.test(prepared.proof?.seal ?? '') || !/^0x[0-9a-f]+$/i.test(prepared.proof?.journal ?? '')) throw new Error('invalid preparation proof')
  return prepared
}

/** Consume durably before online encryption: interruption must never make a key available for another order. */
export function consumePreparation(state, expected, persist) {
  if (!state.preparation) return undefined
  const prepared = validatePreparation(state.preparation, expected)
  delete state.preparation
  persist(state)
  return prepared
}

/** Prove online using a consumed preparation, or preserve the existing inline two-proof path. */
export async function proveAdmission({ dep, owner, batch, round, funding, budgets, order, salt, prepared, env = process.env }) {
  const config = proverConfig(dep, env)
  const started = performance.now()
  if (prepared) validatePreparation(prepared, { dep, owner, batch, round })
  const request = { chainId: String(dep.chainId), settlement: dep.settlement, owner, batch: String(batch), round: String(round),
    step: String(funding.step), totals: funding.totals.map(String), budgets: budgets.map(String), oldBlind: funding.blind,
    zeroForOne: order.zeroForOne, amount: String(order.amountIn), minimum: String(order.minAmountOut), salt, ...(prepared ? { preparation: prepared.preparation } : {}) }
  const fixture = await localProcess(config.executable, ['fixture-local'], JSON.stringify(request))
  const admission = fixture[2].admission, witness = fixture[3].order
  const next = nextFunding(dep, owner, funding, batch, order, toHex(Uint8Array.from(witness.new_blind)))
  const hash = orderHash(dep.chainId, dep.settlement, batch, order, salt)
  if (toHex(Uint8Array.from(admission.old_root)) !== funding.root || toHex(Uint8Array.from(admission.new_root)) !== next.root || toHex(Uint8Array.from(admission.order_hash)) !== hash) throw new Error('prover and client disagree on the funding transition')
  // Sequential to bound memory on a local laptop.
  const prep = prepared?.proof ?? await proveFixture(config, dep.admission.manifestSha256, 'preparation', fixture)
  const online = await proveFixture(config, dep.admission.manifestSha256, 'online', fixture)
  const proof = encodeAbiParameters(Array.from({ length: 4 }, () => ({ type: 'bytes' })), [prep.seal, prep.journal, online.seal, online.journal])
  return { hash, ciphertext: toHex(Uint8Array.from(witness.ciphertext)), proof, next,
    timings: { advancePreparation: !!prepared, elapsedSeconds: (performance.now() - started) / 1000, preparation: { ...prep.timings, peakRssBytes: prep.peakRssBytes }, online: { ...online.timings, peakRssBytes: online.peakRssBytes } } }
}

/** Development margins for the measured native helper; override after measuring a different desktop. */
export function admissionLead(prepared, env = process.env) {
  const value = env.ADMISSION_MIN_LEAD_SECONDS ?? (prepared ? '120' : '180')
  if (!/^[1-9]\d*$/.test(value) || BigInt(value) >= 1n << 64n) throw new Error('ADMISSION_MIN_LEAD_SECONDS must be a positive uint64 number of seconds')
  return BigInt(value)
}
