use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, ChildStdout};
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

mod native_host;

const TARGET_TRIPLE: &str = env!("TARGET_TRIPLE");

/// Strip the `\\?\` extended-length path prefix that Windows APIs like
/// `canonicalize()` and `current_exe()` produce. Chrome's native messaging
/// launcher doesn't understand this prefix, so we need plain paths.
#[cfg(windows)]
pub(crate) fn strip_win_prefix(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        p
    }
}

/// Show a fatal error to the user. On Windows (where the GUI subsystem hides
/// stderr), this displays a native message box so the error is actually visible.
fn fatal_error(message: &str) -> ! {
    eprintln!("{message}");
    // Write crash log next to the executable
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let _ = std::fs::write(dir.join("crash.log"), message);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        extern "system" {
            fn MessageBoxW(
                hwnd: *mut std::ffi::c_void,
                text: *const u16,
                caption: *const u16,
                utype: u32,
            ) -> i32;
        }
        let wide_msg: Vec<u16> = std::ffi::OsStr::new(message)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let wide_title: Vec<u16> = std::ffi::OsStr::new("JSTorrent")
            .encode_wide()
            .chain(Some(0))
            .collect();
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                wide_msg.as_ptr(),
                wide_title.as_ptr(),
                0x10, // MB_ICONERROR
            );
        }
    }
    std::process::exit(1);
}

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

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct Settings {
    #[serde(default)]
    autostart: bool,
    #[serde(default = "default_true")]
    run_in_background: bool,
}

fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            autostart: false,
            run_in_background: true,
        }
    }
}

fn load_settings(app: &tauri::AppHandle) -> Settings {
    let data_dir = app.path().app_data_dir().expect("no app data directory");
    let path = data_dir.join("settings.json");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(app: &tauri::AppHandle, settings: &Settings) {
    let data_dir = app.path().app_data_dir().expect("no app data directory");
    std::fs::create_dir_all(&data_dir).ok();
    let path = data_dir.join("settings.json");
    if let Ok(json) = serde_json::to_string_pretty(settings) {
        std::fs::write(&path, json).ok();
    }
}

/// Create a host-event JSON value from a deep link URL string or file path.
/// Returns None if the input isn't a recognized deep link type.
fn deep_link_event(url_str: &str) -> Option<serde_json::Value> {
    if url_str.starts_with("magnet:") {
        Some(serde_json::json!({
            "event": "MagnetAdded",
            "payload": { "link": url_str }
        }))
    } else if url_str.to_lowercase().ends_with(".torrent") {
        // Accept both file:// URLs and raw file paths (Windows passes raw paths
        // via command-line args when opening associated .torrent files).
        torrent_file_event(url_str)
    } else {
        None
    }
}

/// Read a .torrent file from a file:// URL or raw path and create a `TorrentAdded` event.
fn torrent_file_event(file_url: &str) -> Option<serde_json::Value> {
    use base64::Engine;

    // Accept both file:// URLs and raw file paths (Windows file associations).
    let path_str = file_url.strip_prefix("file://").unwrap_or(file_url);
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

/// Show, unminimize, and focus the main window.
/// If the window was destroyed (`run_in_background=false`), recreate it.
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    } else {
        let _ = tauri::WebviewWindowBuilder::new(
            app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("JSTorrent")
        .inner_size(1024.0, 700.0)
        .build();
    }
}

/// Resolve sidecar binary path following Tauri's naming convention.
/// Checks multiple locations to handle different installer layouts:
/// - With/without `binaries/` subdirectory
/// - With/without target triple suffix
/// - In both `resource_dir` and exe directory
fn resolve_sidecar(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf));

    // Extract just the filename (e.g. "jstorrent-host" from "binaries/jstorrent-host")
    let basename = std::path::Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(name);

    let mut candidates = Vec::new();
    for dir in [Some(&resource_dir), exe_dir.as_ref()]
        .into_iter()
        .flatten()
    {
        // Standard Tauri: {dir}/{name}-{triple}{ext} (e.g. binaries/jstorrent-host-x86_64-...)
        candidates.push(dir.join(format!("{name}-{TARGET_TRIPLE}{ext}")));
        // Without triple: {dir}/{name}{ext}
        candidates.push(dir.join(format!("{name}{ext}")));
        // Flat with triple: {dir}/{basename}-{triple}{ext}
        candidates.push(dir.join(format!("{basename}-{TARGET_TRIPLE}{ext}")));
        // Flat without triple: {dir}/{basename}{ext}
        candidates.push(dir.join(format!("{basename}{ext}")));
    }

    for candidate in &candidates {
        if candidate.exists() {
            #[cfg(windows)]
            return Ok(strip_win_prefix(candidate.clone()));
            #[cfg(not(windows))]
            return Ok(candidate.clone());
        }
    }

    Err(format!(
        "Sidecar not found. Searched:\n{}",
        candidates
            .iter()
            .map(|c| format!("  {}", c.display()))
            .collect::<Vec<_>>()
            .join("\n")
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
#[allow(clippy::needless_pass_by_value)]
fn get_pending_deep_links(state: tauri::State<'_, DeepLinkState>) -> Vec<serde_json::Value> {
    let mut pending = state
        .pending
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    pending.drain(..).collect()
}

fn format_bytes(bytes: f64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    if bytes >= GB {
        format!("{:.1} GB", bytes / GB)
    } else if bytes >= MB {
        format!("{:.1} MB", bytes / MB)
    } else if bytes >= KB {
        format!("{:.1} KB", bytes / KB)
    } else {
        format!("{bytes:.0} B")
    }
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn update_tray_stats(app: tauri::AppHandle, stats: serde_json::Value) {
    let Some(tray) = app.tray_by_id("tray") else {
        return;
    };

    let download_speed = stats
        .get("downloadSpeed")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0);
    let upload_speed = stats
        .get("uploadSpeed")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0);
    let active_count = stats
        .get("activeCount")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let error_count = stats
        .get("errorCount")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);

    let active = if download_speed > 0.0 || upload_speed > 0.0 || active_count > 0 {
        let mut lines = vec![format!(
            "\u{2193} {}/s  \u{2191} {}/s",
            format_bytes(download_speed),
            format_bytes(upload_speed)
        )];
        if active_count > 0 {
            lines.push(format!("{active_count} active"));
        }
        if error_count > 0 {
            lines.push(format!("{error_count} error"));
        }
        Some(lines.join("\n"))
    } else {
        None
    };

    let tooltip = match &active {
        Some(detail) => format!("JSTorrent\n{detail}"),
        None => "JSTorrent".to_string(),
    };
    let _ = tray.set_tooltip(Some(&tooltip));

    // On macOS, show speed in menu bar next to icon
    #[cfg(target_os = "macos")]
    if download_speed > 0.0 || upload_speed > 0.0 {
        let _ = tray.set_title(Some(&format!(
            "\u{2193} {}/s",
            format_bytes(download_speed)
        )));
    } else {
        let _ = tray.set_title(Some(""));
    }
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn show_notification(app: tauri::AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .show();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Second instance launched (e.g., magnet link clicked on Windows/Linux).
            // Forward any deep link URLs to the running instance.
            for arg in &args {
                if let Some(event) = deep_link_event(arg) {
                    let _ = app.emit("host-event", &event);
                }
            }
            show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_nosleep::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            host_handshake,
            host_message,
            get_pending_deep_links,
            update_tray_stats,
            show_notification,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.app_handle().state::<Mutex<Settings>>();
                if state.lock().unwrap().run_in_background {
                    // Hide window but keep webview alive (downloads continue)
                    let _ = window.hide();
                    api.prevent_close();
                }
                // else: let window destroy (stops downloads), tray stays
            }
        })
        .setup(|app| {
            // Auto-updater
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            // Settings
            let settings = load_settings(app.handle());
            app.manage(Mutex::new(settings.clone()));

            // System tray
            let show_i = MenuItem::with_id(app, "show", "Show App", true, None::<&str>)?;
            let open_ext_i =
                MenuItem::with_id(app, "open-extension", "Open Extension", true, None::<&str>)?;
            let update_i = MenuItem::with_id(
                app,
                "check-updates",
                "Check for Updates",
                true,
                None::<&str>,
            )?;
            let autostart_i = CheckMenuItem::with_id(
                app,
                "autostart",
                "Start at Login",
                true,
                settings.autostart,
                None::<&str>,
            )?;
            let background_i = CheckMenuItem::with_id(
                app,
                "run-in-background",
                "Run in Background",
                true,
                settings.run_in_background,
                None::<&str>,
            )?;
            let settings_menu = SubmenuBuilder::new(app, "Settings")
                .item(&autostart_i)
                .item(&background_i)
                .build()?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &show_i,
                    &open_ext_i,
                    &update_i,
                    &sep1,
                    &settings_menu,
                    &sep2,
                    &quit_i,
                ],
            )?;

            TrayIconBuilder::with_id("tray")
                .tooltip("JSTorrent")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(cfg!(target_os = "macos"))
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        show_main_window(app);
                    }
                    "open-extension" => {
                        let _ = app
                            .opener()
                            .open_url("https://new.jstorrent.com/launch", None::<&str>);
                    }
                    "check-updates" => {
                        show_main_window(app);
                        let _ = app.emit("check-for-updates", ());
                    }
                    "autostart" => {
                        let state = app.state::<Mutex<Settings>>();
                        let mut s = state.lock().unwrap();
                        s.autostart = !s.autostart;
                        if s.autostart {
                            let _ = app.autolaunch().enable();
                        } else {
                            let _ = app.autolaunch().disable();
                        }
                        save_settings(app, &s);
                    }
                    "run-in-background" => {
                        let state = app.state::<Mutex<Settings>>();
                        let mut s = state.lock().unwrap();
                        s.run_in_background = !s.run_in_background;
                        save_settings(app, &s);
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // On macOS, left-click opens the menu (standard menu bar behavior).
                    // On Windows/Linux, left-click shows the window directly.
                    if !cfg!(target_os = "macos") {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main_window(tray.app_handle());
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
                        if let Some(event) = deep_link_event(url.as_ref()) {
                            pending.push(event);
                        }
                    }
                }
            }

            app.manage(deep_link_state);

            // Handle deep links received while the app is already running.
            // On macOS, the OS routes URLs to the running process via this handler.
            // On Windows/Linux, the single-instance plugin (registered above) forwards
            // the second instance's args to this instance and exits the duplicate.
            let deep_link_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if let Some(evt) = deep_link_event(url.as_ref()) {
                        let _ = deep_link_handle.emit("host-event", &evt);
                    }
                }
                show_main_window(&deep_link_handle);
            });

            // Register URL scheme handlers at runtime (Windows/Linux only).
            // macOS uses Info.plist entries generated from tauri.conf.json at build time.
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            app.deep_link().register_all()?;

            // Register native messaging host manifest for all detected browsers
            match native_host::register_native_messaging_hosts(app.handle()) {
                Ok(count) => eprintln!("native-host: registered for {count} browser(s)"),
                Err(e) => eprintln!("native-host: registration failed: {e}"),
            }

            // Spawn system-bridge sidecar
            let host_path = resolve_sidecar(app.handle(), "binaries/jstorrent-host")?;
            eprintln!("Spawning system-bridge: {}", host_path.display());

            let mut cmd = std::process::Command::new(&host_path);
            cmd.arg("--launcher")
                .arg("tauri")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::inherit());
            // Prevent a visible console window for the sidecar on Windows
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            }
            let mut child = cmd
                .spawn()
                .map_err(|e| format!("Failed to spawn system-bridge: {e}"))?;

            let stdin = child.stdin.take().expect("stdin not captured");
            let mut stdout = child.stdout.take().expect("stdout not captured");

            let bridge = Arc::new(HostBridge {
                stdin: Mutex::new(stdin),
                pending: Mutex::new(HashMap::new()),
            });

            app.manage(bridge.clone());

            // Background stdout reader on a dedicated OS thread.
            // When stdout closes (sidecar died, e.g. killed by extension TakeOver),
            // exit the Tauri app so it doesn't linger as a headless window.
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                let _child = child; // Keep child handle alive
                run_stdout_reader(&mut stdout, &bridge, &app_handle);
                eprintln!("system-bridge: sidecar exited, shutting down Tauri app");
                app_handle.exit(0);
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| fatal_error(&format!("Failed to start JSTorrent: {e}")));

    // Keep app alive when all windows are hidden (user closes window -> hide, not exit).
    // Explicit quit via tray menu calls app.exit(0), which sets code = Some(0).
    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            // Keep app alive for tray when windows close.
            // Only app.exit(0) from Quit menu (code=Some(0)) actually exits.
            if code.is_none() {
                api.prevent_exit();
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            show_main_window(app_handle);
        }
        _ => {}
    });
}
