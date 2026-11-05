use blindfold_proof_bench::{check, Statement, Witness};
use risc0_zkvm::guest::env;
fn main() {
    let (statement, witness): (Statement, Witness) = env::read();
    check(&statement, &witness).expect("invalid admission");
    env::commit(&statement);
}
