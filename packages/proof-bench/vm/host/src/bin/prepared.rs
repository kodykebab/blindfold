use anyhow::{ensure, Result};
use blindfold_proof_bench::{prepared::*, *};
use methods::{ONLINE_ELF, ONLINE_ID, PREPARATION_ELF, PREPARATION_ID};
use risc0_zkvm::{default_executor, default_prover, sha::Digest, ExecutorEnv, ProverOpts, Receipt};
use std::{fs, time::Instant};
type Fixture = (Preparation, PreparationWitness, Online, OnlineWitness);
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn main() -> Result<()> {
    std::env::set_var("RISC0_PROVER", "ipc");
    std::env::set_var("RISC0_EXECUTOR", "ipc");
    std::env::set_var("RISC0_DEV_MODE", "0");
    let args: Vec<_> = std::env::args().skip(1).collect();
    ensure!(!args.is_empty(), "fixture path | execute/reject/prove phase fixture [receipt] | wrap/export phase receipt output");
    if args[0] == "fixture" {
        ensure!(args.len() == 2, "fixture path");
        let fixture = sample_pair(true, 100, 0)?;
        check_pair(&fixture.0, &fixture.1, &fixture.2, &fixture.3)?;
        fs::write(&args[1], serde_json::to_vec_pretty(&fixture)?)?;
        let s = &fixture.2.admission;
        let w = &fixture.3.order;
        println!(
            "{}",
            serde_json::json!({"kind":"synthetic_prepared_fixture", "fixture":{
            "order_hash":hex(&s.order_hash), "new_root":hex(&s.new_root), "round":s.round,
            "chain_hash":CHAIN_HASH,"public_key":PUBLIC_KEY,"signature":ROUND_1000_SIGNATURE,
            "ciphertext":hex(&w.ciphertext),"plaintext":hex(&plaintext(s,w))}})
        );
        return Ok(());
    }
    ensure!(args.len() >= 3, "missing phase/input");
    let (elf, id) = match args[1].as_str() {
        "online" => (ONLINE_ELF, ONLINE_ID),
        "preparation" => (PREPARATION_ELF, PREPARATION_ID),
        _ => anyhow::bail!("unknown phase"),
    };
    let start = Instant::now();
    if args[0] == "wrap" || args[0] == "export" {
        ensure!(args.len() == 4, "wrap/export phase input output");
        let receipt: Receipt = bincode::deserialize(&fs::read(&args[2])?)?;
        receipt.verify(id)?;
        if args[0] == "wrap" {
            let wrapped = default_prover().compress(&ProverOpts::groth16(), &receipt)?;
            wrapped.verify(id)?;
            ensure!(
                wrapped.journal.bytes == receipt.journal.bytes,
                "journal changed"
            );
            fs::write(&args[3], bincode::serialize(&wrapped)?)?;
            println!(
                "{}",
                serde_json::json!({"mode":"local_groth16_wrap","phase":args[1],"elapsed_s":start.elapsed().as_secs_f64(),"seal_bytes":wrapped.seal_size()})
            );
        } else {
            let g = receipt.inner.groth16()?;
            let mut seal = g.verifier_parameters.as_bytes()[..4].to_vec();
            seal.extend(&g.seal);
            fs::write(
                &args[3],
                serde_json::to_vec_pretty(
                    &serde_json::json!({"imageId":format!("0x{}",Digest::from(id)),"journal":format!("0x{}",hex(&receipt.journal.bytes)),"seal":format!("0x{}",hex(&seal))}),
                )?,
            )?;
            println!("verified {} export", args[1]);
        }
        return Ok(());
    }
    let (p, pw, o, ow): Fixture = serde_json::from_slice(&fs::read(&args[2])?)?;
    if args[0] == "reject" {
        let control = if args[1] == "online" {
            ExecutorEnv::builder()
                .write(&(o.clone(), ow.clone()))?
                .build()?
        } else {
            ExecutorEnv::builder()
                .write(&(p.clone(), pw.clone()))?
                .build()?
        };
        default_executor().execute(control, elf)?;
        for case in 0..5 {
            let env = if args[1] == "online" {
                let mut s = o.clone();
                let mut w = ow.clone();
                match case {
                    0 => s.commitment[0] ^= 1,
                    1 => s.admission.budgets = Default::default(),
                    2 => s.admission.old_root[0] ^= 1,
                    3 => {
                        let last = w.order.ciphertext.len() - 1;
                        w.order.ciphertext[last] ^= 1;
                        s.admission.ciphertext_hash = hash(&w.order.ciphertext);
                    }
                    _ => s.admission.owner[0] ^= 1,
                }
                ExecutorEnv::builder().write(&(s, w))?.build()?
            } else {
                let mut s = p.clone();
                let mut w = pw.clone();
                match case {
                    0 => s.commitment[0] ^= 1,
                    1 => w.sigma[0] ^= 1,
                    2 => s.context.round += 1,
                    3 => w.wrapper[0] ^= 1,
                    _ => w.key[0] ^= 1,
                }
                ExecutorEnv::builder().write(&(s, w))?.build()?
            };
            let e = default_executor()
                .execute(env, elf)
                .expect_err("invalid guest accepted");
            let message = format!("{e:#}");
            ensure!(
                message.contains("Guest panicked")
                    && message.contains(if args[1] == "online" {
                        "invalid online admission"
                    } else {
                        "invalid preparation"
                    }),
                "infrastructure failure: {message}"
            );
        }
        println!(
            "{}",
            serde_json::json!({"mode":"guest_rejection","phase":args[1],"cases":5})
        );
        return Ok(());
    }
    let expected = if args[1] == "online" {
        online_journal(&o)
    } else {
        preparation_journal(&p)
    };
    let env = if args[1] == "online" {
        ExecutorEnv::builder().write(&(o, ow))?.build()?
    } else {
        ExecutorEnv::builder().write(&(p, pw))?.build()?
    };
    let start = Instant::now();
    match args[0].as_str() {
        "execute" => {
            let info = default_executor().execute(env, elf)?;
            ensure!(info.journal.bytes == expected, "journal mismatch");
            println!(
                "{}",
                serde_json::json!({"mode":"guest_execution_not_proof","phase":args[1],"cycles":info.cycles(),"elapsed_s":start.elapsed().as_secs_f64(),"image_id":format!("{}",Digest::from(id))})
            );
        }
        "prove" => {
            ensure!(args.len() == 4, "prove phase fixture receipt");
            let info = default_prover().prove(env, elf)?;
            info.receipt.verify(id)?;
            ensure!(info.receipt.journal.bytes == expected, "journal mismatch");
            let mut bad = info.receipt.clone();
            bad.journal.bytes[0] ^= 1;
            ensure!(bad.verify(id).is_err(), "modified journal accepted");
            fs::write(&args[3], bincode::serialize(&info.receipt)?)?;
            println!(
                "{}",
                serde_json::json!({"mode":"local_proof_not_evm_wrapped","phase":args[1],"elapsed_s":start.elapsed().as_secs_f64(),"seal_bytes":info.receipt.seal_size(),"image_id":format!("{}",Digest::from(id))})
            );
        }
        _ => anyhow::bail!("unknown command"),
    }
    Ok(())
}
