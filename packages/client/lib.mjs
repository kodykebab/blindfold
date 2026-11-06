// Shared client plumbing: order encoding and hashing, tlock encryption, deployment and ABI loading, chain clients.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timelockDecrypt, timelockEncrypt, mainnetClient } from 'tlock-js'
import { createPublicClient, createWalletClient, decodeAbiParameters, defineChain, encodeAbiParameters, http, keccak256, toHex } from 'viem'
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'

const E = process.env
export const ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const ORDER = {
  type: 'tuple',
  components: [
    { name: 'owner', type: 'address' },
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountIn', type: 'uint128' },
    { name: 'minAmountOut', type: 'uint128' },
  ],
}
// anvil's public test mnemonic; accounts 10–19 are users (PLAN.md seams). Never use it on a real chain.
export const TEST_MNEMONIC = 'test test test test test test test test test test test junk'

/** Same as BatchAuction.orderHash: keccak256(abi.encode(chainid, settlement, batchId, order, salt)). */
export function orderHash(chainId, settlement, batchId, order, salt) {
  return keccak256(encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address' }, { type: 'uint64' }, ORDER, { type: 'bytes32' }],
    [BigInt(chainId), settlement, BigInt(batchId), order, salt],
  ))
}

export const newSalt = () => toHex(randomBytes(32))
export const encodePayload = (order, salt) => encodeAbiParameters([ORDER, { type: 'bytes32' }], [order, salt])
export function decodePayload(hex) {
  const [order, salt] = decodeAbiParameters([ORDER, { type: 'bytes32' }], hex)
  return { order, salt }
}

// The chain carries raw AGE bytes (as in packages/proof-bench); tlock-js speaks the armored form.
const ARMOR = ['-----BEGIN AGE ENCRYPTED FILE-----', '-----END AGE ENCRYPTED FILE-----']
export const armor = (hex) =>
  `${ARMOR[0]}\n${Buffer.from(hex.slice(2), 'hex').toString('base64').match(/.{1,64}/g).join('\n')}\n${ARMOR[1]}\n`
export const dearmor = (text) =>
  toHex(Buffer.from(text.replace(ARMOR[0], '').replace(ARMOR[1], '').replace(/\s+/g, ''), 'base64'))

/** Encrypt abi.encode(order, salt) to a drand quicknet round; returns the raw ciphertext bytes as hex. */
export async function encrypt(round, order, salt, drand = drandClient()) {
  return dearmor(await timelockEncrypt(Number(round), Buffer.from(encodePayload(order, salt).slice(2), 'hex'), drand))
}

/** Decrypt raw ciphertext bytes once the round's signature is out. */
export async function decrypt(ciphertext, drand = drandClient()) {
  return decodePayload(toHex(await timelockDecrypt(armor(ciphertext), drand)))
}

/**
 * quicknet over HTTP, or recorded rounds when DRAND points at a fixture file (local mode, offline tests):
 * {public_key, chain_hash, rounds: {"<round>": "<signature hex>"}}. A recorded client knows only its rounds.
 */
export function drandClient(fixture = E.DRAND) {
  if (!fixture) return mainnetClient()
  const f = typeof fixture === 'string' ? JSON.parse(readFileSync(fixture, 'utf8')) : fixture
  const info = {
    public_key: f.public_key, period: 3, genesis_time: 1692803367, hash: f.chain_hash, groupHash: '',
    schemeID: 'bls-unchained-g1-rfc9380', metadata: { beaconID: 'quicknet' },
  }
  return {
    options: { disableBeaconVerification: false, noCache: true },
    chain: () => ({ baseUrl: 'fixture', info: async () => info }),
    latest: async () => { throw new Error('recorded drand client has no latest round') },
    get: async (round) => {
      const signature = f.rounds[String(round)]
      if (!signature) throw new Error(`round ${round} is not recorded`)
      return { round, signature, randomness: createHash('sha256').update(Buffer.from(signature, 'hex')).digest('hex') }
    },
  }
}

/** Foundry suffixes artifacts built by more than one compiler profile; prefer the v4-compatible 0.8.26 build. */
export function artifactPath(out, name, file = name) {
  const dir = join(out, `${file}.sol`)
  for (const file of [`${name}.0.8.26.json`, `${name}.json`]) if (existsSync(join(dir, file))) return join(dir, file)
  const files = readdirSync(dir).filter((f) => f.startsWith(`${name}.`) && f.endsWith('.json'))
  if (files.length !== 1) throw new Error(`select an explicit artifact for ${name}; found ${files.length} variants`)
  return join(dir, files[0])
}

/** `file` names the source when it differs from the contract, e.g. IV3Pool lives in IExternalMarket.sol. */
export function loadAbi(name, out = E.CONTRACTS_OUT || join(ROOT, 'contracts/out'), file = name) {
  try {
    return JSON.parse(readFileSync(artifactPath(out, name, file), 'utf8')).abi
  } catch (e) {
    throw new Error(`no ${name} artifact in ${out} (${e.code ?? e.message}); run \`forge build\` in contracts/ or set CONTRACTS_OUT`)
  }
}

export function loadDeployment(path = E.DEPLOYMENTS || join(ROOT, 'deployments/blindfold.local.json')) {
  let dep
  try {
    dep = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`can't read ${path} (${e.code ?? e.message}); run DeployBlindfold first or set DEPLOYMENTS`)
  }
  for (const k of ['chainId', 'vault', 'settlement']) if (dep[k] == null) throw new Error(`${path} has no "${k}"`)
  return dep
}

export function account(env = E) {
  if (env.PRIVATE_KEY) return privateKeyToAccount(env.PRIVATE_KEY)
  // USER normally contains the OS login. Retain explicit numeric USER values for existing local scripts.
  const value = env.CLIENT_ACCOUNT_INDEX ?? (/^\d+$/.test(env.USER ?? '') ? env.USER : '10')
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) >= 2 ** 31) {
    throw new Error('CLIENT_ACCOUNT_INDEX must be an integer from 0 to 2147483647')
  }
  return mnemonicToAccount(env.MNEMONIC || TEST_MNEMONIC, { addressIndex: Number(value) })
}

/** Everything a command needs: clients, the deployment, ABIs and a bound reader. */
export function connect() {
  const dep = loadDeployment()
  const rpc = E.RPC_URL || 'http://127.0.0.1:8545'
  const chain = defineChain({
    id: dep.chainId, name: 'blindfold', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  })
  const transport = http(rpc, { timeout: 15_000, retryCount: 0 })
  const acct = account()
  const pub = createPublicClient({ chain, transport, pollingInterval: 100 })
  const wallet = createWalletClient({ account: acct, chain, transport })
  const abi = { settlement: loadAbi(dep.admission?.manifestSha256 ? 'AdmittedSettlement' : 'BlindfoldSettlement'), vault: loadAbi('BlindfoldVault'), erc20: loadAbi('MockERC20') }
  const read = (address, functionName, args = [], which = address === dep.vault ? abi.vault : abi.settlement) =>
    pub.readContract({ address, abi: which, functionName, args })
  return { dep, pub, wallet, account: acct, abi, read }
}
