// Prover, preparation and backup views for the trading page. Pure: parses the local client's output, no DOM.

const STEPS = ['Encrypt', 'Prove', 'Submit', 'Included']

/**
 * Stepped progress for a commit or preparation job from the client's real output lines.
 * job: { action, state, output, startedAt }. Returns { steps: [{ name, status, detail }], seconds } or null.
 */
export function proverSteps(job, { now = Date.now(), typicalSeconds = null } = {}) {
  if (!job || !['commit', 'prepare-admission', 'resume-admission'].includes(job.action)) return null
  const out = String(job.output ?? '')
  const preparing = job.action === 'prepare-admission'
  const names = preparing ? ['Prepare', 'Saved'] : job.action === 'resume-admission' ? ['Submit', 'Included'] : STEPS
  const reached = (name) => {
    switch (name) {
      case 'Encrypt': return /order: |generating (?:the online|both) admission proofs? locally|committed #|admitted #/.test(out)
      case 'Prove': return /local proving completed in|committed #|admitted #/.test(out) || (!/admission proof/.test(out) && /committed #/.test(out))
      case 'Submit': return /committed #|admitted #|private funding state matches|reconciled with chain/.test(out)
      case 'Included': return /committed #|admitted #|private funding state matches|reconciled with chain/.test(out) && job.state === 'done'
      case 'Prepare': return /prepared batch \d+ in/.test(out)
      case 'Saved': return /prepared batch \d+ in/.test(out) && job.state === 'done'
      default: return false
    }
  }
  let current = names.findIndex((n) => !reached(n))
  if (job.state !== 'running') current = job.state === 'done' ? -1 : current
  const elapsed = job.startedAt ? Math.max(0, Math.round((now - job.startedAt) / 1000)) : null
  const steps = names.map((name, i) => {
    const status = current === -1 || i < current ? 'done' : i === current ? (job.state === 'failed' ? 'failed' : 'current') : 'waiting'
    let detail = ''
    if (status === 'current' && elapsed != null) detail = `${elapsed}s so far${typicalSeconds && (name === 'Prove' || name === 'Prepare') ? `, usually about ${typicalSeconds}s on this machine` : ''}`
    return { name, status, detail }
  })
  return { steps, seconds: provedSeconds(out) }
}

/** Seconds the last proof or preparation took, from the client's own timing line. */
export function provedSeconds(output) {
  const m = String(output ?? '').match(/(?:local proving completed|prepared batch \d+) in (\d+(?:\.\d+)?)s/)
  return m ? Math.round(Number(m[1])) : null
}

/**
 * The status `preparation:` line as a panel state. batch: the current batch id from status (string) or null.
 * Returns { state, text, action: { label, batch } | null }.
 */
export function preparationPanel(line, batch = null) {
  const text = String(line ?? '').replace(/^preparation:\s*/, '').trim()
  const next = batch != null && /^\d+$/.test(String(batch)) ? String(BigInt(batch) + 1n) : null
  const prepareNext = next ? { label: `Prepare for batch ${next}`, batch: next } : null
  if (!text) return { state: 'off', text: 'Preparation is not required by this deployment.', action: null }
  if (text === 'none') return { state: 'none', text: 'Nothing is prepared (a submission uses up its preparation). Preparing ahead takes the slow part of proving out of your order.', action: prepareNext }
  if (/local state unreadable/.test(text)) return { state: 'unreadable', text: 'Local private state can’t be read. Restore a backup before preparing or trading.', action: null }
  if (/invalid for this account, network or deployment/.test(text)) return { state: 'invalid', text: 'The saved preparation is for another account, network or deployment. Prepare again.', action: prepareNext }
  const m = text.match(/^(.+?) for batch (\d+)$/)
  if (m) {
    const [, state, prepared] = m
    // The client prints `prepared` or `expired`; a preparation a submission used is removed and reads `none`.
    if (state === 'expired' || (batch != null && BigInt(prepared) < BigInt(batch))) return { state: 'stale', text: `The preparation is for batch ${prepared}, whose commit window has closed. Prepare again.`, action: prepareNext }
    return { state: 'ready', text: `Prepared for batch ${prepared}. Your next order in that batch only needs the fast online proof.`, action: null }
  }
  return { state: 'unknown', text: `Preparation: ${text}`, action: prepareNext }
}

/** Account, network or pair changed between two status reads: a preparation must be re-checked before submitting. */
export function identityChanged(before, after) {
  if (!before || !after) return false
  return ['account', 'network', 'pair'].some((k) => String(before[k] ?? '').toLowerCase() !== String(after[k] ?? '').toLowerCase())
}

/** Why the client refused a backup, as one sentence per problem kind. */
export function importProblems(output) {
  const out = String(output ?? '')
  const found = []
  if (/Backup must be a JSON object|Unexpected token|JSON/.test(out) && !/refusing to import/.test(out)) found.push({ kind: 'unreadable', text: 'The file isn’t a Blindfold backup (it isn’t readable JSON).' })
  if (/state is for another chain or settlement|state belongs to|order owner is not/.test(out)) found.push({ kind: 'foreign', text: 'The backup belongs to another account, network or deployment.' })
  if (/do not hash to it/.test(out)) found.push({ kind: 'tampered', text: 'An order or salt in the backup was changed: it no longer matches its commitment.' })
  if (/\(stale or foreign state\)/.test(out)) found.push({ kind: 'stale', text: 'The backup doesn’t match the commitments onchain: it’s older than the chain state, or from elsewhere.' })
  if (/funding|admission/i.test(out) && /refusing to import/.test(out) && !found.length) found.push({ kind: 'funding', text: 'The backup’s admission funding state doesn’t match this account.' })
  return found
}

/**
 * Backup reminder: shown after any submission and cleared only once a backup was exported after it and the user
 * confirmed it is saved. state: { pending, exportedAt, submittedAt }.
 */
export function backupReminder(state, event, now = Date.now()) {
  const s = { pending: false, exportedAt: 0, submittedAt: 0, ...(state ?? {}) }
  if (event === 'submitted') return { ...s, pending: true, submittedAt: now }
  if (event === 'exported') return { ...s, exportedAt: now }
  if (event === 'acknowledged') return s.pending && s.exportedAt >= s.submittedAt ? { ...s, pending: false } : s
  return s
}
export const reminderNeedsExport = (s) => Boolean(s?.pending) && !(s.exportedAt >= s.submittedAt)
