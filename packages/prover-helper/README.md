# Prover helper

The Chrome native messaging host `xyz.blindfold.prover`. The extension sends it an order; it runs the team's Go
`local-prover` on this machine and returns the two Groth16 admission proofs (preparation and online). The witness
is the plaintext order, so proving never leaves the machine (D1). The helper is a small Go program with no
dependencies, so Chrome can launch it without Node.

## Install (development, D4)
```bash
source env.sh
bash packages/proof-bench/check-admission.sh      # builds local-prover and the development parameters under results/
bash packages/prover-helper/install.sh            # extension ID eaoidifkamkmkbcomcbpldjlhipogdgo (D8)
bash packages/prover-helper/install.sh <extension-id> [chromium-user-data-dir ...]
bash packages/prover-helper/uninstall.sh [chromium-user-data-dir ...]
```
`install.sh` builds `bin/blindfold-prover-helper`, writes `bin/config.json` (extension ID, absolute paths to
`local-prover` and the parameters, and the parameters' manifest SHA-256), and registers `xyz.blindfold.prover.json`
with `allowed_origins` set to that one extension. `ADMISSION_PROVER` and `ADMISSION_PARAMS` override the prover and
parameter paths, as for the client; `INSTALL_DIR` overrides `bin/`. Re-run it after regenerating parameters: the
helper refuses parameters whose manifest hash differs from the one pinned at install.

It registers the host per user, in each installed browser's `NativeMessagingHosts` folder (D7). A browser that isn't
installed yet is skipped; re-run the script after installing it.

| Browser | macOS (`~/Library/Application Support/...`) | Linux (`~/.config/...`) |
| --- | --- | --- |
| Chrome | `Google/Chrome` | `google-chrome` |
| Chromium | `Chromium` | `chromium` |
| Brave | `BraveSoftware/Brave-Browser` | `BraveSoftware/Brave-Browser` |
| Edge | `Microsoft Edge` | `microsoft-edge` |
| Arc | not registered: no documented native messaging folder found; untested | n/a |

Chromium looks for user-level hosts in `<user-data-dir>/NativeMessagingHosts`, so a browser started with its own
profile directory (for example Playwright's `launchPersistentContext`) needs that directory passed as an extra
argument.

## Protocol
Chrome native messaging framing (4-byte little-endian length, UTF-8 JSON, at most 1 MB each way). Chrome passes the
caller's origin as the first argument; any origin other than `chrome-extension://<configured id>/` gets `E_ORIGIN`.
Commands: `hello`, `prepare`, `online`; the schemas are in `extension-team/INTERFACES.md`. Use
`chrome.runtime.connectNative`: `prepare` keeps its fresh key material in that host process until `online` on the
same port uses it once.

`prepare` takes the same request the client CLI gives `local-prover fixture-local`, runs it, then
`prove-local ... preparation`; `online` runs `prove-local ... online` on the same fixture. Each proof has a 10-minute
timeout and the fixture a 1-minute one.

The fixture holds the order and fresh keys. The helper keeps it in memory and writes it only for the duration of
each `prove-local` call, as `fixture.json` (0600) in a new private temporary directory (0700). A small shell guard
around `local-prover` deletes that directory when the prover exits, so it doesn't outlive the proof even if the
helper is killed. On a disconnect, `SIGTERM`, timeout or error the helper stops the prover's process group and
deletes the directory itself. It logs nothing, and prover errors from proving are reported by exit status only.

## Test
```bash
cd packages/prover-helper && go test -count=1 .        # or npm test; offline, uses a stand-in local-prover
ADMISSION_PARAMS=$PWD/../proof-bench/results/admission-params go test -count=1 -v -run TestRealProofsVerifyOnchain .
```
The offline tests cover framing and oversized messages, origin refusal, protocol and parameter-hash refusal,
sessions, witness cleanup after disconnect, `SIGTERM` and `SIGKILL` mid-proof, and the installer. The opt-in test
proves a real order through the helper and verifies both proofs with the generated Solidity verifiers on an isolated
anvil (port 8562), deriving the public inputs from the journals as `AdmissionProof.verify` does. It needs `anvil`,
`cast` and the verifier artifacts that `check-admission.sh` builds. Measurements: [MEASUREMENTS.md](MEASUREMENTS.md).
