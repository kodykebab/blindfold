# Arkiv

Thin local mirror for public settled batches. Contract state stays authoritative. See [arkiv/schema.md](../../arkiv/schema.md).

```bash
npm test          # offline put/query
npm start -- --once
```

`ARKIV=off` (the default) keeps rows in memory for this process. `ARKIV_RPC` and `ARKIV_KEY` are read only when `ARKIV=testnet`. A missing or unusable Arkiv throws `history unavailable` from `query`. The trading page catches that and still trades.

`mirrorSettled` accepts public batch fields only: `batchId`, `pair`, `clearingPrice`, `orderCount`, `settleTx`.
