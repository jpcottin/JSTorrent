fn main() {
    // Expose the Rust target triple for sidecar binary path resolution
    println!(
        "cargo:rustc-env=TARGET_TRIPLE={}",
        std::env::var("TARGET").unwrap()
    );

    #[cfg(windows)]
    {
        let mut res = winres::WindowsResource::new();
        res.set_icon("../tauri-app/src-tauri/icons/icon.ico");
        res.set("ProductName", "JSTorrent Native Host");
        res.set("FileDescription", "JSTorrent Native Host");
        res.set("CompanyName", "JSTorrent");
        res.set("LegalCopyright", "JSTorrent");
        res.compile().unwrap();
    }
}
