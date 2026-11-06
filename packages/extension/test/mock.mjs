// Offline stand-ins for chrome.storage, the chain and the deployment, shared by the flow tests.
import { encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem'

export const owner = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
export const T0 = '0x0000000000000000000000000000000000000a00'
export const T1 = '0x0000000000000000000000000000000000000b00'
export const dep = {
  chainId: 31337, deployBlock: 1, vault: '0x00000000000000000000000000000000000000fa', settlement: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  token0: T0, token1: T1, depositToken: T1, admission: { manifestSha256: 'ab'.repeat(32) },
}

// The slice of the contract ABIs the flows send or parse; test/abi.test.mjs checks it against contracts/out when built.
export const abi = {
  settlement: parseAbi([
    'function admissionRequired() view returns (bool)',
    'function commitFee() view returns (uint256)',
    'function commit(uint64 batchId, bytes32 hash, bytes ciphertext) returns (uint256 id)',
    'function admit(uint64 batchId, bytes32 hash, bytes ciphertext, bytes proof) returns (uint256 id)',
    'function reveal(uint256 id, (address owner, bool zeroForOne, uint128 amountIn, uint128 minAmountOut) order, bytes32 salt)',
    'function slashUnrevealed(uint256 id)',
    'function expire(uint64 batchId)',
    'event Committed(uint256 indexed commitId, uint64 indexed batchId, address indexed committer, bytes32 hash, uint64 round, bytes ciphertext)',
  ]),
  vault: parseAbi(['function deposit(address token, uint256 amount)', 'function withdraw(address token, uint256 amount)']),
  erc20: parseAbi(['function approve(address spender, uint256 amount) returns (bool)']),
}

/** A chrome.storage area in memory: get(key | keys) and set(object), values copied like structured clone. */
export function memoryArea() {
  const data = {}
  return {
    data,
    async get(keys) { return Object.fromEntries([keys].flat().filter((k) => k in data).map((k) => [k, structuredClone(data[k])])) },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v) },
  }
}

/** A raw Committed log as a receipt carries it. */
export function committedLog({ commitId, batchId, hash, round = 1n, ciphertext = '0x00' }) {
  const event = abi.settlement.find((x) => x.name === 'Committed')
  return {
    address: dep.settlement, blockNumber: 2n, logIndex: 0, transactionIndex: 0, blockHash: `0x${'11'.repeat(32)}`, transactionHash: `0x${'22'.repeat(32)}`, removed: false,
    topics: encodeEventTopics({ abi: [event], eventName: 'Committed', args: { commitId, batchId, committer: owner } }),
    data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint64' }, { type: 'bytes' }], [hash, round, ciphertext]),
  }
}

/**
 * The chain as the flows read it. reads: {functionName: value | (args) => value}, overridable per test; events:
 * parsed settlement events (getContractEvents); now: block timestamp. Records simulated calls in `simulated`.
 */
export function mockChain({ reads = {}, events = [], now = 1000n, receipts = {} } = {}) {
  const T = { [T0]: { symbol: 'TK0', decimals: 18 }, [T1]: { symbol: 'TK1', decimals: 18 } }
  const base = {
    vault: dep.vault, token0: T0, token1: T1, depositToken: T1, currentBatch: 3n, depositAmount: 5n, commitFee: 1n, MAX_COMMITS: 64n,
    commitsClose: 1200n, commitIdsOf: [], targetRound: 42n, admissionRequired: true, admissionState: [0n, `0x${'00'.repeat(32)}`, 0n],
    start: 0n, batchLength: 300, revealLength: 24, settleLength: 30, openCommitments: 0n,
    freeBalance: () => 100n * 10n ** 18n, balanceOf: () => 0n, allowance: () => 0n, lockedOf: () => 0n,
  }
  const table = { ...base, ...reads }
  const chain = {
    simulated: [],
    async readContract({ address, functionName, args = [] }) {
      if (functionName === 'symbol' || functionName === 'decimals') return T[address][functionName]
      const v = table[functionName]
      if (v === undefined) throw new Error(`mock chain: no ${functionName}`)
      return typeof v === 'function' ? v(args, address) : v
    },
    async getBlock() { return { timestamp: chain.now } },
    async getChainId() { return 31337 },
    async getContractEvents() { return events },
    async simulateContract(req) { chain.simulated.push(req.functionName); return { request: req } },
    async waitForTransactionReceipt({ hash }) { return receipts[hash] ?? { status: 'success', logs: [] } },
    now, table, receipts,
  }
  return chain
}
