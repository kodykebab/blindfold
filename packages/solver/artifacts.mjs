import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Foundry adds compiler suffixes when a contract is built in multiple profiles.
 * Prefer the v4-compatible 0.8.26 build; otherwise accept one unambiguous artifact.
 */
export function artifactPath(out, name) {
  const directory = join(out, `${name}.sol`)
  for (const file of [`${name}.0.8.26.json`, `${name}.json`]) {
    const path = join(directory, file)
    if (existsSync(path)) return path
  }
  const files = readdirSync(directory).filter((f) => f.startsWith(`${name}.`) && f.endsWith('.json'))
  if (files.length !== 1) throw new Error(`select an explicit artifact for ${name}; found ${files.length} compiler variants`)
  return join(directory, files[0])
}
