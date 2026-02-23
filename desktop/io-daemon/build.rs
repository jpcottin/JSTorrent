fn main() {
    #[cfg(windows)]
    {
        let mut res = winres::WindowsResource::new();
        res.set_icon("../tauri-app/src-tauri/icons/icon.ico");
        res.set("ProductName", "JSTorrent IO");
        res.set("FileDescription", "JSTorrent IO");
        res.set("CompanyName", "JSTorrent");
        res.set("LegalCopyright", "JSTorrent");
        res.compile().unwrap();
    }
}
