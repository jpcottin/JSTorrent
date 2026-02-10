use crate::protocol::ResponsePayload;
use crate::state::State;
use anyhow::{anyhow, Result};
use jstorrent_common::DownloadRoot;
#[cfg(not(target_os = "macos"))]
use rfd::AsyncFileDialog;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Determine the best starting directory for the folder picker.
/// Falls back through: most recent download root -> system downloads -> home directory
fn get_starting_directory(state: &State) -> Option<PathBuf> {
    // 1. Try most recently used download root (by last_checked timestamp)
    if let Ok(info_guard) = state.rpc_info.lock() {
        if let Some(ref info) = *info_guard {
            if let Some(ref roots) = info.download_roots {
                if let Some(best) = roots
                    .iter()
                    .filter(|r| r.last_stat_ok)
                    .max_by_key(|r| r.last_checked)
                {
                    let path = PathBuf::from(&best.path);
                    if path.exists() {
                        return Some(path);
                    }
                }
            }
        }
    }

    // 2. Fall back to home directory (avoids TCC permission prompt on macOS)
    // Using Downloads would trigger "would like to access files in your Downloads folder"
    dirs::home_dir()
}

/// macOS: Use osascript to show folder picker (works without `NSApplication`)
#[cfg(target_os = "macos")]
async fn pick_folder_platform(start_dir: Option<PathBuf>) -> Option<PathBuf> {
    let start_path = start_dir.map_or_else(|| "~".to_string(), |p| p.to_string_lossy().to_string());

    let script = format!(
        r#"set defaultFolder to POSIX file "{start_path}"
try
    set chosenFolder to choose folder with prompt "Select Download Directory" default location defaultFolder
    return POSIX path of chosenFolder
on error
    return ""
end try"#
    );

    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
    })
    .await
    .ok()?
    .ok()?;

    if output.status.success() {
        let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !path_str.is_empty() {
            return Some(PathBuf::from(path_str));
        }
    }
    None
}

/// Non-macOS: Use rfd
#[cfg(not(target_os = "macos"))]
async fn pick_folder_platform(start_dir: Option<PathBuf>) -> Option<PathBuf> {
    let mut dialog = AsyncFileDialog::new().set_title("Select Download Directory");

    if let Some(dir) = start_dir {
        dialog = dialog.set_directory(&dir);
    }

    #[cfg(target_os = "windows")]
    crate::win_foreground::prepare_for_foreground();

    let result = dialog.pick_folder().await.map(|h| h.path().to_path_buf());

    #[cfg(target_os = "windows")]
    crate::win_foreground::dismiss_menu();

    result
}

/// Create a `DownloadRoot` from a directory path.
/// Shared by `pick_download_directory` (interactive) and `register_download_root` (external dialog).
fn create_download_root(path: &std::path::Path) -> DownloadRoot {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let path_str = canonical.to_string_lossy().to_string();

    let display_name = path
        .file_name()
        .map_or_else(|| path_str.clone(), |n| n.to_string_lossy().to_string());

    let mut hasher = Sha256::new();
    hasher.update(path_str.as_bytes());
    let hash = hasher.finalize();
    let key = hex::encode(&hash[..8]);

    DownloadRoot {
        key,
        path: path_str,
        display_name,
        removable: false,
        last_stat_ok: true,
        last_checked: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64,
        disk_id: jstorrent_common::get_disk_id(&canonical),
    }
}

/// Add a root to `rpc_info` state, deduplicating by path.
fn add_root_to_state(state: &State, root: &DownloadRoot) {
    if let Ok(mut info_guard) = state.rpc_info.lock() {
        if let Some(ref mut info) = *info_guard {
            let roots = info.download_roots.get_or_insert_with(Vec::new);
            let exists = roots.iter().any(|r| r.path == root.path);
            if !exists {
                roots.push(root.clone());
            }
        }
    }
}

pub async fn pick_download_directory(state: &State) -> Result<ResponsePayload> {
    let start_dir = get_starting_directory(state);
    let path_opt = pick_folder_platform(start_dir).await;

    match path_opt {
        Some(path) => {
            let new_root = create_download_root(&path);
            add_root_to_state(state, &new_root);
            Ok(ResponsePayload::RootAdded { root: new_root })
        }
        None => Err(anyhow!("User cancelled folder selection")),
    }
}

/// Register a download root from an externally-picked path (e.g. Tauri dialog).
pub fn register_download_root(state: &State, path_str: &str) -> Result<ResponsePayload> {
    let path = PathBuf::from(path_str);
    if !path.exists() || !path.is_dir() {
        return Err(anyhow!(
            "Path does not exist or is not a directory: {path_str}"
        ));
    }

    let new_root = create_download_root(&path);
    add_root_to_state(state, &new_root);
    Ok(ResponsePayload::RootAdded { root: new_root })
}
