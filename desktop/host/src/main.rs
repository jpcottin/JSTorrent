mod daemon_manager;
mod folder_picker;
mod ipc;
mod kv_store;
mod logging;
mod opener;
mod path_safety;
mod protocol;
mod rpc;
mod state;
mod updater;
#[cfg(target_os = "windows")]
mod win_foreground;

use anyhow::Result;
use protocol::{Event, Operation, Request, Response, ResponsePayload};
use state::State;
use std::sync::Arc;
use tokio::io;
use tokio::sync::mpsc;

#[tokio::main]
async fn main() -> Result<()> {
    logging::init("jstorrent-native-host.log");
    log!("Native Host started. PID: {}", std::process::id());

    let mut stdin = io::stdin();
    let mut stdout = io::stdout();

    let (event_tx, mut event_rx) = mpsc::channel(32);

    // --- Parse args early (before State creation) ---
    // Chrome passes chrome-extension://<id>/, Tauri passes --launcher tauri
    let mut extension_id = None;
    let mut launcher = "chrome".to_string();
    {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let mut i = 0;
        while i < args.len() {
            if args[i].starts_with("chrome-extension://") {
                extension_id = args[i]
                    .trim_start_matches("chrome-extension://")
                    .trim_end_matches('/')
                    .to_string()
                    .into();
            } else if args[i] == "--launcher" {
                if let Some(val) = args.get(i + 1) {
                    launcher.clone_from(val);
                    i += 1;
                }
            }
            i += 1;
        }
    }
    log!("Launcher: {}", launcher);

    // Initialize KV store
    let kv = {
        let config_dir = jstorrent_common::get_config_dir()
            .ok_or_else(|| anyhow::anyhow!("Could not determine config directory"))?;
        let db_path = config_dir.join("jstorrent-native").join("data.db");
        log!("Opening KV store at {:?}", db_path);
        kv_store::KvStore::open(&db_path)?
    };

    // Only refresh process info — new_all()/refresh_all() is very slow on Windows
    // (enumerates disks, CPUs, memory, network) and can cause native messaging timeouts.
    let mut system = sysinfo::System::new();
    system.refresh_processes();

    // --- Incumbent detection ---
    let mut blocked_by_tauri: Option<u32> = None;
    {
        let unified = rpc::read_discovery_file();
        for profile in &unified.profiles {
            let incumbent_pid = sysinfo::Pid::from(profile.pid as usize);
            let is_alive = system.process(incumbent_pid).is_some();
            if !is_alive {
                continue;
            }
            // Skip our own PID
            if profile.pid == std::process::id() {
                continue;
            }
            let incumbent_launcher = profile.launcher.as_deref().unwrap_or("chrome");

            match (launcher.as_str(), incumbent_launcher) {
                ("tauri", "chrome") => {
                    // Kill Chrome's native host — its daemon dies via parent-pid monitoring
                    log!(
                        "Tauri startup: killing Chrome native host PID {}",
                        profile.pid
                    );
                    if let Some(proc) = system.process(incumbent_pid) {
                        proc.kill();
                    }
                }
                ("chrome", "tauri") => {
                    // Block — handshake will return error
                    log!("Chrome startup: blocked by Tauri app PID {}", profile.pid);
                    blocked_by_tauri = Some(profile.pid);
                }
                _ => {
                    // Same launcher or unknown — proceed (old one is stale or being replaced)
                }
            }
        }
    }

    // Initialize state with event sender, KV store, launcher identity, blocked flag
    let state = Arc::new(State::new(
        Some(event_tx.clone()),
        kv,
        launcher.clone(),
        blocked_by_tauri,
    ));

    // Start Daemon - DELAYED until Handshake
    let mut daemon_manager = daemon_manager::DaemonManager::new();

    // Start RPC server (used by link-handler for magnet/torrent intake)
    let (port, token) = rpc::start_server(state.clone()).await?;

    // --- Browser detection via process tree ---
    let mut current_pid = sysinfo::Pid::from(std::process::id() as usize);
    let mut browser_binary = String::new();
    let mut browser_name = "Unknown".to_string();

    // Walk up the process tree to find the best candidate
    // Priority:
    // 1. Known browser (Chrome, Firefox, etc.)
    // 2. First parent that is NOT the native host itself (or a wrapper)

    let mut fallback_binary = String::new();
    let mut fallback_name = String::new();

    for _ in 0..10 {
        // Increase depth to 10 just in case
        if let Some(process) = system.process(current_pid) {
            if let Some(parent) = process.parent() {
                current_pid = parent;
                if let Some(parent_proc) = system.process(current_pid) {
                    let name = parent_proc.name().to_lowercase();
                    let exe = parent_proc
                        .exe()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default();

                    // Check if this is likely the host itself or a wrapper
                    let is_host_or_wrapper = name.contains("jstorrent")
                        || name.contains("native-host")
                        || exe.contains("jstorrent")
                        || exe.contains("native-host");

                    if !is_host_or_wrapper {
                        // Check for known browsers
                        if name.contains("chrome")
                            || name.contains("firefox")
                            || name.contains("brave")
                            || name.contains("edge")
                            || name.contains("safari")
                            || name.contains("opera")
                            || name.contains("vivaldi")
                            || name.contains("arc")
                        {
                            browser_binary = exe;
                            browser_name = parent_proc.name().to_string();
                            break;
                        }

                        // If we haven't found a fallback yet, this is our first non-host parent
                        if fallback_binary.is_empty() && !exe.is_empty() {
                            fallback_binary = exe;
                            fallback_name = parent_proc.name().to_string();
                        }
                    }
                }
            } else {
                break;
            }
        } else {
            break;
        }
    }

    // If we didn't find a known browser, use the fallback
    if browser_binary.is_empty() && !fallback_binary.is_empty() {
        browser_binary = fallback_binary;
        browser_name = fallback_name;
    }

    // Write discovery file
    // Note: download_roots is None on startup to preserve existing roots in the file
    let info = rpc::RpcInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        pid: std::process::id(),
        port,
        token,
        started: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        last_used: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        browser: rpc::BrowserInfo {
            name: browser_name,
            binary: browser_binary,
            extension_id: extension_id.clone(),
        },
        download_roots: None, // Don't overwrite existing roots
        install_id: None,
        launcher: Some(launcher),
    };

    // Store info in state so we can update it later (e.g. on handshake)
    if let Ok(mut info_guard) = state.rpc_info.lock() {
        *info_guard = Some(info.clone());
    }

    match rpc::write_discovery_file(info) {
        Ok(mut roots) => {
            // Backfill disk_id for roots migrated from before this field existed
            for root in &mut roots {
                if root.disk_id.is_empty() {
                    root.disk_id = jstorrent_common::get_disk_id(std::path::Path::new(&root.path));
                }
            }
            // Update roots in state from persisted file
            if let Ok(mut info_guard) = state.rpc_info.lock() {
                if let Some(info) = info_guard.as_mut() {
                    info.download_roots = Some(roots);
                }
            }
        }
        Err(e) => log!("Failed to write discovery file: {e}"),
    }

    loop {
        tokio::select! {
            // Handle incoming requests
            msg_res = ipc::read_message(&mut stdin) => {
                match msg_res {
                    Ok(Some(msg_bytes)) => {
                        let req: Request = match serde_json::from_slice(&msg_bytes) {
                            Ok(req) => req,
                            Err(e) => {
                                log!("Failed to parse request: {}", e);
                                continue;
                            }
                        };

                        let op_summary = format!("{}", req.op);

                        let response = handle_request(&state, req, event_tx.clone(), &mut daemon_manager, &mut system).await;
                        log!("{} → {}", op_summary, response.payload);

                        if let Err(e) = ipc::write_message(&mut stdout, &response).await {
                            log!("Failed to write response: {}", e);
                            break;
                        }
                    }
                    Ok(None) => {
                        // EOF
                        log!("Stdin EOF received. Exiting.");
                        break;
                    }
                    Err(e) => {
                        log!("Error reading message: {}", e);
                        break;
                    }
                }
            }

            // Handle outgoing events
            Some(event) = event_rx.recv() => {
                if let Err(e) = ipc::write_message(&mut stdout, &event).await {
                    log!("Failed to write event: {e}");
                    break;
                }
            }

            // Handle shutdown signal
            _ = tokio::signal::ctrl_c() => {
                log!("Received Ctrl-C, shutting down...");
                break;
            }
        }
    }

    // Stop daemon
    daemon_manager.stop();

    log!("Native Host finished.");

    Ok(())
}

/// Shared handshake logic: update discovery file, start daemon, return `DaemonInfo`.
/// Used by both `Handshake` and `TakeOver` handlers.
async fn do_handshake(
    state: &State,
    extension_id: String,
    install_id: String,
    daemon_manager: &mut daemon_manager::DaemonManager,
) -> Result<ResponsePayload, anyhow::Error> {
    // Update extension ID and install ID in state and rewrite discovery file
    let mut success = false;
    if let Ok(mut info_guard) = state.rpc_info.lock() {
        if let Some(info) = info_guard.as_mut() {
            info.browser.extension_id = Some(extension_id);
            info.install_id = Some(install_id.clone());
            // Set to None to preserve existing roots in the file
            info.download_roots = None;
            match crate::rpc::write_discovery_file(info.clone()) {
                Ok(roots) => {
                    info.download_roots = Some(roots);
                    success = true;
                }
                Err(e) => log!("Failed to update discovery file on handshake: {e}"),
            }
        }
    }

    if !success {
        return Err(anyhow::anyhow!(
            "Failed to update extension ID or install ID"
        ));
    }

    let start_result = if daemon_manager.port.is_none() {
        log!("Starting daemon with install_id: {}", install_id);
        daemon_manager.start(&install_id)
    } else {
        let _ = daemon_manager.refresh_config().await;
        Ok(())
    };

    if let Err(e) = start_result {
        log!("Failed to start daemon: {:#}", e);
        return Err(anyhow::anyhow!("Failed to start daemon: {e:#}"));
    }

    log!(
        "Handshake success, checking daemon info: {:?} {:?}",
        daemon_manager.port,
        daemon_manager.token
    );

    if let (Some(port), Some(token)) = (daemon_manager.port, daemon_manager.token.clone()) {
        let roots = state
            .rpc_info
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|info| info.download_roots.clone())
            .unwrap_or_default();

        Ok(ResponsePayload::DaemonInfo {
            port,
            token,
            version: env!("CARGO_PKG_VERSION").to_string(),
            roots,
        })
    } else {
        Err(anyhow::anyhow!("Daemon not running"))
    }
}

async fn handle_request(
    state: &State,
    req: Request,
    event_tx: mpsc::Sender<Event>,
    daemon_manager: &mut daemon_manager::DaemonManager,
    system: &mut sysinfo::System,
) -> Response {
    let result = match req.op {
        Operation::PickDownloadDirectory => {
            let res = folder_picker::pick_download_directory(state).await;
            if res.is_ok() {
                // Persist changes to rpc-info.json
                if let Ok(info_guard) = state.rpc_info.lock() {
                    if let Some(info) = info_guard.as_ref() {
                        if let Err(e) = crate::rpc::write_discovery_file(info.clone()) {
                            log!("Failed to persist rpc-info after adding root: {}", e);
                        }
                    }
                }

                // If successful, refresh daemon config
                if let Err(e) = daemon_manager.refresh_config().await {
                    log!("Failed to refresh daemon config: {}", e);
                }
            }
            res
        }

        Operation::DeleteDownloadRoot { key } => {
            log!("Handling DeleteDownloadRoot for key: {}", key);

            let mut removed = false;
            if let Ok(mut info_guard) = state.rpc_info.lock() {
                if let Some(info) = info_guard.as_mut() {
                    if let Some(roots) = info.download_roots.as_mut() {
                        let len_before = roots.len();
                        roots.retain(|r| r.key != key);
                        removed = roots.len() < len_before;

                        if removed {
                            // Persist to rpc-info.json (Some(...) = explicitly update)
                            if let Err(e) = crate::rpc::write_discovery_file(info.clone()) {
                                log!("Failed to persist rpc-info after removing root: {}", e);
                            }
                        }
                    }
                }
            }

            if removed {
                // Refresh daemon config
                if let Err(e) = daemon_manager.refresh_config().await {
                    log!("Failed to refresh daemon config: {}", e);
                }
                Ok(ResponsePayload::RootRemoved { key })
            } else {
                Err(anyhow::anyhow!("Root not found: {key}"))
            }
        }

        Operation::Handshake {
            extension_id,
            install_id,
        } => {
            // Check if blocked by Tauri
            if let Some(tauri_pid) = *state.blocked_by_tauri.lock().unwrap() {
                log!("Handshake blocked: Tauri app running at PID {}", tauri_pid);
                return Response {
                    id: req.id,
                    ok: false,
                    error: Some("desktop_app_running".to_string()),
                    payload: ResponsePayload::DesktopAppRunning { tauri_pid },
                };
            }

            log!(
                "Handling Handshake for extension_id: {}, install_id: {}",
                extension_id,
                install_id
            );
            let result = do_handshake(state, extension_id, install_id, daemon_manager).await;

            // Trigger background update check for extension-only users (Chrome launcher)
            if result.is_ok() && state.launcher == "chrome" {
                let should_check = {
                    let kv = state.kv.lock().unwrap();
                    updater::should_auto_check(&kv)
                };
                if should_check {
                    let event_tx = event_tx.clone();
                    let kv_state = state.kv.lock().unwrap();
                    updater::record_check_time(&kv_state);
                    drop(kv_state);
                    tokio::spawn(async move {
                        log!("Background update check starting");
                        match updater::run_update_check(false).await {
                            Ok(result) if result.available => {
                                log!(
                                    "Background update check: update available ({})",
                                    result.version.as_deref().unwrap_or("?")
                                );
                                let _ = event_tx
                                    .send(Event::UpdateAvailable {
                                        version: result.version.unwrap_or_default(),
                                        current_version: result.current_version.unwrap_or_default(),
                                    })
                                    .await;
                            }
                            Ok(_) => {
                                log!("Background update check: up to date");
                            }
                            Err(e) => {
                                log!("Background update check failed: {e}");
                            }
                        }
                    });
                }
            }

            result
        }

        Operation::TakeOver {
            extension_id,
            install_id,
        } => {
            log!(
                "Handling TakeOver for extension_id: {}, install_id: {}",
                extension_id,
                install_id
            );

            let tauri_pid = *state.blocked_by_tauri.lock().unwrap();
            if let Some(pid) = tauri_pid {
                // Kill the Tauri native host — its daemon dies via parent-pid monitoring
                system.refresh_processes();
                let sys_pid = sysinfo::Pid::from(pid as usize);
                if let Some(proc) = system.process(sys_pid) {
                    log!("TakeOver: killing Tauri native host PID {}", pid);
                    proc.kill();
                }

                // Clear blocked state
                *state.blocked_by_tauri.lock().unwrap() = None;

                // Wait for daemon to die via parent-pid monitoring
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }

            // Proceed with handshake
            do_handshake(state, extension_id, install_id, daemon_manager).await
        }

        Operation::OpenFile { root_key, path } => {
            log!(
                "Handling OpenFile for root_key: {}, path: {}",
                root_key,
                path
            );

            // Find the root path
            let root_path = state
                .rpc_info
                .lock()
                .ok()
                .and_then(|info| info.as_ref().and_then(|i| i.download_roots.clone()))
                .and_then(|roots| roots.into_iter().find(|r| r.key == root_key))
                .map(|r| r.path);

            match root_path {
                Some(root) => {
                    // Validate path safety and get canonicalized path
                    match path_safety::validate_path(&path, &root) {
                        Ok(safe_path) => opener::open_file(&safe_path)
                            .map(|()| ResponsePayload::Empty)
                            .map_err(|e| anyhow::anyhow!(e)),
                        Err(e) => Err(e),
                    }
                }
                None => Err(anyhow::anyhow!("Root not found: {root_key}")),
            }
        }

        Operation::RevealInFolder { root_key, path } => {
            log!(
                "Handling RevealInFolder for root_key: {}, path: {}",
                root_key,
                path
            );

            // Find the root path
            let root_path = state
                .rpc_info
                .lock()
                .ok()
                .and_then(|info| info.as_ref().and_then(|i| i.download_roots.clone()))
                .and_then(|roots| roots.into_iter().find(|r| r.key == root_key))
                .map(|r| r.path);

            match root_path {
                Some(root) => {
                    // Validate path safety and get canonicalized path
                    match path_safety::validate_path(&path, &root) {
                        Ok(safe_path) => opener::reveal_in_folder(&safe_path)
                            .map(|()| ResponsePayload::Empty)
                            .map_err(|e| anyhow::anyhow!(e)),
                        Err(e) => Err(e),
                    }
                }
                None => Err(anyhow::anyhow!("Root not found: {root_key}")),
            }
        }

        // Update operations
        Operation::CheckForUpdates => {
            // If Tauri app is running, it handles its own updates
            if state.blocked_by_tauri.lock().unwrap().is_some() {
                Ok(ResponsePayload::UpdateCheck {
                    available: false,
                    version: None,
                    current_version: None,
                    body: None,
                })
            } else {
                match updater::run_update_check(false).await {
                    Ok(result) => {
                        if let Some(err) = &result.error {
                            log!("Update check returned error: {err}");
                        }
                        Ok(ResponsePayload::UpdateCheck {
                            available: result.available,
                            version: result.version,
                            current_version: result.current_version,
                            body: result.body,
                        })
                    }
                    Err(e) => Err(e),
                }
            }
        }

        Operation::InstallUpdate => {
            if state.blocked_by_tauri.lock().unwrap().is_some() {
                Err(anyhow::anyhow!(
                    "Desktop app is running and handles updates automatically"
                ))
            } else {
                match updater::run_update_check(true).await {
                    Ok(result) => {
                        if let Some(err) = &result.error {
                            log!("Install update returned error: {err}");
                        }
                        Ok(ResponsePayload::UpdateCheck {
                            available: result.available,
                            version: result.version,
                            current_version: result.current_version,
                            body: result.body,
                        })
                    }
                    Err(e) => Err(e),
                }
            }
        }

        // KV storage operations
        Operation::KvGet { key } => {
            let kv = state.kv.lock().unwrap();
            kv.get(&key).map(|value| ResponsePayload::KvValue { value })
        }

        Operation::KvGetMulti { keys } => {
            let kv = state.kv.lock().unwrap();
            kv.get_multi(&keys)
                .map(|entries| ResponsePayload::KvMultiValue { entries })
        }

        Operation::KvSet { key, value } => {
            let kv = state.kv.lock().unwrap();
            kv.set(&key, &value).map(|()| ResponsePayload::Empty)
        }

        Operation::KvDelete { key } => {
            let kv = state.kv.lock().unwrap();
            kv.delete(&key).map(|()| ResponsePayload::Empty)
        }

        Operation::KvKeys { prefix } => {
            let kv = state.kv.lock().unwrap();
            kv.keys(prefix.as_deref())
                .map(|keys| ResponsePayload::KvKeys { keys })
        }

        Operation::KvClear { prefix } => {
            let kv = state.kv.lock().unwrap();
            kv.clear(prefix.as_deref()).map(|()| ResponsePayload::Empty)
        }
    };

    match result {
        Ok(payload) => Response {
            id: req.id,
            ok: true,
            error: None,
            payload,
        },
        Err(e) => Response {
            id: req.id,
            ok: false,
            error: Some(e.to_string()),
            payload: ResponsePayload::Empty,
        },
    }
}
