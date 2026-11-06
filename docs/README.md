# Blindfold documentation

Blindfold is an MEV-protected way to trade on Uniswap v4. Orders are sealed until a batch closes and then settled together at one price. **Court** is a separate protection: a bonded "protected RPC" is slashed if a transaction it promised to protect gets sandwiched.

## Start here

| If you want to… | Read |
|---|---|
| Understand what Blindfold does and why | [Overview](overview.md) |
| Run it on your machine | [Getting started](getting-started.md) |
| Place and track an order on the trading page | [User guide](user-guide.md) |
| See how the pieces fit together | [Architecture](architecture.md) |
| Drive it from the command line | [CLI reference](cli.md) |
| Configure the client, keeper, solver or page | [Configuration](configuration.md) |
| Run the tests | [Testing](testing.md) |
| Know what each component may see and do | [Security](security.md) |
| Look up a term (batch, reveal, admission, …) | [Glossary](glossary.md) |

## Deeper material

- [`ARCHITECTURE.MD`](../ARCHITECTURE.MD): the protocol design in full: timing formulas, private funding, the admission proof relation, settlement maths, Court evidence, global auctions.
- [`TRUST-BOUNDARIES.md`](../TRUST-BOUNDARIES.md): every trust boundary and the code that enforces it.
- [`DEMO.md`](../DEMO.md): the Court demo and the three-user demo.
- [`CHECKLIST.md`](../CHECKLIST.md): release status, with the test that proves each item.
- Each package has its own README with details: [client](../packages/client/README.md), [keeper](../packages/keeper/README.md), [solver](../packages/solver/README.md), [arkiv](../packages/arkiv/README.md), [extension](../packages/extension/README.md), [bridge](../packages/bridge/README.md), [prover-helper](../packages/prover-helper/README.md), [proof-bench](../packages/proof-bench/README.md), [trading page](../app/haveibeensandwiched/README.md).
