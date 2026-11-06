// Playwright's Chromium with the unpacked extension (D7), the bridge page on http://localhost:4317 and the test wallet.
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { serve } from '../../bridge/server.mjs'
import { ROOT, user } from './chain.mjs'
import { installTestWallet } from './anvil-wallet.mjs'

export const EXTENSION_ID = 'eaoidifkamkmkbcomcbpldjlhipogdgo' // INTERFACES.md
export const BRIDGE = 'http://localhost:4317'
export const EXTENSION_DIST = process.env.EXTENSION_DIST || join(ROOT, 'packages/extension/dist')

/** Start the bridge server once per process (fixed port 4317). */
let bridgeServer
export async function startBridge() {
  bridgeServer ??= await serve(4317, 'localhost')
  return bridgeServer
}
export const stopBridge = () => new Promise((r) => (bridgeServer ? bridgeServer.close(() => { bridgeServer = null; r() }) : r()))

/**
 * Launch with the extension; profile: reuse a user data dir (crash tests relaunch on the same one).
 * Returns {context, sw, wallet, profile, extensionUrl(path), bridgePage(), close({keepProfile})}.
 */
export async function launch({ profile = mkdtempSync(join(tmpdir(), 'blindfold-e2e-')), extension = EXTENSION_DIST, account = user(10), wallet: walletOpts = {} } = {}) {
  if (!existsSync(join(extension, 'manifest.json'))) throw new Error(`no built extension at ${extension}; run npm run build in packages/extension`)
  await startBridge()
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: process.env.HEADED !== '1',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  })
  const wallet = await installTestWallet(context, { account, origin: BRIDGE, ...walletOpts })
  const sw = context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${EXTENSION_ID}/`))
    ?? await context.waitForEvent('serviceworker', { predicate: (w) => w.url().startsWith(`chrome-extension://${EXTENSION_ID}/`), timeout: 10_000 })
  return {
    context, sw, wallet, profile,
    extensionUrl: (path) => `chrome-extension://${EXTENSION_ID}/${path}`,
    async bridgePage() {
      const page = await context.newPage()
      await page.goto(`${BRIDGE}/`)
      return page
    },
    async close({ keepProfile = false } = {}) {
      await context.close()
      if (!keepProfile) rmSync(profile, { recursive: true, force: true })
    },
  }
}
