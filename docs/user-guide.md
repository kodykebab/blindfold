# User guide: the trading page

The trading page (`/trade`) runs on your machine and drives the local client. **It never holds keys and never signs.** The client signs with the account it's configured with (in the dev stack, Anvil test account 10). Start it with [Getting started](getting-started.md).

Commands run one at a time. While one runs, the buttons are disabled and **Activity** shows what's happening. If you reload the page, it reconnects to the command that was running.

## 1. Load your account

Click **Refresh** (or **View account & balances**). You'll see:
- **Your account** and the network and pair, for example `network 31337 · TKB / TKA`.
- **Funds & activity**: for each token, **Wallet**, **Available (vault)**, **Reserved (open commitments)** and **Withdrawable**.
- **Current batch**: the phase (committing, revealing, settling) and seconds until each deadline.
- **Get ready to trade**: the preparation state (with admission on).

## 2. Fund the vault

Orders trade from the vault, not your wallet. In **Funds & activity**, choose `token0` or `token1`, enter an amount, and click **Deposit**. Fund **both** tokens: the page refuses orders until both have a balance, and it never tops up a shortfall for you.

A token that charges a fee on transfer, or rebases, is refused **before** any money moves.

## 3. Prepare ahead (admission on)

With admission on, each order needs two zero-knowledge proofs. The slow one (about 2 to 3 minutes, up to about 6 GB of memory) can be made ahead of time for a batch. **Get ready to trade** offers **Prepare for batch N** whenever nothing usable is prepared.

| The panel says | Meaning |
|---|---|
| Nothing is prepared | Prepare for the next batch, or the order will make both proofs itself. A submission uses its preparation up, so this is normal after an order. |
| Prepared for batch N | Your next order in batch N only needs the fast online proof. |
| …whose commit window has closed | That batch passed. Prepare again. |
| …another account, network or deployment | The preparation doesn't belong here. Prepare again. |
| Re-check needed | The account, network or pair changed since the last status. Submitting is off until you review again. |
| Local private state can't be read | Restore a backup (step 7). |

## 4. Review, then confirm

In **Place an order**:
1. Choose **Sell** or **Buy**.
2. Enter the **Amount in** and the **Minimum out** (your limit: the least you'll accept).
3. Click **Review order**. The review restates:
   - the order and its batch;
   - the batch's reveal and settle deadlines;
   - the commit fee and the deposit (and when it comes back);
   - any approvals;
   - the estimated gas;
   - the current pool price with its age, and pool liquidity.

   Prices and liquidity are labelled as estimates. Your fill price is set when the batch settles.
4. Click **Confirm and commit**. The page re-checks the order first. If your balance changed or the quote moved since the review, it shows what changed and asks you to review again; nothing is sent.

While it runs, **Activity** shows **Encrypt → Prove → Submit → Included**, with elapsed time and this machine's usual proving time.

You can have orders in **one batch at a time**. A new order waits until the current batch settles or its orders are released.

## 5. Back up immediately

After an order, a reminder appears: **Export a backup now.** Click **Export backup ↓**, save the file somewhere private, then click **I've saved my backup somewhere private**. The reminder only clears after a backup made since your last order is confirmed. It comes back after the next order.

**The backup isn't encrypted.** It holds your orders and salts: store it like a password. Without it, if this machine is lost, the order can't be revealed or recovered by you; a keeper can still reveal it.

## 6. Track your orders and withdraw

**Your orders** lists every order with its batch, stage, and amounts (executed / received / unused).

| Stage | What happened |
|---|---|
| Waiting for reveal | Encrypted. A keeper, or you, reveals it once the batch's drand round is out. |
| Waiting for settlement | Revealed. The solver settles the batch before its settle deadline. |
| Filled | Fully executed. |
| Partly filled | Part executed; the unused input stays in your vault. |
| Not filled | The clearing price was outside your limit; all input stays in your vault. |
| Expired | The batch was never settled; run cleanup. |
| Released | Never revealed; the deposit came back minus the fee. |
| Slashed | Never revealed (admission off); the deposit was forfeited. |
| Closed: unfunded | The vault didn't hold the input at reveal. |
| Padding | A zero-size order that hides how many orders you placed. |

The policy line above the table gives this deployment's fee, deposit and keeper bounty. Reveal your own order to keep the whole deposit.

**Withdrawals are blocked while any order is open.** The summary names what blocks you. The **Next step** column offers **Reveal now** or **Clean up** when that's possible; both show what will be sent before sending. When nothing blocks you, **Withdraw all** appears for each token.

## 7. Restore a backup

Use **Restore backup** in **Your private state** and choose the exported file. A refused backup says why:
- it belongs to another account, network or deployment;
- it's older than the chain state;
- an order or salt in it was changed;
- it isn't a readable backup.

Your local state is left unchanged.

## Messages you might see

Every failure reads as a sentence and a next step. The common ones:

| Message | Do |
|---|---|
| Fund the vault first | Deposit the amount the review shows. |
| One batch at a time | Wait for your current batch to settle, or clean it up. |
| Batch closed before submission | Prepare for the next batch and review again. |
| Device can't finish the proof | Prepare ahead, or free up memory. |
| Admission needs a resume | Click **Resume admission**. It resends or reconciles the same saved proof. |
| Transaction dropped / replaced / reverted | Refresh status before trying again. A dropped one can simply be retried. |
| Already running | Wait for the current command to finish. |
| Local service unreachable | `scripts/dev.sh` stopped. Start it and refresh. |
