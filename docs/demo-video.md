# Recording the 4-minute demo (Loom)

A shot list for a cut video. Every wait (proving, batch windows, deploys) is a cut, so the finished video runs about 3:50 while the recording takes about 20 minutes. Times below are **on-screen time after cuts**.

## Before you press record (about 10 minutes, not filmed)

1. **Start the stack** and keep its output visible in terminal 1:
   ```bash
   source env.sh
   WEB_PORT=4400 scripts/dev.sh
   ```
   Note the `Local deployment and private state:` directory it prints. Below it's `$D`: `export D=<that directory>`.
2. **Open browser tabs:**
   - `http://127.0.0.1:4400/` (the sandwich checker);
   - `http://127.0.0.1:4400/trade`.
3. **Fund both traders** (terminal 2):
   - On the page: **Refresh**, then deposit 20 of `token0` and 20 of `token1`.
   - Second trader:
     ```bash
     scripts/demo-trader.sh $D deposit token0 20
     scripts/demo-trader.sh $D deposit token1 20
     ```
   - (Stacks started before the trader-funding change need `scripts/demo-trader.sh $D fund` first.)
4. **Prepare ahead for the next batch,** so the orders only need the fast online proof. Read the batch number `N` from **Current batch**, then prepare for `N+1`:
   - on the page, click **Prepare for batch N+1**;
   - in terminal 2: `scripts/demo-trader.sh $D prepare-admission <N+1>`.

   Each takes about 2 to 3 minutes. Run them together.
5. **Pre-run the Court demo** in terminal 3, which uses its own chain: `scripts/court-demo.sh`. Leave its output on screen; you'll scroll it in scene 2.

## Shot list

| # | On screen | Do | Say (roughly) | Length |
|---|---|---|---|---|
| 1 | Sandwich checker (`/`) | Paste `0x22ff1f22701816646547335b596f6d3eb36313008980d44dab0f653fa7458294`, press enter. **Cut** the load. | "This is a real mainnet swap. A bot bought right before it and sold right after: a sandwich. The victim paid for it." | 0:25 |
| 2 | Terminal 3, `court-demo.sh` output | Scroll from the bonded RPC to `PASS beneficiary … paid … ETH`. | "Protected RPCs promise to hide your swap. With Court, that promise is bonded. When a protected swap is sandwiched anyway, anyone proves it on chain, and the victim is paid from the RPC's bond." | 0:35 |
| 3 | `/trade` | Wait until **Current batch** shows `N+1`. Enter Sell 10, Minimum out 9.5, click **Review order**. | "Blindfold removes the sandwich altogether. Orders are sealed and settled in batches at one price." Point at the fee, deposit and quote. | 0:20 |
| 4 | `/trade` | **Confirm and commit.** Show **Encrypt → Prove → Submit**. **Cut** to *Included*. | "The order is encrypted to a future drand round, and a zero-knowledge proof made on this laptop shows it's valid and funded, without revealing it." | 0:20 |
| 5 | Terminal 2 | `scripts/demo-trader.sh $D commit buy 10 9.5 --vault-only --both-funded`. **Cut** to `admitted #…`. | "A second trader takes the other side in the same batch." | 0:10 |
| 6 | Terminal 2 | `node scripts/demo-frontrun.mjs $D` | "Now a searcher. All it can see is ciphertext, unreadable until the round. Its front-run swap is rejected on chain: only the settlement contract may trade in this pool." | 0:30 |
| 7 | `/trade`, **Your orders** | Export the backup when prompted. **Cut** past the batch close, then **Refresh**: *Waiting for reveal* → *Waiting for settlement* → *Filled*. | "Once the beacon round is out, a keeper reveals both orders. A solver settles them at a single clearing price, so there's no before or after inside a batch." | 0:40 |
| 8 | `/trade` | Show executed, received and unused amounts, and **Recent batches**. Click **Withdraw all**. | "Fills, unused input and the batch history are all public. Funds go straight back to the wallet." | 0:20 |
| 9 | Terminal or `docs/` | Show the `e2e.sh` summary line, or the test table in `docs/testing.md`. | "All of this runs under end-to-end tests with real proofs. The live site shows /trade as a preview; trading runs on your own machine, because your key and proofs never touch a server." | 0:15 |
| | | | **Total** | **≈3:35** |

## Tips

- **Same batch for both orders.** Both commits must land before `commitsClose`. With preparations ready, each online proof takes about a minute. Start the page order, then the terminal one straight away; they run in parallel.
- **If a proof misses the batch,** the page says *Batch closed before submission*. Prepare for the next batch and retake from scene 3.
- **Matching:** "Sell 10" on the page and "buy 10" from the second trader cross at about 1:1 in the local pool, so both show **Filled**. Make one side larger (for example buy 15) to show **Partly filled** with unused input.
- **Keep terminal 1 visible in one cut** (the health lines) to show the keeper and solver are real processes.
- **Drand is live.** The stack needs internet. If a venue's network is flaky, record scenes 3 to 8 beforehand.
