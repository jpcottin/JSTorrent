fn main() {
    tauri_build::build();
    // Expose the Rust target triple for sidecar binary path resolution
    println!(
        "cargo:rustc-env=TARGET_TRIPLE={}",
        std::env::var("TARGET").unwrap()
    );
}
