//! Standard quicknet key wrapping using RISC Zero's accelerated curve backend.
//! The byte relation is tested against pinned tlock-rs, which remains the fixture generator.
use anyhow::{ensure, Result};
use bls12_381::{
    hash_to_curve::{ExpandMsgXmd, HashToCurve},
    pairing, G1Affine, G1Projective, G2Affine, G2Projective, Scalar,
};
use sha2_09::{Digest, Sha256};

pub fn wrap(round: u64, key: [u8; 16], sigma: [u8; 16]) -> Result<Vec<u8>> {
    ensure!(round != 0, "zero round");
    let pk: [u8; 96] = hex::decode(crate::PUBLIC_KEY)?.try_into().unwrap();
    let master = Option::<G2Affine>::from(G2Affine::from_compressed(&pk))
        .ok_or_else(|| anyhow::anyhow!("invalid public key"))?;
    let id = Sha256::digest(&round.to_be_bytes());
    let q = <G1Projective as HashToCurve<ExpandMsgXmd<Sha256>>>::hash_to_curve(
        &id,
        b"BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_",
    );
    let gid = pairing(&G1Affine::from(q), &master);
    let digest = Sha256::new()
        .chain(b"IBE-H3")
        .chain(&sigma)
        .chain(&key)
        .finalize();
    let mut scalar = None;
    for i in 1..u16::MAX {
        let mut candidate: [u8; 32] = Sha256::new()
            .chain(&i.to_le_bytes())
            .chain(&digest)
            .finalize()
            .into();
        candidate[0] >>= 1;
        candidate.reverse();
        scalar = Option::<Scalar>::from(Scalar::from_bytes(&candidate));
        if scalar.is_some() {
            break;
        }
    }
    let r = scalar.ok_or_else(|| anyhow::anyhow!("scalar derivation exhausted"))?;
    let u = G2Affine::from(G2Projective::generator() * r).to_compressed();
    let shared = (gid * r).to_tlock_bytes();
    let h2 = Sha256::new().chain(b"IBE-H2").chain(&shared).finalize();
    let h4 = Sha256::new().chain(b"IBE-H4").chain(&sigma).finalize();
    let mut out = u.to_vec();
    out.extend((0..16).map(|i| sigma[i] ^ h2[i]));
    out.extend((0..16).map(|i| key[i] ^ h4[i]));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wrapper_matches_standard_backend() -> Result<()> {
        let pk = hex::decode(crate::PUBLIC_KEY)?;
        for i in 0u64..64 {
            let key: [u8; 16] = Sha256::digest(&i.to_le_bytes())[..16].try_into().unwrap();
            let sigma: [u8; 16] = Sha256::digest(&(i + 100).to_le_bytes())[..16]
                .try_into()
                .unwrap();
            let round = [1, 1000, 10_000_000, u64::MAX][(i % 4) as usize];
            assert_eq!(
                wrap(round, key, sigma)?,
                tlock::encrypt_with_sigma(&pk, round, key, sigma)?,
                "case {i}"
            );
        }
        Ok(())
    }
}
