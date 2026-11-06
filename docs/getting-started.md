# Getting started

This runs the whole system on your machine: a private local chain, the contracts, a Uniswap v4 pool, the trading page, the keeper and the solver. It uses Anvil's public test accounts and local test tokens only, never real keys or funds.

## 1. Install the tools

| Tool | Version | Install |
|---|---|---|
| Node.js | 22 or newer | `nvm install 22` |
| Foundry (`forge`, `anvil`, `cast`) | recent | `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |
| Go | 1.21 or newer, with network access on the first build (Go fetches the 1.27 toolchain the prover's `go.mod` asks for) | `brew install go` |
| git | any | |

Rust (`cargo`) is only needed for the optional proof-bench tests.

## 2. Clone and set up

```bash
git clone https://github.com/kodykebab/blindfold
cd blindfold
source env.sh                                   # puts Node 22 and Foundry on PATH; source it in every new shell
git submodule update --init --recursive
(cd contracts/lib/swap-vm && npm install --ignore-scripts)
```

Each package installs its own dependencies the first time a script needs them.

## 3. Generate the development proving parameters (once)

Admission proofs need Groth16 parameters. For local development they come from a single-machine setup. **Whoever runs this setup could forge proofs, so it's for development only**; production needs a proper setup (see [Security](security.md)).

```bash
mkdir -p packages/proof-bench/results
(cd packages/proof-bench/circuit && go build -o ../results/local-prover .)
packages/proof-bench/results/local-prover setup-local packages/proof-bench/results/admission-params   # about 17 minutes
cat > packages/proof-bench/results/admission-params/foundry.toml <<'EOF'
[profile.default]
src = "."
out = "out"
libs = []
solc = "0.8.26"
optimizer = true
optimizer_runs = 200
EOF
forge build --root packages/proof-bench/results/admission-params
```

`setup-local` refuses to overwrite an existing directory. If it's interrupted, delete `packages/proof-bench/results/admission-params` and run it again. (`packages/proof-bench/check-admission.sh` does the same steps and then runs the admission test.)

## 4. Start the stack

```bash
WEB_PORT=4400 scripts/dev.sh
```

1. `dev.sh` checks for Node 22, Foundry, Go, the prover and the contract libraries, and names anything missing with how to install it.
2. It builds the contracts and the prover.
3. It starts the stack and prints:

```
stack health:
ok   rpc        chain 31337, block 20
ok   deployment settlement 0x…
ok   prover     …/local-prover
ok   keeper     last cycle 0s ago
ok   solver     last cycle 0s ago
LOCAL_WEB_URL=http://127.0.0.1:4400/trade
```

Open the URL. The [User guide](user-guide.md) walks through an order. Leave out `WEB_PORT` to use any free port.

The stack keeps checking its services every 3 seconds. It prints a line whenever one goes down or recovers, with the fix, and writes the same information to `health.json` in the directory it prints. **Ctrl-C stops everything.** Every run starts a fresh chain, so nothing carries over between runs.

## Troubleshooting

| You see | Do |
|---|---|
| `missing anvil` / `missing go` / … | Install the tool named; the line says how. |
| `Generate development parameters and verifier artifacts first` | Do step 3. |
| `contracts/lib is empty` | `git submodule update --init --recursive` |
| `DOWN rpc … cannot reach the RPC` | Anvil stopped. Restart `dev.sh`. |
| `DOWN keeper` or `DOWN solver` | That process exited. Its last output above says why; restart `dev.sh`. |
| The page says **Local service unreachable** | `dev.sh` isn't running. Start it and refresh. |
| An order fails with **Device can't finish the proof** | The machine ran out of memory while proving. Prepare ahead (see the user guide) or free up memory; preparation peaks around 6 GB. |
