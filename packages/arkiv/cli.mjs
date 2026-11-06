import { createArkiv, mirrorSettled, recentBatches } from './index.mjs'

const once = process.argv.includes('--once')
const arkiv = createArkiv()
if (arkiv.unavailable) {
  console.log('history unavailable')
  process.exit(0)
}
if (once) {
  console.log(JSON.stringify({ mode: arkiv.mode, batches: await recentBatches(arkiv) }))
  process.exit(0)
}
console.log(`ARKIV=off keeps settled batches in ${arkiv.file}. Pass --once to print them.`)
