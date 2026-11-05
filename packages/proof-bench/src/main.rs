use anyhow::Result;
use blindfold_proof_bench::*;
use std::time::Instant;
fn main() -> Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--matrix") {
        let mut fixtures = Vec::new();
        for (direction, amount, step) in [
            (true, 0, 0),
            (true, 100, 0),
            (false, 100, 1),
            (true, u128::MAX, 63),
        ] {
            let (s, w) = sample(1000, direction, amount, step)?;
            check(&s, &w)?;
            fixtures.push(serde_json::json!({
                "order_hash":hex::encode(s.order_hash), "new_root":hex::encode(s.new_root),
                "round":1000, "chain_hash":CHAIN_HASH, "public_key":PUBLIC_KEY,
                "signature":ROUND_1000_SIGNATURE, "ciphertext":hex::encode(&w.ciphertext),
                "plaintext":hex::encode(plaintext(&s,&w)), "direction":direction,
                "amount":amount.to_string(), "step":step,
            }));
        }
        println!("{}", serde_json::json!({"fixtures":fixtures}));
        return Ok(());
    }
    let (s, w) = sample(1000, true, 100, 0)?;
    check(&s, &w)?;
    let mut timings = Vec::new();
    for _ in 0..20 {
        let start = Instant::now();
        check(&s, &w)?;
        timings.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    println!(
        "{}",
        serde_json::json!({"kind":"native_statement_check_not_zk_proof","samples_ms":timings,"ciphertext_bytes":w.ciphertext.len(),"fixture":{"order_hash":hex::encode(s.order_hash),"new_root":hex::encode(s.new_root),"round":1000,"chain_hash":CHAIN_HASH,"public_key":PUBLIC_KEY,"signature":ROUND_1000_SIGNATURE,"ciphertext":hex::encode(&w.ciphertext),"plaintext":hex::encode(plaintext(&s,&w))}})
    );
    Ok(())
}
