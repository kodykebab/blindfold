//! Native statement checker for the proof feasibility benchmark.
use age::secrecy::ExposeSecret;
use age_core::format::{FileKey, Stanza};
use anyhow::{ensure, Result};
use primitive_types::U256;
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};
use std::{
    collections::HashSet,
    io::{Read, Write},
    sync::Mutex,
};

#[cfg(feature = "accelerated")]
pub mod accelerated;

pub const CHAIN_HASH: &str = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
pub const PUBLIC_KEY: &str = "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
pub const ROUND_1000_SIGNATURE: &str = "b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39";

#[derive(Clone, Serialize, Deserialize)]
pub struct Statement {
    pub chain_id: u64,
    pub settlement: [u8; 20],
    pub owner: [u8; 20],
    pub batch: u64,
    pub round: u64,
    pub step: u64,
    pub old_root: [u8; 32],
    pub new_root: [u8; 32],
    pub budgets: [U256; 2],
    pub order_hash: [u8; 32],
    pub ciphertext_hash: [u8; 32],
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Witness {
    pub zero_for_one: bool,
    pub amount: u128,
    pub minimum: u128,
    pub salt: [u8; 32],
    pub totals: [U256; 2],
    pub old_blind: [u8; 32],
    pub new_blind: [u8; 32],
    pub file_key: [u8; 16],
    pub sigma: [u8; 16],
    pub ciphertext: Vec<u8>,
}

pub fn hash(bytes: &[u8]) -> [u8; 32] {
    Keccak256::digest(bytes).into()
}
fn word(x: U256) -> [u8; 32] {
    let mut b = [0; 32];
    x.to_big_endian(&mut b);
    b
}
fn address_word(x: &[u8; 20]) -> [u8; 32] {
    let mut b = [0; 32];
    b[12..].copy_from_slice(x);
    b
}

pub fn plaintext(s: &Statement, w: &Witness) -> Vec<u8> {
    [
        address_word(&s.owner),
        word(U256::from(w.zero_for_one as u8)),
        word(w.amount.into()),
        word(w.minimum.into()),
        w.salt,
    ]
    .concat()
}
pub fn order_hash(s: &Statement, w: &Witness) -> [u8; 32] {
    hash(
        &[
            word(s.chain_id.into()).as_slice(),
            &address_word(&s.settlement),
            &word(s.batch.into()),
            &plaintext(s, w),
        ]
        .concat(),
    )
}
pub fn root(s: &Statement, totals: [U256; 2], blind: [u8; 32], step: u64) -> [u8; 32] {
    hash(
        &[
            word(s.chain_id.into()),
            address_word(&s.settlement),
            address_word(&s.owner),
            word(s.batch.into()),
            word(totals[0]),
            word(totals[1]),
            blind,
            word(step.into()),
        ]
        .concat(),
    )
}

// The identity checks the tlock wrapper BEFORE returning the private file key.
// AGE then authenticates the header and the entire payload with that key.
struct CheckedIdentity {
    round: u64,
    expected: Vec<u8>,
    file_key: [u8; 16],
}
impl age::Identity for CheckedIdentity {
    fn unwrap_stanza(&self, stanza: &Stanza) -> Option<Result<FileKey, age::DecryptError>> {
        if stanza.tag != "tlock" {
            return None;
        }
        if stanza.args != [self.round.to_string(), CHAIN_HASH.to_string()]
            || stanza.body != self.expected
        {
            return Some(Err(age::DecryptError::InvalidHeader));
        }
        Some(Ok(FileKey::new(Box::new(self.file_key))))
    }
}

pub fn check(s: &Statement, w: &Witness) -> Result<()> {
    ensure!(s.round != 0 && s.step < 64, "schedule/step");
    ensure!(w.ciphertext.len() <= 2048, "ciphertext bound");
    ensure!(hash(&w.ciphertext) == s.ciphertext_hash, "ciphertext hash");
    ensure!(order_hash(s, w) == s.order_hash, "order hash");
    if s.step == 0 {
        ensure!(
            s.old_root == [0; 32] && w.totals == [U256::zero(); 2] && w.old_blind == [0; 32],
            "initial state"
        );
    } else {
        ensure!(
            root(s, w.totals, w.old_blind, s.step) == s.old_root,
            "old root"
        );
    }
    let max_total = U256::from(u128::MAX) * U256::from(64);
    let mut next = w.totals;
    ensure!(next.iter().all(|x| *x <= max_total), "total range");
    let input = if w.zero_for_one { 0 } else { 1 };
    next[input] = next[input]
        .checked_add(w.amount.into())
        .ok_or_else(|| anyhow::anyhow!("overflow"))?;
    ensure!(next.iter().all(|x| *x <= max_total), "total range");
    ensure!(
        next[0] <= s.budgets[0] && next[1] <= s.budgets[1],
        "funding"
    );
    ensure!(
        root(s, next, w.new_blind, s.step + 1) == s.new_root,
        "new root"
    );
    #[cfg(not(feature = "accelerated"))]
    let expected =
        tlock::encrypt_with_sigma(&hex::decode(PUBLIC_KEY)?, s.round, w.file_key, w.sigma)?;
    #[cfg(feature = "accelerated")]
    let expected = accelerated::wrap(s.round, w.file_key, w.sigma)?;
    let identity = CheckedIdentity {
        round: s.round,
        expected,
        file_key: w.file_key,
    };
    let decryptor = age::Decryptor::new(w.ciphertext.as_slice())?;
    ensure!(!decryptor.is_scrypt(), "recipient");
    let mut reader = decryptor.decrypt(std::iter::once(&identity as &dyn age::Identity))?;
    let mut output = Vec::new();
    reader.read_to_end(&mut output)?;
    ensure!(output == plaintext(s, w), "payload");
    Ok(())
}

struct RecordingRecipient {
    round: u64,
    sigma: [u8; 16],
    file_key: Mutex<[u8; 16]>,
}
impl age::Recipient for RecordingRecipient {
    fn wrap_file_key(
        &self,
        key: &FileKey,
    ) -> Result<(Vec<Stanza>, HashSet<String>), age::EncryptError> {
        let k: [u8; 16] = key.expose_secret().as_slice().try_into().unwrap();
        *self.file_key.lock().unwrap() = k;
        let body =
            tlock::encrypt_with_sigma(&hex::decode(PUBLIC_KEY).unwrap(), self.round, k, self.sigma)
                .map_err(|e| age::EncryptError::Io(std::io::Error::other(e.to_string())))?;
        Ok((
            vec![Stanza {
                tag: "tlock".into(),
                args: vec![self.round.to_string(), CHAIN_HASH.into()],
                body,
            }],
            HashSet::new(),
        ))
    }
}

// Synthetic public test fixture: fixed sigma is never used for real user orders.
pub fn sample(
    round: u64,
    zero_for_one: bool,
    amount: u128,
    step: u64,
) -> Result<(Statement, Witness)> {
    let mut s = Statement {
        chain_id: 130,
        settlement: [1; 20],
        owner: [2; 20],
        batch: 7,
        round,
        step,
        old_root: [0; 32],
        new_root: [0; 32],
        budgets: [U256::from(u128::MAX) * 64; 2],
        order_hash: [0; 32],
        ciphertext_hash: [0; 32],
    };
    let mut w = Witness {
        zero_for_one,
        amount,
        minimum: 1,
        salt: [3; 32],
        totals: if step == 0 {
            [U256::zero(); 2]
        } else {
            [U256::from(u128::MAX) * step, U256::zero()]
        },
        old_blind: if step == 0 { [0; 32] } else { [4; 32] },
        new_blind: [5; 32],
        file_key: [0; 16],
        sigma: [6; 16],
        ciphertext: vec![],
    };
    let recipient = RecordingRecipient {
        round,
        sigma: w.sigma,
        file_key: Mutex::new([0; 16]),
    };
    let encryptor =
        age::Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))?;
    let payload = plaintext(&s, &w);
    let mut writer = encryptor.wrap_output(&mut w.ciphertext)?;
    writer.write_all(&payload)?;
    writer.finish()?;
    w.file_key = *recipient.file_key.lock().unwrap();
    s.order_hash = order_hash(&s, &w);
    s.ciphertext_hash = hash(&w.ciphertext);
    if step != 0 {
        s.old_root = root(&s, w.totals, w.old_blind, step);
    }
    let mut next = w.totals;
    next[if zero_for_one { 0 } else { 1 }] += U256::from(amount);
    s.new_root = root(&s, next, w.new_blind, step + 1);
    Ok((s, w))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quicknet_standard_decryption_and_all_order_shapes() -> Result<()> {
        for (direction, amount, step) in [
            (true, 0, 0),
            (true, 100, 0),
            (false, 100, 1),
            (true, u128::MAX, 63),
        ] {
            let (s, w) = sample(1000, direction, amount, step)?;
            check(&s, &w)?;
            let mut recovered = Vec::new();
            tlock_age::decrypt(
                &mut recovered,
                w.ciphertext.as_slice(),
                &hex::decode(CHAIN_HASH)?,
                &hex::decode(ROUND_1000_SIGNATURE)?,
            )?;
            assert_eq!(recovered, plaintext(&s, &w));
        }
        Ok(())
    }
    #[test]
    fn rejects_invalid_statement_substitutions() -> Result<()> {
        let (s, w) = sample(1000, true, 100, 1)?;
        for i in 0..12 {
            let mut bad = s.clone();
            match i {
                0 => bad.chain_id += 1,
                1 => bad.settlement[0] ^= 1,
                2 => bad.owner[0] ^= 1,
                3 => bad.batch += 1,
                4 => bad.round += 1,
                5 => bad.step += 1,
                6 => bad.old_root[0] ^= 1,
                7 => bad.new_root[0] ^= 1,
                8 => bad.order_hash[0] ^= 1,
                9 => bad.ciphertext_hash[0] ^= 1,
                10 => bad.budgets[0] = U256::zero(),
                _ => bad.step = 64,
            }
            assert!(check(&bad, &w).is_err(), "substitution {i}");
        }
        Ok(())
    }
    #[test]
    fn rejects_bad_key_randomness_payload_and_wrapper() -> Result<()> {
        let (s, w) = sample(1000, false, 100, 0)?;
        for i in 0..5 {
            let mut bad_s = s.clone();
            let mut bad = w.clone();
            match i {
                0 => bad.file_key[0] ^= 1,
                1 => bad.sigma[0] ^= 1,
                2 => {
                    let end = bad.ciphertext.len() - 1;
                    bad.ciphertext[end] ^= 1;
                    bad_s.ciphertext_hash = hash(&bad.ciphertext);
                }
                3 => {
                    bad.salt[0] ^= 1;
                    bad_s.order_hash = order_hash(&bad_s, &bad);
                }
                _ => {
                    bad.old_blind[0] ^= 1;
                }
            }
            assert!(check(&bad_s, &bad).is_err(), "witness {i}");
        }
        Ok(())
    }
    #[test]
    fn wrapping_is_reproducible_and_round_bound() -> Result<()> {
        let pk = hex::decode(PUBLIC_KEY)?;
        let a = tlock::encrypt_with_sigma(&pk, 1000, [3; 16], [4; 16])?;
        assert_eq!(a, tlock::encrypt_with_sigma(&pk, 1000, [3; 16], [4; 16])?);
        assert_ne!(a, tlock::encrypt_with_sigma(&pk, 1001, [3; 16], [4; 16])?);
        Ok(())
    }
}
