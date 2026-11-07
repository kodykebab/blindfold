// Build the unpacked extension into dist/: bundle the ESM sources with esbuild, copy the pages, write the manifest and
// the contract ABIs (from `forge build`, never hand-copied).
//   node build.mjs            one build          node build.mjs --watch   rebuild on change (npm start)
// Env: CONTRACTS_OUT (default ../../contracts/out); BRIDGE_ORIGIN (default http://localhost:4317, D9: the release build
// passes the production https origin).
import * as esbuild from 'esbuild'
import { artifactPath } from '../solver/artifacts.mjs'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const dist = join(here, 'dist')
const out = process.env.CONTRACTS_OUT || join(here, '../../contracts/out')
const origin = process.env.BRIDGE_ORIGIN || 'http://localhost:4317'
if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) throw new Error(`BRIDGE_ORIGIN must be an origin like https://app.example, got ${origin}`)

/** Foundry suffixes artifacts built by more than one compiler profile; prefer the v4-compatible 0.8.26 build. */
function abi(name) {
  return JSON.parse(readFileSync(artifactPath(out, name), 'utf8')).abi
}

function statics() {
  mkdirSync(dist, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'))
  manifest.externally_connectable.matches = [`${origin}/*`]
  writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2))
  const abis = Object.fromEntries(['AdmittedSettlement', 'BlindfoldSettlement', 'BlindfoldVault', 'MockERC20'].map((n) => [n, abi(n)]))
  writeFileSync(join(dist, 'abis.json'), JSON.stringify(abis))
  for (const f of readdirSync(join(here, 'static'))) copyFileSync(join(here, 'static', f), join(dist, f))
}

const options = {
  entryPoints: { sw: 'src/sw.mjs', offscreen: 'src/offscreen.mjs', app: 'src/app.mjs' },
  absWorkingDir: here,
  outdir: dist,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome116',
  nodePaths: [join(here, 'node_modules')], // lets ../client/*.mjs find viem without a client install
  define: { 'globalThis.BLINDFOLD_BRIDGE_ORIGIN': JSON.stringify(origin) },
  logLevel: 'info',
  plugins: [{ name: 'statics', setup: (b) => b.onEnd((r) => { if (!r.errors.length) statics() }) }],
}

if (process.argv.includes('--watch')) await (await esbuild.context(options)).watch()
else await esbuild.build(options)
