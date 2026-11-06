# Security

The full boundary-by-boundary review is [`TRUST-BOUNDARIES.md`](../TRUST-BOUNDARIES.md). This page is the short version.

## What protects what

- **Keys stay with the signer.**
  - Local route: the CLI holds the key, and the trading page never sees it.
  - Extension route: the browser wallet signs, and the bridge page only relays transaction requests.
- **The page can only ask for fixed actions.** The local server accepts a fixed action list, validates every argument, binds to `127.0.0.1`, checks the `Host` and `Origin` headers, and requires a custom request header. Another website can't drive it, and it refuses to be framed.
- **Orders are sealed until the batch closes.** Each order is timelock-encrypted to a drand round published after the commit window, so no operator can read it early.
- **Admission proofs** (with admission on) show each order is correctly encrypted and funded, without revealing it.
- **The witness never leaves your machine.**
  - The prover gets it on stdin or in a private temp file, which is deleted after the proof. Leftovers from a killed process are swept.
  - Prover diagnostics are discarded, because they could echo private values.
- **A bad price can't settle.** The contract checks every limit and the post-swap pool price, and only the settlement contract may swap in the pool.
- **You can always leave.** If nobody settles, anyone can expire the batch; if nobody reveals, unrevealed orders can be released or slashed. Funds then unlock for withdrawal.

## Known limits

| Limit | Impact | Status |
|---|---|---|
| Development proving parameters come from a single-machine setup | Whoever ran the setup could forge admission proofs | A production setup and authenticated parameter distribution are still to do |
| Private state and backups are plain JSON (`0600`) | Anyone with access to your files can read your orders and salts | Encryption at rest is an open decision; the extension already encrypts with a passphrase |
| Any process on your machine can read local job results | They show account, balances and order sizes, but no keys or salts | Acceptable for a single-user machine |
| The fee-on-transfer check needs an RPC with `eth_call` state overrides | Without them, deposits fail closed | Safe, but it blocks deposits on such RPCs |

## Reporting

Please report security issues privately to the maintainers (GitHub: `kodykebab`) rather than in a public issue.
