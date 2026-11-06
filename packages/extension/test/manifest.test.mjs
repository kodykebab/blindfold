// D8/D9 and the manifest: the fixed ID follows from the key; permissions and CSP are what the design allows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'))
const ID = 'eaoidifkamkmkbcomcbpldjlhipogdgo'
const idOf = (key) => [...createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)].map((c) => 'abcdefghijklmnop'[parseInt(c, 16)]).join('')

test('the extension ID is the published one (INTERFACES.md)', () => {
  assert.equal(idOf(manifest.key), ID)
  const interfaces = new URL('../../../extension-team/INTERFACES.md', import.meta.url)
  if (existsSync(interfaces)) assert.match(readFileSync(interfaces, 'utf8'), new RegExp(ID))
})

test('MV3 with only the planned permissions, the dev bridge origin and no wasm-unsafe-eval', () => {
  assert.equal(manifest.manifest_version, 3)
  assert.deepEqual(manifest.permissions.toSorted(), ['alarms', 'nativeMessaging', 'offscreen', 'storage', 'unlimitedStorage'])
  assert.equal(manifest.host_permissions, undefined)
  assert.deepEqual(manifest.externally_connectable, { matches: ['http://localhost:4317/*'] })
  assert.doesNotMatch(manifest.content_security_policy.extension_pages, /wasm-unsafe-eval|unsafe-eval|http/)
  assert.equal(manifest.background.type, 'module')
})
