// Txs of every supported type signed by a throwaway test key, for the signer-recovery test.
import { writeFileSync } from 'node:fs'
import { privateKeyToAccount } from 'viem/accounts'

const KEY = '0x' + '11'.repeat(32) // test key, never funded
const acct = privateKeyToAccount(KEY)
const base = { to: '0x' + '22'.repeat(20), value: 7n, nonce: 3, gas: 50_000n, data: '0x1234' }
const out = { signer: acct.address.toLowerCase() }
out.preEip155 = await acct.signTransaction({ ...base, type: 'legacy', gasPrice: 1n })
out.eip155 = await acct.signTransaction({ ...base, type: 'legacy', gasPrice: 1n, chainId: 1 })
out.eip2930 = await acct.signTransaction({ ...base, type: 'eip2930', gasPrice: 1n, chainId: 1, accessList: [] })
out.eip1559 = await acct.signTransaction({ ...base, type: 'eip1559', maxFeePerGas: 5n, maxPriorityFeePerGas: 1n, chainId: 1 })
const auth = await acct.experimental_signAuthorization?.({ contractAddress: '0x' + '33'.repeat(20), chainId: 1, nonce: 4 })
  ?? await acct.signAuthorization({ contractAddress: '0x' + '33'.repeat(20), chainId: 1, nonce: 4 })
out.eip7702 = await acct.signTransaction({ ...base, type: 'eip7702', maxFeePerGas: 5n, maxPriorityFeePerGas: 1n, chainId: 1, authorizationList: [auth] })
writeFileSync(process.env.OUT || '../../contracts/test/court/fixtures/signed.json', JSON.stringify(out, null, 1))
console.log(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.slice(0, 6)])))
