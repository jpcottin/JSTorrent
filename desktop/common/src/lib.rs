use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RpcInfo {
    pub version: u32,
    #[serde(default)]
    pub add_token: Option<String>,
    pub profiles: Vec<ProfileEntry>,
    #[serde(default)]
    pub desktop_version: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ProfileEntry {
    pub extension_id: Option<String>,
    pub profile_id: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub created: u64,
    #[serde(default)]
    pub client_type: Option<String>,
    #[serde(default)]
    pub client_version: Option<String>,
    pub pid: u32,
    pub port: u16,
    pub token: String,
    pub started: u64,
    pub last_used: u64,
    pub browser: BrowserInfo,
    pub download_roots: Vec<DownloadRoot>,
    #[serde(default)]
    pub launcher: Option<String>,
    #[serde(default)]
    pub desktop_ever_used: bool,
    #[serde(default)]
    pub client_types_used: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DownloadRoot {
    pub key: String,
    pub path: String,
    pub display_name: String,
    pub removable: bool,
    pub last_stat_ok: bool,
    pub last_checked: u64,
    #[serde(default)]
    pub disk_id: String,
}

/// Get a disk identifier for the given path.
/// Returns a string that is the same for all paths on the same physical disk/partition.
#[cfg(unix)]
pub fn get_disk_id(path: &std::path::Path) -> String {
    use std::os::unix::fs::MetadataExt;
    match std::fs::metadata(path) {
        Ok(meta) => format!("{}", meta.dev()),
        Err(_) => String::new(),
    }
}

#[cfg(windows)]
pub fn get_disk_id(path: &std::path::Path) -> String {
    // Use drive letter / mount point as a simple identifier
    path.components()
        .next()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .unwrap_or_default()
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BrowserInfo {
    pub name: String,
    pub binary: String,
    pub extension_id: Option<String>,
}

pub fn get_config_dir() -> Option<PathBuf> {
    // Check environment variable first for testing
    if let Ok(env_dir) = std::env::var("JSTORRENT_CONFIG_DIR") {
        return Some(PathBuf::from(env_dir));
    }

    // Fallback to standard config dir
    dirs::config_dir()
}

/// Get the log directory (~/.config/jstorrent-native/), creating it if needed.
pub fn get_log_dir() -> Option<PathBuf> {
    let dir = get_config_dir()?.join("jstorrent-native");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Read a value from jstorrent-native.env file.
/// Looks in ~/.config/jstorrent-native/jstorrent-native.env
pub fn read_env_value(key: &str) -> Option<String> {
    let env_path = get_config_dir()?
        .join("jstorrent-native")
        .join("jstorrent-native.env");

    if let Ok(content) = std::fs::read_to_string(&env_path) {
        for line in content.lines() {
            let line = line.trim();
            if line.starts_with('#') || line.is_empty() {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                if k.trim() == key {
                    return Some(v.trim().to_string());
                }
            }
        }
    }
    None
}
