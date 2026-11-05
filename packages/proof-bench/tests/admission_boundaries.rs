use anyhow::Result;
use blindfold_proof_bench::{check, hash, root, sample};
use primitive_types::U256;

#[test]
fn exact_budget_and_one_unit_short_for_each_direction() -> Result<()> {
    for direction in [true, false] {
        for amount in [1, 100, u128::MAX] {
            let (mut s, w) = sample(1000, direction, amount, 0)?;
            let side = usize::from(!direction);
            s.budgets = [U256::zero(); 2];
            s.budgets[side] = amount.into();
            check(&s, &w)?;
            s.budgets[side] -= U256::one();
            assert!(check(&s, &w).is_err());
        }
    }
    Ok(())
}

#[test]
fn padding_still_requires_previous_funding_and_next_root() -> Result<()> {
    let (mut s, w) = sample(1000, false, 0, 1)?;
    s.budgets = w.totals;
    check(&s, &w)?;
    let mut bad = s.clone();
    bad.new_root = s.old_root;
    assert!(check(&bad, &w).is_err());
    s.budgets[0] -= U256::one();
    assert!(check(&s, &w).is_err());
    Ok(())
}

#[test]
fn totals_out_of_range_reject_even_with_consistent_roots() -> Result<()> {
    let (mut s, mut w) = sample(1000, true, 1, 1)?;
    w.totals = [U256::from(u128::MAX) * 64, U256::zero()];
    s.old_root = root(&s, w.totals, w.old_blind, s.step);
    s.new_root = root(&s, [w.totals[0] + 1, U256::zero()], w.new_blind, s.step + 1);
    s.budgets = [U256::MAX; 2];
    assert!(check(&s, &w).is_err());
    w.totals[0] = U256::MAX;
    s.old_root = root(&s, w.totals, w.old_blind, s.step);
    assert!(check(&s, &w).is_err());
    Ok(())
}

#[test]
fn truncated_ciphertext_rejects_with_updated_public_hash() -> Result<()> {
    let (s, w) = sample(1000, true, 100, 0)?;
    for length in [0, 1, 20, w.ciphertext.len() / 2, w.ciphertext.len() - 1] {
        let mut bad_s = s.clone();
        let mut bad_w = w.clone();
        bad_w.ciphertext.truncate(length);
        bad_s.ciphertext_hash = hash(&bad_w.ciphertext);
        assert!(check(&bad_s, &bad_w).is_err(), "length {length}");
    }
    Ok(())
}

#[test]
fn zero_round_and_oversized_ciphertext_reject() -> Result<()> {
    let (s, w) = sample(1000, true, 100, 0)?;
    let mut bad_s = s.clone();
    bad_s.round = 0;
    assert!(check(&bad_s, &w).is_err());
    let mut bad_w = w.clone();
    bad_w.ciphertext.resize(2049, 0);
    bad_s = s;
    bad_s.ciphertext_hash = hash(&bad_w.ciphertext);
    assert!(check(&bad_s, &bad_w).is_err());
    Ok(())
}
