#!/usr/bin/env bash
# Court's release gates (S21, #27), each checked on its own by the offline forge tests that prove it.
# HANDOFF.md "Court release boundary" says what each gate enforces and its status.
#   scripts/court-gates.sh              # every gate, one PASS/FAIL line each
#   scripts/court-gates.sh valuation    # one gate
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/contracts"
# shellcheck disable=SC1091
source ../env.sh

# gate|forge --match-test filter over test/court/*
gates='
issuance|test_rejects_(replay|receiptForAnotherTx|landedAfterMaxBlock|wrongChain|unbondedSigner|tamperedReceipt|noBeneficiary)|test_receiptMustPrecedeTheSandwichBlock|test_paysTheBeneficiary_notTheTxSigner|test_signature_|test_acceptedAt_boundary|test_receiptDigest_isEip712
attribution|test_predicate|test_recover_allTxTypes|test_v4_sharedRouter_victimIsAVictim|test_rejects_sharedRouter_unrelatedWallets|test_demoSandwich_shapeAndBudget
evidence|test_v[34]_(blockhash|eip2935|anchor)|test_anchor_|test_rejects_(tamperedVictimTx|legsOutOfOrder|wrongV4PoolId|v4ClaimedAsV3|wrongLogHint|unknownBlock|localPathForAnotherChain)
valuation|test_v3_local_paysTheFeeCappedBudget|test_v3_profitInUsdt_revertsUnpaid|test_v4_zeroFeePool_hasNoBudget|test_rejects_(unlistedPool|v3PoolNotFromFactory|v4NotCanonicalPoolManager|v4WrongPoolKey|zeroBudget|dynamicFeePool)|test_budget_frontFeeCapsTheProfit|test_profitToken_allFourSides|test_v4PoolKeyMustHashExactly|selfSandwich|test_jitLiquidity
incidents|test_incident_|testFuzz_incidentConservation|test_oneFront_manyBacks|test_rejects_oneBackClosingTwoFronts|test_sameFrontTx_anotherSwapLog|invariant_incidentNeverOverpays
funding|test_payout|test_proverGetsGasAtBasefee|test_unbond|testFuzz_payoutIsMin|test_refundCappedByWhatIsLeft|test_zeroCapPaysNothing|test_beneficiaryThatRejectsEth|test_reentrantBeneficiary|invariant_ethHeldEqualsBonds|invariant_reservationsCovered
'

fail=0
ran=0
while IFS='|' read -r name filter; do
  [ -n "$name" ] || continue
  [ -z "${1:-}" ] || [ "$1" = "$name" ] || continue
  ran=1
  if out="$(forge test --match-path 'test/court/*' --match-test "$filter" 2>&1)" \
    && n="$(grep -oE '[0-9]+ tests passed, 0 failed' <<<"$out" | grep -oE '^[0-9]+')" && [ "$n" -gt 0 ]; then
    echo "PASS  $name ($n tests)"
  else
    echo "FAIL  $name"
    tail -20 <<<"$out"
    fail=1
  fi
done <<<"$gates"
[ "$ran" = 1 ] || { echo "unknown gate: $1"; exit 2; }
exit "$fail"
