// A stand-in extension for testing the bridge page in a real browser before (and independently of) the real one.
// Same dev key as packages/extension, so the same ID and the same externally_connectable rule; its service worker
// just records bridge messages and lets the test post to the bridge (sw.evaluate). Test-only, written to a temp dir.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from './chain.mjs'

const SW = `
let port = null
self.inbox = []
chrome.runtime.onConnectExternal.addListener((p) => {
  if (p.name !== 'blindfold-bridge') return p.disconnect()
  if (port) { port.postMessage({ type: 'replaced' }); port.disconnect() } // INTERFACES.md: the newest bridge tab wins
  port = p
  p.onMessage.addListener((m) => self.inbox.push(m))
  p.onDisconnect.addListener(() => { if (port === p) port = null })
})
self.post = (m) => port.postMessage(m)
self.origin = () => port?.sender?.origin ?? null
// what a service worker restart looks like to the bridge (the side that disconnects gets no onDisconnect)
self.drop = () => { port?.disconnect(); port = null }
`

export function fakeExtension() {
  const real = JSON.parse(readFileSync(join(ROOT, 'packages/extension/manifest.json'), 'utf8'))
  const dir = mkdtempSync(join(tmpdir(), 'blindfold-fake-ext-'))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Blindfold bridge test stand-in', version: '0.0.1', key: real.key,
    background: { service_worker: 'sw.js' }, externally_connectable: real.externally_connectable,
  }))
  writeFileSync(join(dir, 'sw.js'), SW)
  return dir
}
