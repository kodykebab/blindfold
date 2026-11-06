fn main() {
    let mut options = risc0_build::GuestOptions::default();
    if cfg!(feature = "accelerated") {
        options.features.push("accelerated".into());
    }
    risc0_build::embed_methods_with_options(std::collections::HashMap::from([(
        "admission_guest",
        options,
    )]));
}
