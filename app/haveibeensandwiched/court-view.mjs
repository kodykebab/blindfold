import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Bonds, claims and payouts from already-decoded BondRegistry events. */
export function courtRows(events) {
  const rows = []
  for (const event of events ?? []) {
    const args = event.args ?? {}
    if (event.event === 'Bonded') rows.push(`Bond ${args.rpc}: ${args.amount} (total ${args.total})`)
    if (event.event === 'ClaimRegistered') rows.push(`Claim ${args.txHash}: weight ${args.weight} for ${args.beneficiary}`)
    if (event.event === 'Collected') rows.push(`Payout ${args.txHash}: ${args.payout} to ${args.beneficiary}`)
  }
  return rows
}

const COURT_ABI = [
  { type: 'event', name: 'Bonded', inputs: [
    { name: 'rpc', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256' },
    { name: 'total', type: 'uint256' },
  ] },
  { type: 'event', name: 'ClaimRegistered', inputs: [
    { name: 'incident', type: 'bytes32', indexed: true },
    { name: 'txHash', type: 'bytes32', indexed: true },
    { name: 'rpc', type: 'address', indexed: true },
    { name: 'beneficiary', type: 'address' },
    { name: 'weight', type: 'uint256' },
    { name: 'reserved', type: 'uint256' },
    { name: 'gasRefund', type: 'uint256' },
  ] },
  { type: 'event', name: 'Collected', inputs: [
    { name: 'incident', type: 'bytes32', indexed: true },
    { name: 'txHash', type: 'bytes32', indexed: true },
    { name: 'beneficiary', type: 'address', indexed: true },
    { name: 'payout', type: 'uint256' },
  ] },
]

const localRpc = (url) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url ?? '')

export function courtDeployment(env = process.env, root = new URL('../../', import.meta.url)) {
  const path = env.COURT_DEPLOYMENT || join(root.pathname, 'deployments/court.local.json')
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

function text(value) {
  if (typeof value === 'bigint') return value.toString()
  return value
}

/** Decode the ledger's events; the registry's other events (IncidentOpened, UnbondRequested, Unbonded) are skipped, not errors. */
export function decodeCourtLogs(logs, decodeEventLog) {
  const events = []
  for (const log of logs) {
    let decoded
    try { decoded = decodeEventLog({ abi: COURT_ABI, data: log.data, topics: log.topics }) } catch { continue }
    events.push({ event: decoded.eventName, args: Object.fromEntries(Object.entries(decoded.args).map(([key, value]) => [key, text(value)])) })
  }
  return events
}

/** Read BondRegistry events from a local RPC. Hidden when no Court deployment is configured. */
export async function loadCourt(env = process.env) {
  const deployment = courtDeployment(env)
  if (!deployment?.bondRegistry) return { hidden: true, rows: [] }
  const rpc = env.RPC_URL || 'http://127.0.0.1:8545'
  if (!localRpc(rpc)) return { hidden: false, unavailable: true, rows: [], message: 'Court ledger reads stay on this machine.' }
  try {
    const { decodeEventLog } = await import('../../packages/client/node_modules/viem/_esm/index.js')
    const response = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address: deployment.bondRegistry, fromBlock: '0x0', toBlock: 'latest' }] }),
      signal: AbortSignal.timeout(1500),
    })
    const body = await response.json()
    if (body.error) throw new Error(body.error.message || 'court log read failed')
    return { hidden: false, unavailable: false, rows: courtRows(decodeCourtLogs(body.result ?? [], decodeEventLog)) }
  } catch {
    return { hidden: false, unavailable: true, rows: [] }
  }
}
