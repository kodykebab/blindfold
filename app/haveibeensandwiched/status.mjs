// Parse the client status report for display. The unmodified CLI output remains available in the activity log.
export function parseStatus(text) {
  const lines = text.split(/\r?\n/)
  const account = lines.find((line) => /^account 0x[0-9a-f]{40}$/i.test(line))?.slice(8)
  const batch = lines.find((line) => /^batch \d+ \(chain time \d+\)$/.test(line))
  const open = lines.find((line) => /^\s*open commitments: \d+/.test(line))?.trim()
  const rows = []
  for (const line of lines) {
    const match = line.match(/^\s*(\S+)\s+wallet\s+(.+?)\s+\|\s+available\s+(.+?)\s+\|\s+reserved\s+(.+?)\s+\|\s+withdrawable\s+(.+?)\s*$/)
    if (match) rows.push({ token: match[1], wallet: match[2], available: match[3], reserved: match[4], withdrawable: match[5] })
  }
  if (!account || !batch || !open || !rows.length) return null
  const deadlines = lines.filter((line) => /^\s*-?\d+s\s+/.test(line)).map((line) => line.trim())
  const preparation = lines.find((line) => /^preparation: /.test(line)) ?? null
  return { account, batch, open, rows, deadlines, preparation }
}

// Only report stages the CLI has explicitly logged; elapsed time is not proof progress.
export function jobStage(job) {
  if (job.action === 'prepare-admission' && /preparing locally for batch/i.test(job.output)) return 'PREPARING'
  if (job.action === 'commit' && /local proving completed/i.test(job.output)) return 'FINALIZING'
  if (job.action === 'commit' && /generating (?:the online|both) admission proofs? locally/i.test(job.output)) return 'PROVING'
  return 'RUNNING'
}

export function preparedBatch(output) {
  return output.match(/(?:^|\n)prepared batch (\d+) in /)?.[1] ?? null
}
