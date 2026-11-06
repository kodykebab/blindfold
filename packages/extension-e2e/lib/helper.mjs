// Install prover-helper (packages/prover-helper/install.sh) into a test profile only: HOME is a temp dir, so no real
// browser's NativeMessagingHosts folder is touched.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './chain.mjs'
import { EXTENSION_ID } from './browser.mjs'

export const sha256File = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')
export const hasGo = (() => { try { execFileSync('go', ['version']); return true } catch { return false } })()
export const REAL = {
  prover: process.env.ADMISSION_PROVER || join(ROOT, 'packages/proof-bench/results/local-prover'),
  params: process.env.ADMISSION_PARAMS || join(ROOT, 'packages/proof-bench/results/admission-params'),
}
/** check-admission.sh output: the prover, its parameters and the generated verifier artifacts. */
export const realProverReady = () => existsSync(REAL.prover) && existsSync(join(REAL.params, 'manifest.json'))
  && existsSync(join(REAL.params, 'out', 'preparation.sol', 'Verifier.json'))

export function installHelper(profile, { prover, params }) {
  const dir = mkdtempSync(join(tmpdir(), 'blindfold-helper-'))
  execFileSync('bash', [join(ROOT, 'packages/prover-helper/install.sh'), EXTENSION_ID, profile], {
    env: { ...process.env, HOME: join(dir, 'home'), GOCACHE: execFileSync('go', ['env', 'GOCACHE'], { encoding: 'utf8' }).trim(),
      GOTOOLCHAIN: 'local', INSTALL_DIR: join(dir, 'bin'), ADMISSION_PROVER: prover, ADMISSION_PARAMS: params },
    stdio: 'pipe',
  })
  return dir
}
