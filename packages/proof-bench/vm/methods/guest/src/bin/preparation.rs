use blindfold_proof_bench::prepared::{
    check_preparation, preparation_journal, Preparation, PreparationWitness,
};
use risc0_zkvm::guest::env;
fn main() {
    let (s, w): (Preparation, PreparationWitness) = env::read();
    check_preparation(&s, &w).expect("invalid preparation");
    env::commit_slice(&preparation_journal(&s));
}
