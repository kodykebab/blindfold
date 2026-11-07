# Blindfold extension

A Manifest V3 extension for local Blindfold auctions. Your existing injected wallet signs transactions on the
[bridge page](../bridge/README.md); the extension creates orders, encrypts them with tlock and keeps private state
encrypted with your passphrase. Proof-enforced deployments use the [native prover helper](../prover-helper/README.md).

## Build and load

From the repository root:

```bash
source env.sh
npm ci --prefix packages/extension
forge build --root contracts --no-dynamic-test-linking
npm run build --prefix packages/extension
```

In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select
`packages/extension/dist`. Click the extension to open its page. The dev build has the fixed ID
`eaoidifkamkmkbcomcbpldjlhipogdgo` so the bridge and native host agree.

## Local wallet flow

```bash
source env.sh
npm ci --prefix packages/extension-e2e
npm start --prefix packages/extension-e2e
```

This starts anvil on port 8563, deploys the auction, funds public test account 10 with both tokens, and serves the
bridge at `http://localhost:4317/`. The terminal prints the deployment JSON path. Set `MINT_TO` to fund another
local wallet address instead.

1. Create a passphrase on the extension page.
2. In Settings, use RPC `http://127.0.0.1:8563` and paste the generated deployment JSON.
3. Open the bridge link, select MetaMask or another injected EIP-1193 wallet, and connect the funded local account.
4. Use **Preflight**, then **Seal and commit**. Funding shortfalls are deposited first. Approve and deposit are sent
   as one request: wallets with atomic EIP-5792 support can batch them; other wallets sign them in sequence.
5. Use **Track** and **Blockers** to follow the batch, then **Cleanup** to perform due reveal or expiry steps.
6. Once commitments are closed, withdraw available balances. **Export** and **Import** move private state between
   this extension and the client CLI. Keep the downloaded export private.

The extension badge counts due cleanup steps. An unread export job is removed on lock, worker restart or its
one-minute cleanup alarm. The page removes job results as soon as it reads them.

## Admission proofs

```bash
source env.sh
bash packages/proof-bench/check-admission.sh
bash packages/prover-helper/install.sh
```

Use a deployment containing `admission.manifestSha256` and the corresponding real verifiers. The helper's manifest
must match it. The extension checks the returned order hash, roots and ciphertext before it signs `admit`.
The automated [E3 test](../extension-e2e/test/admission.e2e.test.mjs) deploys this stack with recorded drand rounds,
proves two orders through native messaging, then reveals, settles and withdraws them.

## Checks

```bash
source env.sh
npm test --prefix packages/extension
npm test --prefix packages/bridge
npm test --prefix packages/prover-helper
npm test --prefix packages/extension-e2e
npm run e2e --prefix packages/extension-e2e
```

The browser suite uses an isolated Chromium profile and a test wallet. Install its browser once with
`cd packages/extension-e2e && npx playwright install chromium`. Manual MetaMask, Brave and Edge checks are described
in [the QA README](../extension-e2e/README.md).

## Build settings

`BRIDGE_ORIGIN` sets both the accepted external origin and the manifest match (default `http://localhost:4317`).
`CONTRACTS_OUT` selects the Foundry artifacts directory (default `contracts/out`). ABIs are copied from artifacts
by the build. `npm start --prefix packages/extension` watches for source changes.
