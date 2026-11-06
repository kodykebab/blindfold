// Public batch mirror. Chain state stays authoritative.
// ARKIV=off writes packages/arkiv's JSON file so later processes see the same rows.
// ARKIV=testnet uses @arkiv-network/sdk when ARKIV_RPC and ARKIV_KEY are both set.
// ARKIV_KEY is read only to sign. It is never logged.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const PUBLIC_FIELDS = ['batchId', 'clearingPrice', 'orderCount', 'settleTx', 'pair']

export function publicBatch(event) {
  if (!event || typeof event !== 'object') throw new Error('settled batch is missing')
  for (const key of ['ciphertext', 'order', 'salt', 'owner', 'commitHash']) {
    if (event[key] != null) throw new Error('private order data is not stored')
  }
  const attrs = {}
  for (const key of PUBLIC_FIELDS) {
    if (event[key] == null || event[key] === '') throw new Error(`settled batch is missing ${key}`)
    attrs[key] = String(event[key])
  }
  return { type: 'blindfold.batch', attrs }
}

export function arkivPath(env = process.env) {
  if (env.ARKIV_FILE) return env.ARKIV_FILE
  const dir = env.CLIENT_STATE || join(process.cwd(), '.blindfold')
  return join(dir, 'arkiv-local.json')
}

function fileStore(file) {
  const read = () => {
    try {
      const rows = JSON.parse(readFileSync(file, 'utf8'))
      return Array.isArray(rows) ? rows : []
    } catch { return [] }
  }
  const write = (rows) => {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(rows), { mode: 0o600 })
    renameSync(tmp, file)
  }
  return {
    mode: 'off',
    unavailable: false,
    file,
    async put(type, attrs) {
      if (type !== 'blindfold.batch') throw new Error(`unsupported entity ${type}`)
      const record = publicBatch({ ...attrs })
      const rows = read()
      rows.push(record.attrs)
      write(rows)
      return record
    },
    async query(type) {
      if (type !== 'blindfold.batch') return []
      return read().map((row) => ({ ...row }))
    },
  }
}

function downStore(reason) {
  const fail = async () => { throw new Error(reason) }
  return { mode: 'unavailable', unavailable: true, reason, put: fail, query: fail }
}

function fieldValue(field) {
  if (field == null) return ''
  if (typeof field === 'object' && 'value' in field) return String(field.value)
  return String(field)
}

/** One query row, oldest-friendly. `$createdAt` is the Arkiv block, used only to sort. */
export function batchFromRow(row) {
  return {
    createdAt: row.$createdAt ?? 0n,
    batchId: fieldValue(row.batchId),
    pair: fieldValue(row.pair),
    clearingPrice: fieldValue(row.clearingPrice),
    orderCount: fieldValue(row.orderCount),
    settleTx: fieldValue(row.settleTx),
  }
}

async function defaultSdk(env) {
  const { privateKeyToAccount } = await import('viem/accounts')
  const key = env.ARKIV_KEY.startsWith('0x') ? env.ARKIV_KEY : `0x${env.ARKIV_KEY}`
  const account = privateKeyToAccount(key)
  const { createPublicClient, createWalletClient, ExpirationTime, defineSchema, str, u256 } = await import('@arkiv-network/sdk')
  const { rabdi } = await import('@arkiv-network/sdk/chains')
  const { http } = await import('viem')
  const chain = rabdi({ accessKey: '' })
  const transport = http(env.ARKIV_RPC)
  const Batch = defineSchema('blindfold.batch', {
    batchId: u256().indexed(),
    pair: str(),
    clearingPrice: str(),
    orderCount: u256(),
    settleTx: str(),
  })
  const pub = createPublicClient({ chain, transport })
  const wallet = createWalletClient({ chain, transport, account })
  return {
    async create(attrs) {
      await wallet.createEntity(Batch, {
        batchId: u256(BigInt(attrs.batchId)),
        pair: attrs.pair,
        clearingPrice: attrs.clearingPrice,
        orderCount: u256(BigInt(attrs.orderCount)),
        settleTx: attrs.settleTx,
      }, { expiration: ExpirationTime.fromDays(30) })
    },
    async query() {
      const { entities } = await pub.select({
        $createdAt: true, batchId: true, pair: true, clearingPrice: true, orderCount: true, settleTx: true,
      }).from(Batch).fetch()
      const rows = entities.map(batchFromRow)
      rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      return rows.map(({ createdAt, ...row }) => row)
    },
  }
}

function sdkStore(env, factory) {
  let pending = null
  const client = () => {
    if (!pending) {
      pending = Promise.resolve().then(() => factory(env)).catch((error) => { pending = null; throw error })
    }
    return pending
  }
  const call = async (fn) => {
    try { return await fn(await client()) }
    catch { throw new Error('history unavailable') }
  }
  return {
    mode: 'testnet',
    unavailable: false,
    async put(type, attrs) {
      if (type !== 'blindfold.batch') throw new Error(`unsupported entity ${type}`)
      const record = publicBatch({ ...attrs })
      await call((sdk) => sdk.create(record.attrs))
      return record
    },
    async query(type) {
      if (type !== 'blindfold.batch') return []
      return call((sdk) => sdk.query())
    },
  }
}

/** `ARKIV=off` (default) is the JSON file. Testnet without both credentials is unavailable. `sdk` replaces the network client in tests. */
export function createArkiv(env = process.env, { sdk = defaultSdk } = {}) {
  const mode = env.ARKIV || 'off'
  if (mode === 'off') return fileStore(arkivPath(env))
  if (mode === 'testnet' && env.ARKIV_RPC && env.ARKIV_KEY) return sdkStore(env, sdk)
  return downStore('history unavailable')
}

export async function mirrorSettled(events, arkiv = createArkiv()) {
  const written = []
  for (const event of events) written.push(await arkiv.put('blindfold.batch', publicBatch(event).attrs))
  return written
}

export async function recentBatches(arkiv = createArkiv()) {
  if (arkiv.unavailable) throw new Error(arkiv.reason || 'history unavailable')
  const rows = await arkiv.query('blindfold.batch')
  return rows.slice().reverse()
}
