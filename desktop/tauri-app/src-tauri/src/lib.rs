use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, ChildStdout};
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tokio::sync::oneshot;

const TARGET_TRIPLE: &str = env!("TARGET_TRIPLE");

struct HostBridge {
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>,
}

impl HostBridge {
    /// Write a length-prefixed JSON message to system-bridge stdin.
    fn send(&self, message: &serde_json::Value) -> Result<(), String> {
        let json = serde_json::to_vec(message).map_err(|e| e.to_string())?;
        let len = (json.len() as u32).to_le_bytes();
        let mut stdin = self.stdin.lock().map_err(|e| e.to_string())?;
        stdin.write_all(&len).map_err(|e| e.to_string())?;
        stdin.write_all(&json).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Send a request and wait for the matching response.
    async fn request(&self, mut message: serde_json::Value) -> Result<serde_json::Value, String> {
        let id = uuid::Uuid::new_v4().to_string();
        message
            .as_object_mut()
            .ok_or("message must be a JSON object")?
            .insert("id".into(), serde_json::Value::String(id.clone()));

        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().map_err(|e| e.to_string())?;
            pending.insert(id.clone(), tx);
        }

        if let Err(e) = self.send(&message) {
            let mut pending = self.pending.lock().map_err(|e| e.to_string())?;
            pending.remove(&id);
            return Err(e);
        }

        rx.await.map_err(|_| "Response channel closed".to_string())
    }
}

/// Pending deep link events that arrived before the frontend was ready.
struct DeepLinkState {
    pending: Mutex<Vec<serde_json::Value>>,
}

/// Create a host-event JSON value from a deep link URL string.
/// Returns None if the URL isn't a recognized deep link type.
fn deep_link_event(url_str: &str) -> Option<serde_json::Value> {
    if url_str.starts_with("magnet:") {
        Some(serde_json::json!({
            "event": "MagnetAdded",
            "payload": { "link": url_str }
        }))
    } else if url_str.starts_with("file://") && url_str.to_lowercase().ends_with(".torrent") {
        torrent_file_event(url_str)
    } else {
        None
    }
}

/// Read a .torrent file from a file:// URL and create a TorrentAdded event.
fn torrent_file_event(file_url: &str) -> Option<serde_json::Value> {
    use base64::Engine;

    // Parse file:// URL to a path. On Unix, file:///path → /path
    let path_str = file_url.strip_prefix("file://")?;
    let path = std::path::Path::new(path_str);

    let contents = std::fs::read(path).ok()?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&contents);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    Some(serde_json::json!({
        "event": "TorrentAdded",
        "payload": {
            "name": name,
            "contentsBase64": encoded
        }
    }))
}

/// Resolve sidecar binary path following Tauri's naming convention.
fn resolve_sidecar(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;

    // Standard Tauri sidecar naming: {name}-{triple}{ext}
    let with_triple = resource_dir.join(format!("{name}-{TARGET_TRIPLE}{ext}"));
    if with_triple.exists() {
        return Ok(with_triple);
    }

    // Fallback without triple (dev mode)
    let without_triple = resource_dir.join(format!("{name}{ext}"));
    if without_triple.exists() {
        return Ok(without_triple);
    }

    Err(format!(
        "Sidecar not found: {} or {}",
        with_triple.display(),
        without_triple.display()
    ))
}

/// Get or create a persistent install ID in the app data directory.
fn get_or_create_install_id(app: &tauri::AppHandle) -> String {
    let data_dir = app.path().app_data_dir().expect("no app data directory");
    std::fs::create_dir_all(&data_dir).ok();
    let path = data_dir.join("install-id");

    if let Ok(id) = std::fs::read_to_string(&path) {
        let id = id.trim().to_string();
        if !id.is_empty() {
            return id;
        }
    }

    let id = uuid::Uuid::new_v4().to_string();
    std::fs::write(&path, &id).ok();
    id
}

/// Read native messaging frames from system-bridge stdout and dispatch them.
fn run_stdout_reader(stdout: &mut ChildStdout, bridge: &HostBridge, app_handle: &tauri::AppHandle) {
    let mut len_buf = [0u8; 4];

    loop {
        if stdout.read_exact(&mut len_buf).is_err() {
            eprintln!("system-bridge: stdout closed");
            break;
        }
        let len = u32::from_le_bytes(len_buf) as usize;
        let mut buf = vec![0u8; len];
        if stdout.read_exact(&mut buf).is_err() {
            eprintln!("system-bridge: read error");
            break;
        }

        let msg: serde_json::Value = match serde_json::from_slice(&buf) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("system-bridge: invalid JSON: {e}");
                continue;
            }
        };

        // Dispatch: response (has "id") vs event (has "event")
        if let Some(id) = msg.get("id").and_then(|v| v.as_str()) {
            if let Ok(mut pending) = bridge.pending.lock() {
                if let Some(tx) = pending.remove(id) {
                    let _ = tx.send(msg);
                }
            }
        } else if msg.get("event").is_some() {
            let _ = app_handle.emit("host-event", &msg);
        }
    }

    // Clean up pending requests on disconnect
    if let Ok(mut pending) = bridge.pending.lock() {
        pending.clear();
    }
}

#[tauri::command]
async fn host_handshake(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<HostBridge>>,
) -> Result<serde_json::Value, String> {
    let install_id = get_or_create_install_id(&app);
    state
        .request(serde_json::json!({
            "op": "handshake",
            "extensionId": "tauri-desktop",
            "installId": install_id,
        }))
        .await
}

#[tauri::command]
async fn host_message(
    state: tauri::State<'_, Arc<HostBridge>>,
    message: serde_json::Value,
) -> Result<serde_json::Value, String> {
    state.request(message).await
}

/// Return and clear any deep link events that arrived before the frontend was ready.
#[tauri::command]
fn get_pending_deep_links(state: tauri::State<'_, DeepLinkState>) -> Vec<serde_json::Value> {
    let mut pending = state.pending.lock().unwrap_or_else(|e| e.into_inner());
    pending.drain(..).collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            host_handshake,
            host_message,
            get_pending_deep_links,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .setup(|app| {
            // System tray
            let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            TrayIconBuilder::with_id("tray")
                .tooltip("JSTorrent")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Deep links
            let deep_link_state = DeepLinkState {
                pending: Mutex::new(Vec::new()),
            };

            // Collect any URLs that launched the app (startup deep links).
            // These are stored as pending events for the frontend to retrieve
            // after it connects (via get_pending_deep_links command).
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                if let Ok(mut pending) = deep_link_state.pending.lock() {
                    for url in urls {
                        if let Some(event) = deep_link_event(&url.to_string()) {
                            pending.push(event);
                        }
                    }
                }
            }

            app.manage(deep_link_state);

            // Handle deep links received while the app is already running (macOS).
            // On Windows/Linux, a new process is spawned instead — handled via get_current() above
            // combined with single-instance plugin (future enhancement).
            let deep_link_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if let Some(evt) = deep_link_event(&url.to_string()) {
                        let _ = deep_link_handle.emit("host-event", &evt);
                    }
                }
                // Show the main window when a deep link arrives
                if let Some(window) = deep_link_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            });

            // Register URL scheme handlers at runtime (Windows/Linux only).
            // macOS uses Info.plist entries generated from tauri.conf.json at build time.
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            app.deep_link().register_all()?;

            // Spawn system-bridge sidecar
            let host_path = resolve_sidecar(app.handle(), "binaries/jstorrent-host")?;
            eprintln!("Spawning system-bridge: {}", host_path.display());

            let mut child = std::process::Command::new(&host_path)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::inherit())
                .spawn()
                .map_err(|e| format!("Failed to spawn system-bridge: {e}"))?;

            let stdin = child.stdin.take().expect("stdin not captured");
            let mut stdout = child.stdout.take().expect("stdout not captured");

            let bridge = Arc::new(HostBridge {
                stdin: Mutex::new(stdin),
                pending: Mutex::new(HashMap::new()),
            });

            app.manage(bridge.clone());

            // Background stdout reader on a dedicated OS thread
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                let _child = child; // Keep child handle alive
                run_stdout_reader(&mut stdout, &bridge, &app_handle);
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Keep app alive when all windows are hidden (user closes window -> hide, not exit).
    // Explicit quit via tray menu calls app.exit(0), which sets code = Some(0).
    app.run(|_app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}
