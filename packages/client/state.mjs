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
