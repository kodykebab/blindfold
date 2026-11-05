use anyhow::{ensure, Result};
use blindfold_proof_bench::*;
use methods::{ADMISSION_GUEST_ELF, ADMISSION_GUEST_ID};
use risc0_zkvm::{default_executor, default_prover, sha::Digest, ExecutorEnv, ProverOpts, Receipt};
use std::time::Instant;
fn main() -> Result<()> {
    // Force local IPC even when unrelated remote-prover credentials are configured.
    std::env::set_var("RISC0_PROVER", "ipc");
    std::env::set_var("RISC0_EXECUTOR", "ipc");
    std::env::set_var("RISC0_DEV_MODE", "0");
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.as_slice() == ["--reject-invalid"] {
        let (s, w) = sample(1000, true, 100, 0)?;
        let env = ExecutorEnv::builder()
            .write(&(s.clone(), w.clone()))?
            .build()?;
        let control = default_executor().execute(env, ADMISSION_GUEST_ELF)?;
        ensure!(
            serde_json::to_vec(&control.journal.decode::<Statement>()?)? == serde_json::to_vec(&s)?,
            "valid control mismatch"
        );
        for case in 0..4 {
            let mut bad_s = s.clone();
            let mut bad_w = w.clone();
            match case {
                0 => bad_s.round = 0,
                1 => bad_s.budgets = Default::default(),
                2 => bad_s.new_root[0] ^= 1,
                _ => {
                    let last = bad_w.ciphertext.len() - 1;
                    bad_w.ciphertext[last] ^= 1;
                    bad_s.ciphertext_hash = hash(&bad_w.ciphertext);
                }
            }
            let env = ExecutorEnv::builder().write(&(bad_s, bad_w))?.build()?;
            let error = default_executor()
                .execute(env, ADMISSION_GUEST_ELF)
                .expect_err("invalid guest accepted");
            let message = format!("{error:#}");
            ensure!(
                message.contains("Guest panicked") && message.contains("invalid admission"),
                "case {case} failed outside the admission boundary: {message}"
            );
        }
        println!(
            "{}",
            serde_json::json!({"mode":"invalid_guest_execution", "rejected_cases":4})
        );
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("--export") {
        ensure!(
            args.len() == 3,
            "usage: --export groth16.bin admission.json"
        );
        let receipt: Receipt = bincode::deserialize(&std::fs::read(&args[1])?)?;
        receipt.verify(ADMISSION_GUEST_ID)?;
        let statement: Statement = receipt.journal.decode()?;
        let groth16 = receipt.inner.groth16()?;
        // Matches risc0-ethereum contracts/src/lib.rs encode_seal for Groth16.
        // Reject every other receipt type, including development-mode receipts.
        let mut seal = groth16.verifier_parameters.as_bytes()[..4].to_vec();
        seal.extend_from_slice(&groth16.seal);
        let fixture = serde_json::json!({
            "imageId": format!("0x{}", Digest::from(ADMISSION_GUEST_ID)),
            "journal": prefixed_hex(&receipt.journal.bytes),
            "seal": prefixed_hex(&seal),
            "statement": statement,
        });
        std::fs::write(&args[2], serde_json::to_vec_pretty(&fixture)?)?;
        println!(
            "{}",
            serde_json::json!({"mode":"verified_admission_evm_export", "seal_bytes":seal.len(), "journal_bytes":receipt.journal.bytes.len()})
        );
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("--wrap") {
        ensure!(args.len() == 3, "usage: --wrap receipt.bin groth16.bin");
        let receipt: Receipt = bincode::deserialize(&std::fs::read(&args[1])?)?;
        receipt.verify(ADMISSION_GUEST_ID)?;
        let start = Instant::now();
        let wrapped = default_prover().compress(&ProverOpts::groth16(), &receipt)?;
        wrapped.verify(ADMISSION_GUEST_ID)?;
        ensure!(
            wrapped.journal.bytes == receipt.journal.bytes,
            "journal changed"
        );
        std::fs::write(&args[2], bincode::serialize(&wrapped)?)?;
        println!(
            "{}",
            serde_json::json!({"mode":"local_groth16_wrap","elapsed_s":start.elapsed().as_secs_f64(),"seal_bytes":wrapped.seal_size()})
        );
        return Ok(());
    }
    ensure!(
        args.is_empty() || (args.len() == 2 && args[0] == "--prove"),
        "usage: [--prove receipt.bin] or --wrap receipt.bin groth16.bin"
    );
    let (statement, witness) = sample(1000, true, 100, 0)?;
    let env = ExecutorEnv::builder()
        .write(&(statement.clone(), witness))?
        .build()?;
    let start = Instant::now();
    if !args.is_empty() {
        let info = default_prover().prove(env, ADMISSION_GUEST_ELF)?;
        info.receipt.verify(ADMISSION_GUEST_ID)?;
        let decoded: Statement = info.receipt.journal.decode()?;
        ensure!(
            serde_json::to_vec(&decoded)? == serde_json::to_vec(&statement)?,
            "journal mismatch"
        );
        let mut bad = info.receipt.clone();
        bad.journal.bytes[0] ^= 1;
        ensure!(
            bad.verify(ADMISSION_GUEST_ID).is_err(),
            "tampered receipt accepted"
        );
        std::fs::write(&args[1], bincode::serialize(&info.receipt)?)?;
        println!(
            "{}",
            serde_json::json!({"mode":"local_zkvm_proof_not_evm_wrapped","elapsed_s":start.elapsed().as_secs_f64(),"seal_bytes":info.receipt.seal_size()})
        );
    } else {
        let info = default_executor().execute(env, ADMISSION_GUEST_ELF)?;
        let decoded: Statement = info.journal.decode()?;
        ensure!(
            serde_json::to_vec(&decoded)? == serde_json::to_vec(&statement)?,
            "journal mismatch"
        );
        println!(
            "{}",
            serde_json::json!({"mode":"guest_execution_not_proof","elapsed_s":start.elapsed().as_secs_f64(),"cycles":info.cycles()})
        );
    }
    Ok(())
}

fn prefixed_hex(bytes: &[u8]) -> String {
    let mut value = String::with_capacity(2 + bytes.len() * 2);
    value.push_str("0x");
    for byte in bytes {
        use std::fmt::Write;
        write!(&mut value, "{byte:02x}").unwrap();
    }
    value
}
