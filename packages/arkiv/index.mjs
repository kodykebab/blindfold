// Public batch mirror. Chain state stays authoritative. ARKIV=off keeps an in-memory fake.
// ARKIV_RPC and ARKIV_KEY are read only when ARKIV=testnet. Nothing here sends order contents.

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

function memoryStore() {
  const rows = []
  return {
    mode: 'off',
    unavailable: false,
    async put(type, attrs) {
      if (type !== 'blindfold.batch') throw new Error(`unsupported entity ${type}`)
      const record = publicBatch({ ...attrs })
      rows.push(record.attrs)
      return record
    },
    async query(type) {
      if (type !== 'blindfold.batch') return []
      return rows.map((row) => ({ ...row }))
    },
  }
}

function downStore(reason) {
  const fail = async () => { throw new Error(reason) }
  return { mode: 'unavailable', unavailable: true, reason, put: fail, query: fail }
}

/** `ARKIV=off` (default) is in-memory. A testnet without ARKIV_RPC and ARKIV_KEY is unavailable. */
export function createArkiv(env = process.env) {
  const mode = env.ARKIV || 'off'
  if (mode === 'off') return memoryStore()
  if (mode === 'testnet' && env.ARKIV_RPC && env.ARKIV_KEY) return downStore('history unavailable')
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
