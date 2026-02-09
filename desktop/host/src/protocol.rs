use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;

#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: String,
    #[serde(flatten)]
    pub op: Operation,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Operation {
    // Folder Picker
    PickDownloadDirectory,

    // Delete Download Root
    DeleteDownloadRoot {
        key: String,
    },

    // Handshake
    Handshake {
        #[serde(rename = "extensionId")]
        extension_id: String,
        #[serde(rename = "installId")]
        install_id: String,
    },

    // Take over from Tauri desktop app (fields used in Phase 4)
    #[allow(dead_code)]
    TakeOver {
        #[serde(rename = "extensionId")]
        extension_id: String,
        #[serde(rename = "installId")]
        install_id: String,
    },

    // Open file with default application
    OpenFile {
        #[serde(rename = "rootKey")]
        root_key: String,
        path: String,
    },

    // Reveal file in system file manager
    RevealInFolder {
        #[serde(rename = "rootKey")]
        root_key: String,
        path: String,
    },

    // Update operations
    CheckForUpdates,
    InstallUpdate,

    // KV storage operations
    KvGet {
        key: String,
    },
    KvGetMulti {
        keys: Vec<String>,
    },
    KvSet {
        key: String,
        value: String,
    },
    KvDelete {
        key: String,
    },
    KvKeys {
        prefix: Option<String>,
    },
    KvClear {
        prefix: Option<String>,
    },
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(flatten)]
    pub payload: ResponsePayload,
}

use jstorrent_common::DownloadRoot;

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum ResponsePayload {
    Empty,
    DaemonInfo {
        port: u16,
        token: String,
        version: String,
        roots: Vec<DownloadRoot>,
    },
    Path {
        path: String,
    },
    RootAdded {
        root: DownloadRoot,
    },
    RootRemoved {
        key: String,
    },
    KvValue {
        value: Option<String>,
    },
    KvMultiValue {
        entries: HashMap<String, String>,
    },
    KvKeys {
        keys: Vec<String>,
    },
    DesktopAppRunning {
        tauri_pid: u32,
    },
    UpdateCheck {
        available: bool,
        version: Option<String>,
        #[serde(rename = "currentVersion")]
        current_version: Option<String>,
        body: Option<String>,
    },
}

impl fmt::Display for Operation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Operation::PickDownloadDirectory => write!(f, "PickDownloadDirectory"),
            Operation::DeleteDownloadRoot { key } => write!(f, "DeleteDownloadRoot {key}"),
            Operation::Handshake {
                extension_id,
                install_id,
            } => write!(f, "Handshake ext={extension_id} install={install_id}"),
            Operation::TakeOver {
                extension_id,
                install_id,
            } => write!(f, "TakeOver ext={extension_id} install={install_id}"),
            Operation::OpenFile { root_key, path } => {
                write!(f, "OpenFile {root_key}:{path}")
            }
            Operation::RevealInFolder { root_key, path } => {
                write!(f, "RevealInFolder {root_key}:{path}")
            }
            Operation::CheckForUpdates => write!(f, "CheckForUpdates"),
            Operation::InstallUpdate => write!(f, "InstallUpdate"),
            Operation::KvGet { key } => write!(f, "KvGet {key}"),
            Operation::KvGetMulti { keys } => write!(f, "KvGetMulti [{}]", keys.join(", ")),
            Operation::KvSet { key, value } => write!(f, "KvSet {key} ({} bytes)", value.len()),
            Operation::KvDelete { key } => write!(f, "KvDelete {key}"),
            Operation::KvKeys { prefix } => {
                write!(f, "KvKeys {}", prefix.as_deref().unwrap_or("(all)"))
            }
            Operation::KvClear { prefix } => {
                write!(f, "KvClear {}", prefix.as_deref().unwrap_or("(all)"))
            }
        }
    }
}

impl fmt::Display for ResponsePayload {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ResponsePayload::Empty => write!(f, "Empty"),
            ResponsePayload::DaemonInfo {
                port,
                version,
                roots,
                ..
            } => write!(
                f,
                "DaemonInfo port={port} v={version} roots={}",
                roots.len()
            ),
            ResponsePayload::Path { path } => write!(f, "Path {path}"),
            ResponsePayload::RootAdded { root } => write!(f, "RootAdded {}", root.key),
            ResponsePayload::RootRemoved { key } => write!(f, "RootRemoved {key}"),
            ResponsePayload::KvValue { value } => match value {
                Some(v) => write!(f, "{} bytes", v.len()),
                None => write!(f, "None"),
            },
            ResponsePayload::KvMultiValue { entries } => {
                write!(f, "{} entries", entries.len())
            }
            ResponsePayload::KvKeys { keys } => write!(f, "{} keys", keys.len()),
            ResponsePayload::DesktopAppRunning { tauri_pid } => {
                write!(f, "DesktopAppRunning pid={tauri_pid}")
            }
            ResponsePayload::UpdateCheck {
                available, version, ..
            } => {
                if *available {
                    write!(
                        f,
                        "UpdateCheck available={}",
                        version.as_deref().unwrap_or("?")
                    )
                } else {
                    write!(f, "UpdateCheck up-to-date")
                }
            }
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "event", content = "payload")]
pub enum Event {
    Log {
        message: String,
    },
    MagnetAdded {
        link: String,
    },
    TorrentAdded {
        name: String,
        infohash: String,
        #[serde(rename = "contentsBase64")]
        contents_base64: String,
    },
    UpdateAvailable {
        version: String,
        #[serde(rename = "currentVersion")]
        current_version: String,
    },
}
