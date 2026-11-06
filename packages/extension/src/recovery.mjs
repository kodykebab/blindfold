// Recover bridge sends after a worker restart or dropped port. A completed result cannot remove its journal until
// any transaction hash is durable in the encrypted account state. Per-request ordering also covers replay bursts.
export function recovery({ session, save, onError = () => {} }) {
  const pending = new Map()
  const keyOf = (id) => `send:${id}`
  function queue(id, work) {
    const previous = pending.get(id) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(work)
    pending.set(id, current)
    current.finally(() => { if (pending.get(id) === current) pending.delete(id) }).catch(onError)
    return current
  }
  async function apply(key, entry) {
    if (entry.record && entry.hash && !entry.saved) {
      try {
        await save(entry, entry.hash)
        entry = { ...entry, saved: true }
        await session.set({ [key]: entry })
      } catch (e) { onError(e); return } // locked or unavailable: keep hash for unlock/restart
    }
    if (entry.done && (!entry.record || !entry.hash || entry.saved)) await session.remove(key)
  }
  return {
    handle(m) {
      return queue(m.id, async () => {
        const key = keyOf(m.id)
        let entry = (await session.get(key))[key]
        if (!entry) return
        const hash = m.hash ?? (m.type === 'result' ? m.hashes?.at(-1) : undefined)
        if (hash || m.type === 'result') {
          entry = { ...entry, ...(hash ? { hash } : {}), ...(m.type === 'result' ? { done: true } : {}) }
          await session.set({ [key]: entry }) // durable before asynchronous state recovery
        }
        await apply(key, entry)
      })
    },
    async drain() {
      const all = await session.get(null)
      await Promise.all(Object.keys(all).filter((k) => k.startsWith('send:')).map((key) => queue(key.slice(5), async () => {
        const entry = (await session.get(key))[key]
        if (entry) await apply(key, entry)
      })))
    },
  }
}
