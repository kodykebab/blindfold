// Exports contain plaintext private state. Unread results expire, and worker restarts and locking discard them.
export async function clearExports(session) {
  const records = await session.get(null)
  const keys = Object.keys(records).filter((key) => key.startsWith('job:') && records[key]?.op === 'export')
  if (keys.length) await session.remove(keys)
}
