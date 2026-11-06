use anyhow::Result;
use blindfold_proof_bench::{prepared::*, *};
#[test]
fn prepared_orders_decrypt_and_preserve_funding() -> Result<()> {
    for (d, a, step) in [
        (true, 0, 0),
        (true, 100, 0),
        (false, 100, 1),
        (true, u128::MAX, 63),
    ] {
        let (p, pw, o, ow) = sample_pair(d, a, step)?;
        check_pair(&p, &pw, &o, &ow)?;
        let mut recovered = Vec::new();
        tlock_age::decrypt(
            &mut recovered,
            ow.order.ciphertext.as_slice(),
            &hex::decode(CHAIN_HASH)?,
            &hex::decode(ROUND_1000_SIGNATURE)?,
        )?;
        assert_eq!(recovered, plaintext(&o.admission, &ow.order));
        assert_eq!(preparation_journal(&p).len(), 256);
        assert_eq!(online_journal(&o).len(), 480);
        assert_eq!(preparation_journal(&p), online_journal(&o)[..256]);
        let mut unfunded = o.clone();
        unfunded.admission.budgets = Default::default();
        if a != 0 || step != 0 {
            assert!(check_online(&unfunded, &ow).is_err());
        }
    }
    Ok(())
}
#[test]
fn rejects_spliced_preparations() -> Result<()> {
    let (p, pw, o, ow) = sample_pair(true, 100, 0)?;
    let (other, other_w, _, _) = sample_pair(true, 100, 0)?;
    check_preparation(&other, &other_w)?;
    check_online(&o, &ow)?;
    assert!(check_pair(&other, &other_w, &o, &ow).is_err());
    for i in 0..6 {
        let mut changed = o.clone();
        match i {
            0 => changed.admission.chain_id += 1,
            1 => changed.admission.settlement[0] ^= 1,
            2 => changed.admission.owner[0] ^= 1,
            3 => changed.admission.batch += 1,
            4 => changed.admission.round += 1,
            _ => changed.commitment[0] ^= 1,
        }
        assert!(check_pair(&p, &pw, &changed, &ow).is_err());
        assert!(check_online(&changed, &ow).is_err());
    }
    Ok(())
}
#[test]
fn recomputing_commitment_cannot_hide_wrong_wrapper_or_key() -> Result<()> {
    let (p, pw, o, ow) = sample_pair(true, 100, 0)?;
    for i in 0..4 {
        let mut s = p.clone();
        let mut w = pw.clone();
        match i {
            0 => w.key[0] ^= 1,
            1 => w.sigma[0] ^= 1,
            2 => w.wrapper[0] ^= 1,
            _ => s.context.round += 1,
        }
        s.commitment = commitment(&s.context, &w.wrapper, w.key, w.blind);
        assert!(check_preparation(&s, &w).is_err());
    }
    let mut s = o.clone();
    let mut w = ow.clone();
    w.order.file_key[0] ^= 1;
    s.commitment = commitment(
        &Context::from(&s.admission),
        &w.wrapper,
        w.order.file_key,
        w.blind,
    );
    assert!(check_online(&s, &w).is_err());
    Ok(())
}
#[test]
fn online_authenticates_header_payload_hash_and_funding() -> Result<()> {
    let (_, _, o, ow) = sample_pair(true, 100, 1)?;
    for i in 0..8 {
        let mut s = o.clone();
        let mut w = ow.clone();
        match i {
            0 => w.order.ciphertext[0] ^= 1,
            1 => {
                let n = w.order.ciphertext.len();
                w.order.ciphertext[n - 1] ^= 1;
            }
            2 => {
                w.order.ciphertext.pop();
            }
            3 => s.admission.old_root[0] ^= 1,
            4 => s.admission.new_root[0] ^= 1,
            5 => {
                w.order.amount += 1;
                s.admission.order_hash = order_hash(&s.admission, &w.order);
            }
            6 => s.admission.order_hash[0] ^= 1,
            _ => s.admission.step += 1,
        }
        s.admission.ciphertext_hash = hash(&w.order.ciphertext);
        assert!(check_online(&s, &w).is_err(), "case {i}");
    }
    Ok(())
}
