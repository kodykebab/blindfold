# Local prover measurements

Measured on 2026-11-06: Apple M4, 10 cores, 24 GiB memory, macOS 26.6.2 (25G83). Each row launches a new
`local-prover prove-local` process with one synthetic order and the same development parameters. Preparation
samples ran alongside the extension E3 test; these are measurements of that run, with concurrent load.

Program identity and toolchain:

- `local-prover` SHA-256: `e65c3d4d2ea7d6c0f9db7ed6d08a8654291dc73c804b655ce6cbaea28a4d74b9`.
- Parameter manifest SHA-256: `82b4b662b005e689ef3f73e2664fb8e81901673cdce7661bd1cb77d37af8f306`.
- Go 1.27.0; gnark 0.16.4; gnark-crypto `0.21.1-0.20260913224755-1409fe592052`.
- Local chain ID 31337. Synthetic request: batch 3, drand round 1000000, funding step 0, sell 1 token with minimum
  1 base unit, budgets 100 and 99 tokens (18 decimals), a fresh salt and zero previous funding root.

| Mode | Run | Wall time (s) | Maximum resident memory (bytes) |
| --- | --- | --- | --- |
| preparation | 1 | 191.43 | 4,796,317,696 |
| preparation | 2 | 180.26 | 4,686,741,504 |
| preparation | 3 | 179.11 | 5,109,841,920 |
| preparation | 4 | 103.12 | 5,989,875,712 |
| online | 1 | 85.83 | 4,692,836,352 |
| online | 2 | 88.08 | 4,678,369,280 |
| online | 3 | 90.42 | 4,668,686,336 |
| online | 4 | 81.17 | 4,687,298,560 |

`fixture-local` took 0.04 seconds and 11,976,704 bytes maximum resident memory. The table measures proof generation
separately for each mode, using macOS `/usr/bin/time -l`; it excludes parameter setup, browser requests, helper
installation and onchain verification. The extension's E3 test exercises complete admissions and onchain execution.
The raw timings and binary build metadata are saved locally in ignored `results/2026-11-06.log`.

To time either mode with an existing private fixture (do not commit it or the resulting proof):

```bash
source env.sh
PIN=$(shasum -a 256 packages/proof-bench/results/admission-params/manifest.json | cut -d ' ' -f 1)
/usr/bin/time -l packages/proof-bench/results/local-prover prove-local \
  packages/proof-bench/results/admission-params "$PIN" preparation /absolute/private/fixture.json >/dev/null
# Repeat with online in place of preparation.
```
