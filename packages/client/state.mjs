// Local private state: the order and salt behind each commitment. Without them nobody but a drand-equipped keeper can
// reveal, so the client writes them before it reports a commit as done.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = () => process.env.CLIENT_STATE || fileURLToPath(new URL('./.state/', import.meta.url))
export const statePath = (dep, owner) => join(dir(), `${dep.chainId}-${dep.settlement}-${owner}.json`.toLowerCase())

const replacer = (_, v) => (typeof v === 'bigint' ? `${v}n` : v)
const reviver = (_, v) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)

export function loadState(dep, owner) {
  try {
    return JSON.parse(readFileSync(statePath(dep, owner), 'utf8'), reviver)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    return { chainId: dep.chainId, settlement: dep.settlement, owner, commitments: [] }
  }
}

export function writeState(dep, owner, state) {
  const path = statePath(dep, owner)
  mkdirSync(dir(), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify(state, replacer, 2))
  renameSync(`${path}.tmp`, path) // atomic: a crash never leaves half a file
}

/** Insert or update by hash: the client saves before sending and again with the commit id once it lands. */
export function saveCommitment(dep, owner, c) {
  const state = loadState(dep, owner)
  const i = state.commitments.findIndex((x) => x.hash === c.hash)
  if (i === -1) state.commitments.push(c)
  else state.commitments[i] = { ...state.commitments[i], ...c }
  writeState(dep, owner, state)
}

/**
 * Check a state file before it replaces local state (REVIEW S11): same chain, settlement and owner; every order hashes
 * to its saved hash; every entry with an id matches that commitment on chain. chainHashes: Map(id → onchain hash).
 * Returns a list of problems; empty means safe to import.
 */
export function validateState(state, { dep, owner, orderHash, chainHashes }) {
  const problems = []
  if (state.chainId !== dep.chainId || state.settlement?.toLowerCase() !== dep.settlement.toLowerCase()) problems.push('state is for another chain or settlement')
  if (state.owner?.toLowerCase() !== owner.toLowerCase()) problems.push(`state belongs to ${state.owner}`)
  for (const c of state.commitments ?? []) {
    if (c.order?.owner?.toLowerCase() !== owner.toLowerCase()) problems.push(`commitment ${c.hash}: order owner is not ${owner}`)
    else if (orderHash(dep.chainId, dep.settlement, c.batchId, c.order, c.salt) !== c.hash) problems.push(`commitment ${c.hash}: order and salt do not hash to it`)
    if (c.id != null && chainHashes.get(c.id) !== c.hash) problems.push(`commitment #${c.id}: chain has ${chainHashes.get(c.id) ?? 'nothing'} (stale or foreign state)`)
  }
  return problems
}

export const exportState = (dep, owner) => JSON.stringify(loadState(dep, owner), replacer, 2)
export const parseState = (text) => JSON.parse(text, reviver)

/** Merge imported entries into local state by hash; local entries the import lacks are kept. */
export function importState(dep, owner, imported) {
  const state = loadState(dep, owner)
  for (const c of imported.commitments) {
    const i = state.commitments.findIndex((x) => x.hash === c.hash)
    if (i === -1) state.commitments.push(c)
    else state.commitments[i] = { ...state.commitments[i], ...c }
  }
  writeState(dep, owner, state)
  return state.commitments.length
}
