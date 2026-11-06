// Remove temp dirs a killed process left behind (witness files, backup copies). Only our own prefix, only old ones:
// a live proof takes minutes, so anything older than maxAgeMs belongs to a process that is gone.
import { readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function sweepStale(prefix, { maxAgeMs = 30 * 60_000, dir = tmpdir(), now = Date.now() } = {}) {
  const removed = []
  let names = []
  try { names = readdirSync(dir) } catch { return removed }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const path = join(dir, name)
    try {
      const s = statSync(path)
      if (!s.isDirectory() || now - s.mtimeMs < maxAgeMs) continue
      rmSync(path, { recursive: true, force: true })
      removed.push(path)
    } catch {} // another process may be removing it too
  }
  return removed
}
