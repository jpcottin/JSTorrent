use std::path::Path;

const MANIFEST_NAME: &str = "com.jstorrent.native";
const MANIFEST_FILENAME: &str = "com.jstorrent.native.json";

/// Register native messaging host manifest for all detected Chromium browsers.
/// Returns the number of browsers successfully registered.
pub fn register_native_messaging_hosts(app: &tauri::AppHandle) -> Result<usize, String> {
    let host_path = super::resolve_sidecar(app, "binaries/jstorrent-host")?;

    let manifest = serde_json::json!({
        "name": MANIFEST_NAME,
        "description": "JSTorrent Native Messaging Host",
        "path": host_path.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": [
            "chrome-extension://dbokmlpefliilbjldladbimlcfgbolhk/",
            "chrome-extension://opkmhecbhgngcbglpcdfmnomkffenapc/"
        ]
    });
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;

    let mut count = 0;

    #[cfg(target_os = "macos")]
    {
        count += register_macos_browsers(&manifest_bytes);
    }

    #[cfg(target_os = "linux")]
    {
        count += register_linux_browsers(&manifest_bytes);
    }

    #[cfg(target_os = "windows")]
    {
        count += register_windows_browsers(app, &manifest_bytes)?;
    }

    Ok(count)
}

/// Write manifest to a browser's `NativeMessagingHosts` directory.
/// Only writes if the browser's parent config directory already exists
/// (i.e., the browser is installed).
fn write_manifest_for_browser(browser_config_dir: &Path, manifest_bytes: &[u8]) -> bool {
    if !browser_config_dir.exists() {
        return false;
    }
    let hosts_dir = browser_config_dir.join("NativeMessagingHosts");
    if std::fs::create_dir_all(&hosts_dir).is_err() {
        eprintln!("native-host: failed to create {}", hosts_dir.display());
        return false;
    }
    let manifest_path = hosts_dir.join(MANIFEST_FILENAME);
    match std::fs::write(&manifest_path, manifest_bytes) {
        Ok(()) => {
            eprintln!("native-host: registered {}", manifest_path.display());
            true
        }
        Err(e) => {
            eprintln!(
                "native-host: failed to write {}: {e}",
                manifest_path.display()
            );
            false
        }
    }
}

#[cfg(target_os = "macos")]
fn register_macos_browsers(manifest_bytes: &[u8]) -> usize {
    let Some(home) = dirs::home_dir() else {
        eprintln!("native-host: could not determine home directory");
        return 0;
    };
    let app_support = home.join("Library/Application Support");
    let browsers = [
        "Google/Chrome",
        "Google/Chrome Canary",
        "Chromium",
        "BraveSoftware/Brave-Browser",
        "Microsoft Edge",
        "Vivaldi",
        "Arc/User Data",
    ];
    browsers
        .iter()
        .filter(|b| write_manifest_for_browser(&app_support.join(b), manifest_bytes))
        .count()
}

#[cfg(target_os = "linux")]
fn register_linux_browsers(manifest_bytes: &[u8]) -> usize {
    let Some(home) = dirs::home_dir() else {
        eprintln!("native-host: could not determine home directory");
        return 0;
    };
    let browsers = [
        ".config/google-chrome",
        ".config/chromium",
        ".config/BraveSoftware/Brave-Browser",
        ".config/microsoft-edge",
    ];
    browsers
        .iter()
        .filter(|b| write_manifest_for_browser(&home.join(b), manifest_bytes))
        .count()
}

#[cfg(target_os = "windows")]
fn register_windows_browsers(
    app: &tauri::AppHandle,
    manifest_bytes: &[u8],
) -> Result<usize, String> {
    use tauri::Manager;
    use winreg::enums::*;
    use winreg::RegKey;

    // Write manifest file to Tauri's app data directory
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&app_data).map_err(|e| e.to_string())?;
    let manifest_path = app_data.join(MANIFEST_FILENAME);
    std::fs::write(&manifest_path, manifest_bytes).map_err(|e| e.to_string())?;
    let manifest_path_str = manifest_path.to_string_lossy().to_string();

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let registry_keys = [
        format!("Software\\Google\\Chrome\\NativeMessagingHosts\\{MANIFEST_NAME}"),
        format!("Software\\Chromium\\NativeMessagingHosts\\{MANIFEST_NAME}"),
        format!("Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\{MANIFEST_NAME}"),
        format!("Software\\Microsoft\\Edge\\NativeMessagingHosts\\{MANIFEST_NAME}"),
    ];

    let mut count = 0;
    for subkey in &registry_keys {
        match hkcu.create_subkey(subkey) {
            Ok((key, _)) => match key.set_value("", &manifest_path_str) {
                Ok(()) => {
                    eprintln!("native-host: registered HKCU\\{subkey}");
                    count += 1;
                }
                Err(e) => eprintln!("native-host: failed to set HKCU\\{subkey}: {e}"),
            },
            Err(e) => eprintln!("native-host: failed to create HKCU\\{subkey}: {e}"),
        }
    }

    Ok(count)
}
