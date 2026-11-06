// Local-helper latency samples. Results contain identities and measurements, never private witnesses.
import { cpus, totalmem, platform, release, arch } from 'node:os'
import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { prepareAdmission, proveAdmission } from '../client/admission.mjs'
import { initialFunding } from '../client/admission-state.mjs'
import { ROOT, newSalt } from '../client/lib.mjs'

const count = Number(process.argv[2] ?? 3)
if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error('usage: node measure-admission.mjs [1..100 samples]')
const params = process.env.ADMISSION_PARAMS || join(ROOT, 'packages/proof-bench/results/admission-params')
const prover = process.env.ADMISSION_PROVER || join(ROOT, 'packages/proof-bench/results/local-prover')
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const manifestBytes = readFileSync(join(params, 'manifest.json'))
const manifestSha256 = sha256(manifestBytes)
const dep = { chainId: 31337, settlement: `0x${'11'.repeat(20)}`, admission: { manifestSha256 } }
const owner = `0x${'22'.repeat(20)}`
const result = {
  schema: 1, measuredAt: new Date().toISOString(), mode: 'native local helper',
  device: { os: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
  node: process.version, gomaxprocs: process.env.GOMAXPROCS ?? 'runtime default', revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
  workingDiffSha256: sha256(execFileSync('git', ['diff', 'HEAD'], { cwd: ROOT })),
  proverSha256: sha256(readFileSync(prover)), manifestSha256, artifacts: JSON.parse(manifestBytes).files,
  cache: 'Each proof starts a new process and reloads parameters. OS file cache is uncontrolled; first sample is not a guaranteed cold-disk sample.',
  samples: [],
}
const path = join(ROOT, 'packages/proof-bench/results/advance-preparation-measurements.json')
mkdirSync(join(ROOT, 'packages/proof-bench/results'), { recursive: true })
for (let i = 0; i < count; i++) {
  const context = { dep, owner, batch: BigInt(i + 1), round: BigInt(1000 + i), env: { ...process.env, ADMISSION_PROVER: prover, ADMISSION_PARAMS: params } }
  const prepared = await prepareAdmission(context)
  const online = await proveAdmission({ ...context, prepared, funding: initialFunding(), budgets: [1000n, 1000n], order: { owner, zeroForOne: true, amountIn: 100n, minAmountOut: 90n }, salt: newSalt() })
  result.go = prepared.proof.goVersion
  result.samples.push({ preparationSeconds: prepared.elapsedSeconds, ...online.timings })
  writeFileSync(path, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  console.log(`sample ${i + 1}/${count}: preparation ${prepared.elapsedSeconds.toFixed(2)}s, online ${online.timings.elapsedSeconds.toFixed(2)}s`)
}
console.log(`measurements: ${path}`)
