# Global auction CLI

This package operates `GlobalAuction`: one shared vault, a fixed registry of 2–8 tokens, up to 64 commitments per batch, and atomic cross-pair settlement. It reads generated ABIs from `contracts/out`. Build contracts first and run `npm ci` here.

## Commands

```sh
GLOBAL_AUCTION=0x... RPC_URL=http://127.0.0.1:8545 npm start -- --once
GLOBAL_AUCTION=0x... BATCH=7 npm start -- solve
CONFIG_FILE=paths.json npm start -- discover
CONFIG_FILE=deployment.json SUBMIT=1 npm start -- deploy
STATE_FILE=private-state.json PREPARATION_PROOF=prep/proof.json ONLINE_PROOF=online/proof.json BATCH=7 npm start -- admit
ORDER_FILE=revealed-order.json COMMIT_ID=0 npm start -- reveal
BATCH=7 npm start -- expire
COMMIT_ID=0 npm start -- slash
```

Actions simulate first. Set `SUBMIT=1` to submit; supply `PRIVATE_KEY` through your local environment. Deployment requires both explicitly. `GLOBAL_AUCTION` selects the contract and `RPC_URL` defaults to local Anvil. Without `BATCH`, solve selects the latest eligible settlement window from the contract schedule. All commands perform one bounded operation and exit. There is no background process.

`admit` consumes the global prover's `global-state.json` and two Groth16 proof exports. `reveal` consumes `{ "order": { "owner": "0x...", "tokenIn": 0, "tokenOut": 1, "amountIn": "100", "minAmountOut": "90" }, "salt": "0x..." }`, obtained by decrypting the published AGE ciphertext after the target round. The private prover state also includes this shape; anyone possessing a valid plaintext can reveal. Keep private preparation and reservation files private.

## Routing and solver

`discover` takes `{ "input": "0x...", "output": "0x...", "pools": [{"token0":"0x...","token1":"0x...","pool":"0x..."}] }` and enumerates simple paths up to three pools. Pool data is an explicit bounded input, not a list scraped from an untrusted API. Deploy selected paths as authenticated `UniswapV3Route` adapters. Settlement only calls adapters registered before configuration is sealed.

The solver groups equal limits, preserves price priority, constructs common-value circulations for unequal and overlapping cycles, searches partial-fill budget breakpoints and a bounded grid, and compares registered route candidates. It first uses the common historical reference vector; bounded price adjustments can cover venue fees. Fractions use `2^128−1` as the denominator, retaining unit resolution over the entire uint128 input range. Every accepted candidate passes whole-transaction simulation. An exhausted search reports that the batch may still be feasible. Unavailable token references are represented by zero and all associated orders remain unfilled; unrelated healthy pairs may still settle. RPC failures propagate instead of being treated as an unavailable price.

## Deployment manifest

```json
{
  "chainId": 1,
  "tokens": ["0x...sorted token0...", "0x...token1..."],
  "preparationVerifier": "0x...reviewed generated verifier...",
  "onlineVerifier": "0x...global circuit verifier...",
  "factory": "0x...canonical v3 factory...",
  "start": "...drand-aligned future timestamp...",
  "batchLength": 300,
  "revealLength": 24,
  "settleLength": 300,
  "depositAmount": "...raw token0 units...",
  "commitFee": "...raw token0 units...",
  "bountyBps": 2000,
  "treasury": "0x...",
  "routes": [{
    "path": ["0x...token0...", "0x...token1..."],
    "hops": [{"pool":"0x...","minimumLiquidity":"...","maximumObservationAge":0}],
    "window": 600,
    "maximumDelay": 360,
    "deviationBps": 100,
    "priceOracle": true
  }]
}
```

All numeric values above are illustrative configuration fields. `maximumObservationAge` 0 turns the latest-trade activity check off (recommended; a positive value rejects pools with no trade in that many seconds). Calibrate timing and oracle settings before deployment. Every non-base token needs exactly one base-token oracle path. Optional additional paths provide execution choices. Endpoints are sorted by address; intermediate route tokens do not need to be funded by users. `DEPLOYMENT_OUT` optionally writes the completed manifest without overwriting an existing file. Deployments are ordinary sequential transactions; a failed deployment reports the failing transaction, and already deployed contracts remain onchain.

## Verification

```sh
npm test
RUN_GLOBAL_INTEGRATION=1 npm test
```

The integration suite owns a fresh Anvil instance. It runs the actual admission, reveal, solve and deployment commands. Its proof stand-in tests CLI/state boundaries only. Real encryption, Groth16 verification, admission, settlement and withdrawal are tested separately in `packages/proof-bench/global-evm`.
