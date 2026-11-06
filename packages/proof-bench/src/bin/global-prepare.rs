//! Generate a fresh private key-preparation witness for a global auction context.
use anyhow::{ensure, Context as _, Result};
use blindfold_proof_bench::prepared::{check_preparation, Context, Prepared};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    ensure!(
        args.len() == 3,
        "usage: global-prepare context.json private-preparation.json"
    );
    let context: Context = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let mut random = File::open("/dev/urandom").context("OS entropy source")?;
    let mut sigma = [0; 16];
    let mut blind = [0; 32];
    random.read_exact(&mut sigma)?;
    random.read_exact(&mut blind)?;
    let prepared = Prepared::new(context, sigma, blind)?;
    check_preparation(&prepared.statement, &prepared.witness)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut output = options.open(&args[2])?;
    serde_json::to_writer(&mut output, &(&prepared.statement, &prepared.witness))?;
    output.write_all(b"\n")?;
    println!("{}", hex::encode(prepared.statement.commitment));
    Ok(())
}
