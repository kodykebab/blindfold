// Check a deployment against its artifacts and its own manifest before anyone trades on it.
//   RPC_URL=… node scripts/verify-deployment.mjs <deployment.json>
// Bytecode: each of our contracts' runtime code equals the Foundry artifact's deployedBytecode, with immutables and the
// metadata hash masked. Configuration: the settlement's parameters equal the manifest, the vault's operator is the
// settlement, the hook address carries exactly the beforeSwap permission bit, and with admission on, the verifier
// addresses and code match the manifest and ADMISSION_PARAMS/out/{preparation,online}.sol/Verifier.json.
// Prints one line per check; exits 0 when all match, 1 otherwise (2 on bad usage).
// Env: RPC_URL (default http://127.0.0.1:8545), CONTRACTS_OUT (default contracts/out), ADMISSION_PARAMS (admission on).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../packages/solver/package.json', import.meta.url))
const { createPublicClient, http } = require('viem')
const { artifactPath } = await import('../packages/solver/artifacts.mjs')

// Hooks.BEFORE_SWAP_FLAG; v4 reads a hook's permissions from the low 14 bits of its address.
export const HOOK_MASK = (1n << 14n) - 1n
export const BEFORE_SWAP = 1n << 7n

/** Runtime code with immutable slots zeroed and the trailing CBOR metadata (its length is the last two bytes) removed. */
export function normalizeCode(hex, immutableReferences = {}) {
  const code = Buffer.from(hex.replace(/^0x/, ''), 'hex')
  for (const refs of Object.values(immutableReferences)) for (const { start, length } of refs) code.fill(0, start, start + length)
  const meta = code.length >= 2 ? code.readUInt16BE(code.length - 2) + 2 : 0
  return code.subarray(0, meta <= code.length ? code.length - meta : code.length).toString('hex')
}

/** Equal once immutables and metadata are masked, using the artifact's reference positions on both sides. */
export function sameCode(onchain, deployedBytecode) {
  if (!onchain || onchain === '0x') return false
  const refs = deployedBytecode.immutableReferences ?? {}
  return normalizeCode(onchain, refs) === normalizeCode(deployedBytecode.object, refs)
}

const eq = (a, b) => (typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : String(a) === String(b))

async function main(file) {
  const dep = JSON.parse(readFileSync(file, 'utf8'))
  const rpc = process.env.RPC_URL || 'http://127.0.0.1:8545'
  const out = process.env.CONTRACTS_OUT || join(root, 'contracts/out')
  const pub = createPublicClient({ transport: http(rpc, { timeout: 15_000, retryCount: 0 }) })
  const admission = dep.admission && typeof dep.admission === 'object'
  const art = (name) => JSON.parse(readFileSync(artifactPath(out, name), 'utf8'))
  const names = { settlement: admission ? 'AdmittedSettlement' : 'BlindfoldSettlement', vault: admission ? 'AdmissionVault' : 'BlindfoldVault', hook: 'SealedPoolHook' }
  const abi = Object.fromEntries(Object.entries(names).map(([k, n]) => [k, art(n).abi]))
  const results = []
  const check = (name, ok, detail) => results.push({ name, ok, detail })

  const chainId = await pub.getChainId()
  check('chainId', chainId === Number(dep.chainId), `rpc ${chainId}, deployment ${dep.chainId}`)

  const codeOf = async (address) => (address ? pub.getCode({ address }) : undefined)
  const bytecode = async (label, address, deployedBytecode) => {
    if (!address) return check(`${label} bytecode`, false, 'no address in the deployment file')
    const code = await codeOf(address)
    check(`${label} bytecode`, sameCode(code, deployedBytecode), !code || code === '0x' ? `no code at ${address}` : sameCode(code, deployedBytecode) ? 'match' : `mismatch at ${address}`)
  }
  await bytecode('settlement', dep.settlement, art(names.settlement).deployedBytecode)
  await bytecode('vault', dep.vault, art(names.vault).deployedBytecode)

  const read = (key, functionName, args = [], address = dep[key]) => pub.readContract({ address, abi: abi[key], functionName, args })
  const s = (fn) => read('settlement', fn)
  // settlement configuration against the deployment file; a field the file doesn't record is a finding too
  const fields = {
    vault: () => s('vault'), token0: () => s('token0'), token1: () => s('token1'), depositToken: () => s('depositToken'),
    depositAmount: () => s('depositAmount'), commitFee: () => s('commitFee'), bountyBps: () => s('bountyBps'), toleranceBps: () => s('toleranceBps'),
    treasury: () => s('treasury'), poolManager: () => s('manager'),
  }
  for (const [name, get] of Object.entries(fields)) {
    let actual
    try { actual = await get() } catch (e) { check(name, false, `settlement read failed: ${e.shortMessage ?? e.message}`); continue }
    if (dep[name] == null) check(name, false, `settlement has ${actual}; the deployment file does not record ${name}`)
    else check(name, eq(actual, dep[name]), `settlement ${actual}, deployment ${dep[name]}`)
  }
  for (const name of ['start', 'batchLength', 'revealLength', 'settleLength']) {
    const actual = await s(name).catch(() => undefined)
    const expected = dep.schedule?.[name]
    if (expected == null) check(`schedule.${name}`, false, `settlement has ${actual}; the deployment file does not record schedule.${name}`)
    else check(`schedule.${name}`, eq(actual, expected), `settlement ${actual}, deployment ${expected}`)
  }

  const operator = await read('vault', 'operator').catch(() => undefined)
  check('vault operator', eq(operator, dep.settlement), `operator ${operator}, settlement ${dep.settlement}`)

  // the hook the settlement's pool key names
  const key = await s('poolKey').catch(() => undefined)
  const hook = key?.hooks
  if (dep.hook != null) check('hook', eq(hook, dep.hook), `pool key ${hook}, deployment ${dep.hook}`)
  if (!hook || BigInt(hook) === 0n) check('hook permissions', false, 'the settlement\'s pool key has no hook')
  else {
    check('hook permissions', (BigInt(hook) & HOOK_MASK) === BEFORE_SWAP, `low bits ${(BigInt(hook) & HOOK_MASK).toString(2)}, expected beforeSwap only (${BEFORE_SWAP.toString(2)})`)
    await bytecode('hook', hook, art(names.hook).deployedBytecode)
    const [hookManager, hookSettlement] = await Promise.all(['manager', 'settlement'].map((fn) => read('hook', fn, [], hook).catch(() => undefined)))
    check('hook settlement', eq(hookSettlement, dep.settlement), `hook settlement ${hookSettlement}`)
    const manager = await s('manager')
    check('hook manager', eq(hookManager, manager), `hook manager ${hookManager}, settlement manager ${manager}`)
  }

  if (admission) {
    const params = process.env.ADMISSION_PARAMS
    if (!params) check('admission parameters', false, 'admission is on: set ADMISSION_PARAMS to the parameter directory')
    else {
      const manifest = join(params, 'manifest.json')
      const sha = existsSync(manifest) ? createHash('sha256').update(readFileSync(manifest)).digest('hex') : null
      check('admission manifest', sha === dep.admission.manifestSha256, `ADMISSION_PARAMS manifest ${sha ?? 'missing'}, deployment ${dep.admission.manifestSha256}`)
    }
    for (const mode of ['preparation', 'online']) {
      const label = `${mode}Verifier`
      const actual = await s(label).catch(() => undefined)
      check(label, eq(actual, dep.admission[label]), `settlement ${actual}, deployment ${dep.admission[label]}`)
      if (params) await bytecode(label, actual, JSON.parse(readFileSync(join(params, 'out', `${mode}.sol`, 'Verifier.json'), 'utf8')).deployedBytecode)
    }
  }

  for (const r of results) console.log(`${r.ok ? 'ok      ' : 'MISMATCH'} ${r.name}: ${r.detail}`)
  const bad = results.filter((r) => !r.ok)
  console.log(bad.length ? `verify-deployment: ${bad.length} mismatch(es): ${bad.map((r) => r.name).join(', ')}` : 'verify-deployment: everything matches')
  return bad.length ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2]
  if (!file) { console.error('usage: RPC_URL=… node scripts/verify-deployment.mjs <deployment.json>'); process.exit(2) }
  main(file).then((code) => { process.exitCode = code }, (e) => { console.error(`verify-deployment: ${e.shortMessage ?? e.message}`); process.exitCode = 1 })
}
