import { createArkiv, recentBatches } from '../../packages/arkiv/index.mjs'

/** Recent public batches. A down or unconfigured Arkiv does not throw into the trading page. */
export async function loadHistory(env = process.env) {
  try {
    const arkiv = createArkiv(env)
    if (arkiv.unavailable) return { unavailable: true, message: 'history unavailable', batches: [] }
    return { unavailable: false, message: 'ok', batches: await recentBatches(arkiv) }
  } catch {
    return { unavailable: true, message: 'history unavailable', batches: [] }
  }
}
