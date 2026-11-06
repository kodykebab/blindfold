// Offline: the IDs and origins in INTERFACES.md agree with every package that hard-codes them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../lib/chain.mjs'
import { EXTENSION_ID, BRIDGE } from '../lib/browser.mjs'
import { EXTENSION_ID as BRIDGE_CONFIG_ID } from '../../bridge/public/config.mjs'

const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const manifest = JSON.parse(read('packages/extension/manifest.json'))
const spec = read('extension-team/INTERFACES.md')

test('extension ID: derived from the manifest key, and the same in INTERFACES.md, the bridge and the harness', () => {
  const hex = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
  const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
  assert.match(spec, new RegExp(`## Extension ID\\n\`${id}\``))
  assert.equal(BRIDGE_CONFIG_ID, id)
  assert.equal(EXTENSION_ID, id)
})

test('bridge origin: externally_connectable matches only the bridge origin (D9)', () => {
  assert.deepEqual(manifest.externally_connectable, { matches: [`${BRIDGE}/*`] })
  assert.ok(spec.includes(`\`port.sender.origin === "${BRIDGE}"\``))
})
