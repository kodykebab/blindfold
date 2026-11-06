// Public interoperability fixture for the canonical re-encoding of the fixed Rust fixture.
import { readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const [input, output] = process.argv.slice(2)
assert(input && output, 'usage: node canonical-interop.mjs canonical-fixture.json public-output.json')
const source = JSON.parse(readFileSync(new URL('./testdata/prepared.json', import.meta.url)))
const canonical = JSON.parse(readFileSync(input))
const ciphertext = canonical[3].order.ciphertext
const digest = canonical[2].admission.ciphertext_hash
canonical[3].order.ciphertext = source[3].order.ciphertext
canonical[2].admission.ciphertext_hash = source[2].admission.ciphertext_hash
assert.deepEqual(canonical, source, 'only the fixed fixture ciphertext may change')
const publicFixture = JSON.parse(readFileSync(new URL('./testdata/interop.json', import.meta.url)))
publicFixture.fixture.ciphertext = Buffer.from(ciphertext).toString('hex')
// The parent interop checker independently decrypts and checks the order/root encodings.
assert.equal(digest.length, 32)
writeFileSync(output, JSON.stringify(publicFixture, null, 2) + '\n')
