// Records a settled batch in Arkiv. A failure here is logged and swallowed: the settlement already landed.
import { mirrorSettled } from '../arkiv/index.mjs'

export async function mirrorSettlement(fields, arkiv, log = console.error) {
  try {
    await mirrorSettled([fields], arkiv)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`arkiv mirror failed for batch ${fields.batchId}: ${message}`)
  }
}
