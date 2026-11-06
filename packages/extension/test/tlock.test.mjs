// Offscreen tlock work, against a recorded quicknet round (offline).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as client from '../../client/lib.mjs'
import { encodePayload, newSalt } from '../src/core.mjs'
import { check, encrypt } from '../src/tlock.mjs'

const drand = JSON.parse(readFileSync(new URL('../../client/test/fixtures/drand.json', import.meta.url), 'utf8'))
const order = { owner: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', zeroForOne: false, amountIn: 7n, minAmountOut: 3n }

test('encrypt to a recorded round; the check decrypts it to the order; the client decrypts it too', async () => {
  const salt = newSalt()
  const payload = encodePayload(order, salt)
  const ct = await encrypt(1000000n, payload, drand)
  assert.deepEqual(await check(ct, 1000000n, payload, drand), { round: '1000000', decrypted: true })
  assert.deepEqual(await client.decrypt(ct, client.drandClient(drand)), { order, salt })
})

test('the check refuses another round, another payload, a broken file; a future round checks the header only', async () => {
  const payload = encodePayload(order, newSalt())
  const ct = await encrypt(1000000n, payload, drand)
  await assert.rejects(check(ct, 1000001n, payload, drand), /expected quicknet round 1000001/)
  await assert.rejects(check(ct, 1000000n, encodePayload(order, newSalt()), drand), /does not decrypt to this order/)
  await assert.rejects(check(`0x${'00'.repeat(40)}`, 1000000n, payload, drand), /not a single-recipient AGE file/)
  const later = await encrypt(1000001n, payload, drand)
  assert.deepEqual(await check(later, 1000001n, payload, drand), { round: '1000001', decrypted: false })
  const future = await encrypt(99999999n, payload, drand)
  assert.deepEqual(await check(future, 99999999n, payload, null, 1_700_000_000), { round: '99999999', decrypted: false }) // live quicknet, round not out
})
