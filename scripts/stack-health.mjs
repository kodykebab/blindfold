// Health of the local stack's services: one { ok, detail } per service and the next step when one is down.
import { accessSync, constants, readFileSync, statSync } from 'node:fs'

const alive = (child) => child != null && child.exitCode === null && child.signalCode == null
const age = (at, now) => Math.round((now - Date.parse(at)) / 1000)

/**
 * pub: a viem public client for the stack's RPC; dep: the deployment manifest; prover: the local-prover path;
 * keeper/solver: { child, status } where status is the service's last JSON status (or null); staleMs: how old a
 * status may be before the service counts as stuck.
 */
export async function stackHealth({ pub, dep, prover, keeper, solver, now = Date.now(), staleMs = 30_000 }) {
  const services = {}
  try {
    const chainId = await pub.getChainId()
    services.rpc = chainId === Number(dep.chainId)
      ? { ok: true, detail: `chain ${chainId}, block ${await pub.getBlockNumber()}` }
      : { ok: false, detail: `RPC is on chain ${chainId}, the deployment is on ${dep.chainId}`, fix: 'point RPC_URL at the deployment\'s chain' }
  } catch (e) {
    services.rpc = { ok: false, detail: `RPC unreachable: ${e.shortMessage ?? e.message}`, fix: 'start Anvil (scripts/dev.sh) or check RPC_URL' }
  }
  if (!services.rpc.ok) services.deployment = { ok: false, detail: 'unknown while the RPC is down', fix: services.rpc.fix }
  else {
    const missing = []
    for (const name of ['settlement', 'vault', 'token0', 'token1']) {
      const code = await pub.getCode({ address: dep[name] }).catch(() => undefined)
      if (!code || code === '0x') missing.push(name)
    }
    services.deployment = missing.length
      ? { ok: false, detail: `no contract code for ${missing.join(', ')}`, fix: 'the chain was restarted or DEPLOYMENTS is stale; restart scripts/dev.sh' }
      : { ok: true, detail: `settlement ${dep.settlement}` }
  }
  try {
    if (!prover) throw Error('ADMISSION_PROVER is not set')
    accessSync(prover, constants.X_OK)
    services.prover = { ok: true, detail: prover }
  } catch (e) {
    services.prover = { ok: false, detail: e.code === 'ENOENT' ? `no prover at ${prover}` : e.message, fix: 'build it: cd packages/proof-bench/circuit && go build -o <path> . (scripts/dev.sh does this when Go is installed)' }
  }
  for (const [name, { child, status }] of [['keeper', keeper], ['solver', solver]]) {
    if (!alive(child)) { services[name] = { ok: false, detail: `${name} is not running`, fix: `restart scripts/dev.sh; ${name} output above says why it stopped` }; continue }
    if (!status?.at) { services[name] = { ok: true, detail: 'running, no cycle reported yet' }; continue }
    const seconds = age(status.at, now), errors = status.errors ?? []
    if (seconds * 1000 > staleMs) services[name] = { ok: false, detail: `last cycle ${seconds}s ago`, fix: `${name} is stuck; check its output, then restart scripts/dev.sh` }
    else if (errors.length) services[name] = { ok: false, detail: errors.map((e) => e.message ?? e).join('; '), fix: `see ${name} output` }
    else services[name] = { ok: true, detail: `last cycle ${seconds}s ago` }
  }
  return { at: new Date(now).toISOString(), ok: Object.values(services).every((s) => s.ok), services }
}

/** The keeper's status file, or null while it has not written one yet. */
export function readJsonFile(path) {
  try { statSync(path); return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/** One line per service for the terminal. */
export const formatHealth = (h) => Object.entries(h.services)
  .map(([name, s]) => `${s.ok ? 'ok  ' : 'DOWN'} ${name.padEnd(10)} ${s.detail}${s.ok ? '' : ` → ${s.fix}`}`).join('\n')
