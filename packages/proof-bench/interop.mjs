import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { timelockDecrypt } from 'tlock-js'
import { encodeAbiParameters, keccak256 } from 'viem'

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const fixtures = input.fixtures ?? [input.fixture]
for (const f of fixtures) {
const info = {
  public_key: f.public_key, period: 3, genesis_time: 1692803367,
  hash: f.chain_hash, groupHash: '', schemeID: 'bls-unchained-g1-rfc9380',
  metadata: { beaconID: 'quicknet' },
}
const client = {
  options: { disableBeaconVerification: false, noCache: true },
  chain: () => ({ info: async () => info }),
  get: async round => {
    assert.equal(round, f.round)
    return { round, signature: f.signature, randomness: createHash('sha256').update(Buffer.from(f.signature, 'hex')).digest('hex') }
  },
}
const raw = Buffer.from(f.ciphertext, 'hex')
const armored = '-----BEGIN AGE ENCRYPTED FILE-----\n' + raw.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END AGE ENCRYPTED FILE-----\n'
const plain = await timelockDecrypt(armored, client)
assert.equal(Buffer.from(plain).toString('hex'), f.plaintext)
const order = { owner: '0x'+'02'.repeat(20), zeroForOne: f.direction ?? true, amountIn: BigInt(f.amount ?? '100'), minAmountOut: 1n }
const tuple = {type:'tuple',components:[{name:'owner',type:'address'},{name:'zeroForOne',type:'bool'},{name:'amountIn',type:'uint128'},{name:'minAmountOut',type:'uint128'}]}
const salt='0x'+'03'.repeat(32)
assert.equal(encodeAbiParameters([tuple,{type:'bytes32'}],[order,salt]).slice(2), f.plaintext)
const expectedHash=keccak256(encodeAbiParameters([{type:'uint256'},{type:'address'},{type:'uint64'},tuple,{type:'bytes32'}],[130n,'0x'+'01'.repeat(20),7n,order,salt]))
assert.equal(expectedHash.slice(2),f.order_hash)
const step = BigInt(f.step ?? 0)
const old0 = ((1n << 128n) - 1n) * step
const total0 = old0 + (order.zeroForOne ? order.amountIn : 0n)
const total1 = order.zeroForOne ? 0n : order.amountIn
const expectedRoot=keccak256(encodeAbiParameters([{type:'uint256'},{type:'address'},{type:'address'},{type:'uint64'},{type:'uint256'},{type:'uint256'},{type:'bytes32'},{type:'uint256'}],[130n,'0x'+'01'.repeat(20),order.owner,7n,total0,total1,'0x'+'05'.repeat(32),step+1n]))
assert.equal(expectedRoot.slice(2),f.new_root)
}
console.log(`PASS: ${fixtures.length} independent JS decryption, quicknet signature, and Solidity ABI/hash cases`)
