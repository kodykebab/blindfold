// Runs independent standard decryption and ABI checks, then checks split journals.
import './interop.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, concat, stringToHex } from 'viem'
const [p, pw, o, ow] = JSON.parse(readFileSync(process.argv[3], 'utf8'))
const h = a => '0x' + Buffer.from(a).toString('hex')
const domain = keccak256(stringToHex('blindfold.prepared-key.v1'))
const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8')).fixture
const chain = stringToHex(fixture.chain_hash), key = stringToHex(fixture.public_key)
const c = p.context
const context = encodeAbiParameters(
  [{type:'bytes32'},{type:'uint256'},{type:'address'},{type:'address'},{type:'uint256'},{type:'uint256'}],
  [domain,BigInt(c.chain_id),h(c.settlement),h(c.owner),BigInt(c.batch),BigInt(c.round)])
const commitment = keccak256(concat([context,keccak256(chain),keccak256(key),keccak256(h(pw.wrapper)),h(pw.key),h(pw.blind)]))
assert.equal(commitment,h(p.commitment))
assert.equal(commitment,h(o.commitment))
assert.equal(h(pw.key),h(ow.order.file_key))
assert.equal(h(pw.wrapper),h(ow.wrapper))
const prep = concat([context,commitment,keccak256(concat([chain,key]))])
const s=o.admission
const tail=encodeAbiParameters(
  [{type:'uint256'},{type:'bytes32'},{type:'bytes32'},{type:'uint256'},{type:'uint256'},{type:'bytes32'},{type:'bytes32'}],
  [BigInt(s.step),h(s.old_root),h(s.new_root),BigInt(s.budgets[0]),BigInt(s.budgets[1]),h(s.order_hash),h(s.ciphertext_hash)])
const expected={preparation:prep,online:concat([prep,tail])}
if (process.argv[4]) {
  const exported=JSON.parse(readFileSync(process.argv[4],'utf8'))
  assert.equal(exported.journal,expected[process.argv[5] ?? 'online'])
} else {
  writeFileSync(new URL('./results/prepared-expected-journals.json',import.meta.url),JSON.stringify(expected,null,2))
}
console.log('PASS: independent prepared commitment, key/wrapper binding and canonical ABI journals')
