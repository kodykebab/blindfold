// U1: order + salt encode to the same 160-byte ABI payload and hash as the contract and the client.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bytesToHex, concat, keccak256, numberToHex, padHex } from 'viem'
import * as client from '../../client/lib.mjs'
import { armor, dearmor, decodePayload, encodePayload, newSalt, orderHash } from '../src/core.mjs'

const MAX128 = (1n << 128n) - 1n
const settlement = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const rand = (bytes) => crypto.getRandomValues(new Uint8Array(bytes))
const randBig = (bits) => BigInt(bytesToHex(rand(Math.ceil(bits / 8)))) & ((1n << BigInt(bits)) - 1n)
const word = (v) => padHex(typeof v === 'string' ? v : numberToHex(v), { size: 32 })

function randomOrder(i) {
  const edge = [0n, 1n, MAX128, MAX128 - 1n]
  return {
    owner: bytesToHex(rand(20)),
    zeroForOne: i % 2 === 0,
    amountIn: i < 16 ? edge[i % 4] : randBig(128),
    minAmountOut: i < 16 ? edge[(i >> 2) % 4] : randBig(128),
  }
}

test('U1 orderHash matches the contract (cast vector from the client tests)', () => {
  const order = { owner: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', zeroForOne: true, amountIn: 10n ** 18n, minAmountOut: 9n * 10n ** 17n }
  assert.equal(orderHash(31337, settlement, 7n, order, `0x${'03'.repeat(32)}`), '0x3562821b3a92f6debe561e97b33e4669f19c539dce2cc1f74314fd18fb816aa6')
})

test('U1 random and maximum orders: 160-byte payload, word layout, hash and client agree', () => {
  for (let i = 0; i < 300; i++) {
    const order = randomOrder(i), salt = newSalt()
    const chainId = i % 3 ? 31337n : randBig(64), batch = i % 5 ? randBig(64) : (1n << 64n) - 1n
    const payload = encodePayload(order, salt)
    // abi.encode of a static tuple and a bytes32: five 32-byte words, no offsets
    const words = concat([word(order.owner), word(order.zeroForOne ? 1n : 0n), word(order.amountIn), word(order.minAmountOut), salt])
    assert.equal((payload.length - 2) / 2, 160)
    assert.equal(payload, words)
    const hash = orderHash(chainId, settlement, batch, order, salt)
    assert.equal(hash, keccak256(concat([word(chainId), word(settlement), word(batch), words])))
    assert.equal(hash, client.orderHash(chainId, settlement, batch, order, salt))
    assert.equal(payload, client.encodePayload(order, salt))
    const back = decodePayload(payload)
    assert.deepEqual(back, { order: { ...order, owner: back.order.owner }, salt })
    assert.equal(back.order.owner.toLowerCase(), order.owner)
  }
})

test('armor/dearmor match the client byte for byte', () => {
  for (const n of [1, 63, 64, 65, 1037]) {
    const hex = bytesToHex(rand(n))
    assert.equal(armor(hex), client.armor(hex))
    assert.equal(dearmor(armor(hex)), hex)
  }
})
