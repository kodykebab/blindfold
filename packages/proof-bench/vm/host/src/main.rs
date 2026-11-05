use anyhow::{ensure, Result};
use blindfold_proof_bench::*;
use methods::{ADMISSION_GUEST_ELF, ADMISSION_GUEST_ID};
use risc0_zkvm::{default_executor, default_prover, ExecutorEnv, ProverOpts, Receipt};
use std::time::Instant;
fn main() -> Result<()> {
    // Force local IPC even when unrelated remote-prover credentials are configured.
    std::env::set_var("RISC0_PROVER", "ipc");
    std::env::set_var("RISC0_EXECUTOR", "ipc");
    std::env::set_var("RISC0_DEV_MODE", "0");
    let args: Vec<String> = std::env::args().skip(1).collect();
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
