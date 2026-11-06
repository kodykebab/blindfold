use blindfold_proof_bench::prepared::{check_online, online_journal, Online, OnlineWitness};
use risc0_zkvm::guest::env;
fn main() {
    let (s, w): (Online, OnlineWitness) = env::read();
    check_online(&s, &w).expect("invalid online admission");
    env::commit_slice(&online_journal(&s));
}
