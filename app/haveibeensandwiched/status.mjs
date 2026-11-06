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
  const network = lines.find((line) => /^network \d+$/.test(line)) ?? null
  const pair = lines.find((line) => /^pair .+ \/ .+$/.test(line)) ?? null
  const preparation = lines.find((line) => /^preparation: /.test(line)) ?? null
  return { account, network, pair, batch, open, rows, deadlines, preparation }
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

// Unknown or incomplete output remains in the activity log instead of being guessed.
export function parseTrack(text) {
  if (text.trim() === 'no commitments') return []
  const lines = text.trim().split(/\r?\n/)
  const rows = []
  for (const line of lines) {
    const match = line.match(/^#(\d+) batch (\d+): (committed|revealed|padding|unfunded|slashed|released|filled|unfilled|expired) \(([^)]*)\)(.*)$/)
    if (!match) return null
    const detail = match[5].trim()
    const label = match[3] === 'filled' && detail.includes('[partial fill:') ? 'partially filled' : match[3]
    rows.push({ id: match[1], batch: match[2], state: label, detail: [match[4], detail].filter(Boolean).join(' ') })
  }
  return rows.length ? rows : null
}

export function parseBlockers(text) {
  if (['nothing blocks withdrawal', 'dry run: nothing sent'].includes(text.trim())) return []
  const lines = text.trim().split(/\r?\n/).filter((line) => line !== 'dry run: nothing sent')
  const rows = []
  for (const line of lines) {
    const match = line.match(/^#(\d+) batch (\d+) \((committed|revealed)\): (wait -?\d+s|reveal|slash|release|expire) — (.+)$/)
    if (!match) return null
    rows.push({ id: match[1], batch: match[2], state: match[3], action: match[4], reason: match[5] })
  }
  return rows.length ? rows : null
}
