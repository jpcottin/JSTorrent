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

    // --- Parse args early ---
    let mut launcher = "chrome".to_string();
    {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let mut i = 0;
        while i < args.len() {
            if args[i] == "--launcher" {
                if let Some(val) = args.get(i + 1) {
                    launcher.clone_from(val);
                    i += 1;
                }
            }
            i += 1;
        }
    }
    log!("Launcher: {}", launcher);

    // KV store is deferred until handshake (per-profile path)
    // No incumbent detection at startup — profile locking happens at handshake time

    // Initialize state (no kv, no blocked_by_tauri)
    let state = Arc::new(State::new(Some(event_tx.clone()), launcher.clone()));

    // Start Daemon - DELAYED until Handshake
    let mut daemon_manager = daemon_manager::DaemonManager::new();

    // Start RPC server
    let (port, token) = rpc::start_server(state.clone()).await?;

    // Only refresh process info
    let mut system = sysinfo::System::new();
    system.refresh_processes();

    // --- Browser detection via process tree ---
    let mut current_pid = sysinfo::Pid::from(std::process::id() as usize);
    let mut browser_binary = String::new();
    let mut browser_name = "Unknown".to_string();

    let mut fallback_binary = String::new();
    let mut fallback_name = String::new();

    for _ in 0..10 {
        if let Some(process) = system.process(current_pid) {
            if let Some(parent) = process.parent() {
                current_pid = parent;
                if let Some(parent_proc) = system.process(current_pid) {
                    let name = parent_proc.name().to_lowercase();
                    let exe = parent_proc
                        .exe()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default();

                    let is_host_or_wrapper = name.contains("jstorrent")
                        || name.contains("native-host")
                        || exe.contains("jstorrent")
                        || exe.contains("native-host");

                    if !is_host_or_wrapper {
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

    if browser_binary.is_empty() && !fallback_binary.is_empty() {
        browser_binary = fallback_binary;
        browser_name = fallback_name;
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    // Store startup info in state — rpc-info.json is NOT written until handshake
    let info = rpc::RpcWriteInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        pid: std::process::id(),
        port,
        token,
        started: now,
        last_used: now,
        browser: rpc::BrowserInfo {
            name: browser_name,
            binary: browser_binary,
            extension_id: None,
        },
        download_roots: None,
        profile_id: String::new(),
        display_name: String::new(),
        created: now,
        client_type: None,
        client_version: None,
        launcher: Some(launcher),
        client_types_used: Vec::new(),
    };

    if let Ok(mut info_guard) = state.rpc_info.lock() {
        *info_guard = Some(info);
    }

    loop {
        tokio::select! {
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
                        log!("Stdin EOF received. Exiting.");
                        break;
                    }
                    Err(e) => {
                        log!("Error reading message: {}", e);
                        break;
                    }
                }
            }

            Some(event) = event_rx.recv() => {
                if let Err(e) = ipc::write_message(&mut stdout, &event).await {
                    log!("Failed to write event: {e}");
                    break;
                }
            }

            _ = tokio::signal::ctrl_c() => {
                log!("Received Ctrl-C, shutting down...");
                break;
            }
        }
    }

    daemon_manager.stop();

    log!("Native Host finished.");

    Ok(())
}

/// Shared handshake logic: resolve profile, check liveness, update discovery file,
/// open per-profile KV, start daemon, return `DaemonInfo`.
async fn do_handshake(
    state: &State,
    extension_id: String,
    profile_id: Option<String>,
    client_type: Option<String>,
    client_version: Option<String>,
    daemon_manager: &mut daemon_manager::DaemonManager,
    system: &mut sysinfo::System,
) -> Result<ResponsePayload, anyhow::Error> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    // 1. Read rpc-info.json fresh from disk
    let unified = rpc::read_discovery_file();

    // 2. Resolve profile
    let (resolved_profile_id, display_name, created) = if let Some(ref pid) = profile_id {
        // Explicit profile_id: must find it
        let profile = unified.profiles.iter().find(|p| &p.profile_id == pid);
        match profile {
            Some(p) => (p.profile_id.clone(), p.display_name.clone(), p.created),
            None => {
                return Err(anyhow::anyhow!(
                    "Invalid profile ID: {pid}. Profile not found."
                ));
            }
        }
    } else {
        // No profile_id → create new profile
        let new_id = uuid::Uuid::new_v4().to_string();
        let count = unified.profiles.len() + 1;
        let name = format!("Profile {count}");
        (new_id, name, now)
    };

    // 3. Check incumbent liveness (if profile exists and has a different PID)
    if let Some(incumbent) = unified
        .profiles
        .iter()
        .find(|p| p.profile_id == resolved_profile_id)
    {
        if incumbent.pid != std::process::id() && incumbent.pid != 0 {
            // Check if the incumbent's process is alive via sysinfo first
            system.refresh_processes();
            let incumbent_pid = sysinfo::Pid::from(incumbent.pid as usize);
            let process_alive = system.process(incumbent_pid).is_some();

            if process_alive {
                // Check if the daemon is responsive
                let is_alive = rpc::check_profile_liveness(incumbent.port, &incumbent.token).await;
                if is_alive {
                    return Ok(ResponsePayload::ProfileInUse {
                        profile_id: resolved_profile_id,
                        client_type: incumbent.client_type.clone(),
                        client_version: incumbent.client_version.clone(),
                        browser_name: Some(incumbent.browser.name.clone()),
                        pid: incumbent.pid,
                        started: incumbent.started,
                    });
                }
                log!(
                    "Incumbent PID {} for profile {} is alive but daemon unresponsive — taking over",
                    incumbent.pid,
                    resolved_profile_id
                );
            } else {
                log!(
                    "Incumbent PID {} for profile {} is dead — taking over",
                    incumbent.pid,
                    resolved_profile_id
                );
            }
        }
    }

    // 4. Update profile entry in state and write discovery file
    let mut success = false;
    if let Ok(mut info_guard) = state.rpc_info.lock() {
        if let Some(info) = info_guard.as_mut() {
            info.browser.extension_id = Some(extension_id);
            info.profile_id.clone_from(&resolved_profile_id);
            info.display_name.clone_from(&display_name);
            info.created = created;
            info.client_type.clone_from(&client_type);
            info.client_version.clone_from(&client_version);
            info.last_used = now;
            // Accumulate client_type into client_types_used
            info.client_types_used = client_type
                .as_deref()
                .map(|ct| vec![ct.to_string()])
                .unwrap_or_default();
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
        return Err(anyhow::anyhow!("Failed to update discovery file"));
    }

    // 5. Store profile_id in state
    *state.profile_id.lock().unwrap() = Some(resolved_profile_id.clone());

    // 6. Open per-profile KV store
    {
        let config_dir = jstorrent_common::get_config_dir()
            .ok_or_else(|| anyhow::anyhow!("Could not determine config directory"))?;
        let profile_dir = config_dir
            .join("jstorrent-native")
            .join("profiles")
            .join(&resolved_profile_id);
        std::fs::create_dir_all(&profile_dir)?;
        let db_path = profile_dir.join("data.db");
        log!("Opening per-profile KV store at {:?}", db_path);
        let kv = kv_store::KvStore::open(&db_path)?;
        *state.kv.lock().unwrap() = Some(kv);
    }

    // 7. Start daemon
    let start_result = if daemon_manager.port.is_none() {
        log!("Starting daemon with profile_id: {}", resolved_profile_id);
        daemon_manager.start(&resolved_profile_id)
    } else {
        let _ = daemon_manager.refresh_config().await;
        Ok(())
    };

    if let Err(e) = start_result {
        log!("Failed to start daemon: {:#}", e);
        return Err(anyhow::anyhow!("Failed to start daemon: {e:#}"));
    }

    // 8. Return DaemonInfo
    if let (Some(port), Some(token)) = (daemon_manager.port, daemon_manager.token.clone()) {
        let roots = state
            .rpc_info
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|info| info.download_roots.clone())
            .unwrap_or_default();

        let rpc_info = crate::rpc::read_discovery_file();

        Ok(ResponsePayload::DaemonInfo {
            profile_id: resolved_profile_id,
            port,
            token,
            version: env!("CARGO_PKG_VERSION").to_string(),
            roots,
            add_token: rpc_info.add_token,
            desktop_version: rpc_info.desktop_version,
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
                if let Ok(info_guard) = state.rpc_info.lock() {
                    if let Some(info) = info_guard.as_ref() {
                        if let Err(e) = crate::rpc::write_discovery_file(info.clone()) {
                            log!("Failed to persist rpc-info after adding root: {}", e);
                        }
                    }
                }

                if let Err(e) = daemon_manager.refresh_config().await {
                    log!("Failed to refresh daemon config: {}", e);
                }
            }
            res
        }

        Operation::RegisterDownloadRoot { path } => {
            let res = folder_picker::register_download_root(state, &path);
            if res.is_ok() {
                if let Ok(info_guard) = state.rpc_info.lock() {
                    if let Some(info) = info_guard.as_ref() {
                        if let Err(e) = crate::rpc::write_discovery_file(info.clone()) {
                            log!("Failed to persist rpc-info after registering root: {}", e);
                        }
                    }
                }

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
                            if let Err(e) = crate::rpc::write_discovery_file(info.clone()) {
                                log!("Failed to persist rpc-info after removing root: {}", e);
                            }
                        }
                    }
                }
            }

            if removed {
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
            profile_id,
            client_type,
            client_version,
            ..
        } => {
            log!(
                "Handling Handshake for extension_id: {}, profile_id: {:?}",
                extension_id,
                profile_id
            );
            let result = do_handshake(
                state,
                extension_id,
                profile_id,
                client_type,
                client_version,
                daemon_manager,
                system,
            )
            .await;

            // If handshake returned ProfileInUse, return it as an error response
            if let Ok(ResponsePayload::ProfileInUse { .. }) = &result {
                let payload = result.unwrap();
                return Response {
                    id: req.id,
                    ok: false,
                    error: Some("profile_in_use".to_string()),
                    payload,
                };
            }

            // Trigger background update check after successful handshake
            if result.is_ok() && state.launcher == "chrome" {
                let should_check = {
                    let kv = state.kv.lock().unwrap();
                    kv.as_ref().is_some_and(updater::should_auto_check)
                };
                if should_check {
                    let kv_guard = state.kv.lock().unwrap();
                    if let Some(kv) = kv_guard.as_ref() {
                        updater::record_check_time(kv);
                    }
                    drop(kv_guard);
                    let event_tx = event_tx.clone();
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
            profile_id,
            client_type,
            client_version,
            ..
        } => {
            log!(
                "Handling TakeOver for extension_id: {}, profile_id: {:?}",
                extension_id,
                profile_id
            );

            // Read profile from rpc-info.json and kill incumbent if alive
            let unified = rpc::read_discovery_file();
            let target_profile = if let Some(ref pid) = profile_id {
                unified.profiles.iter().find(|p| &p.profile_id == pid)
            } else {
                None
            };

            if let Some(profile) = target_profile {
                if profile.pid != std::process::id() && profile.pid != 0 {
                    system.refresh_processes();
                    let incumbent_pid = sysinfo::Pid::from(profile.pid as usize);
                    if let Some(proc) = system.process(incumbent_pid) {
                        log!("TakeOver: killing incumbent PID {}", profile.pid);
                        proc.kill();
                    }

                    // Wait for daemon to die via parent-pid monitoring
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            }

            // Proceed with normal handshake
            do_handshake(
                state,
                extension_id,
                profile_id,
                client_type,
                client_version,
                daemon_manager,
                system,
            )
            .await
        }

        Operation::OpenFile { root_key, path } => {
            log!(
                "Handling OpenFile for root_key: {}, path: {}",
                root_key,
                path
            );

            let root_path = state
                .rpc_info
                .lock()
                .ok()
                .and_then(|info| info.as_ref().and_then(|i| i.download_roots.clone()))
                .and_then(|roots| roots.into_iter().find(|r| r.key == root_key))
                .map(|r| r.path);

            match root_path {
                Some(root) => match path_safety::validate_path(&path, &root) {
                    Ok(safe_path) => opener::open_file(&safe_path)
                        .map(|()| ResponsePayload::Empty)
                        .map_err(|e| anyhow::anyhow!(e)),
                    Err(e) => Err(e),
                },
                None => Err(anyhow::anyhow!("Root not found: {root_key}")),
            }
        }

        Operation::RevealInFolder { root_key, path } => {
            log!(
                "Handling RevealInFolder for root_key: {}, path: {}",
                root_key,
                path
            );

            let root_path = state
                .rpc_info
                .lock()
                .ok()
                .and_then(|info| info.as_ref().and_then(|i| i.download_roots.clone()))
                .and_then(|roots| roots.into_iter().find(|r| r.key == root_key))
                .map(|r| r.path);

            match root_path {
                Some(root) => match path_safety::validate_path(&path, &root) {
                    Ok(safe_path) => opener::reveal_in_folder(&safe_path)
                        .map(|()| ResponsePayload::Empty)
                        .map_err(|e| anyhow::anyhow!(e)),
                    Err(e) => Err(e),
                },
                None => Err(anyhow::anyhow!("Root not found: {root_key}")),
            }
        }

        Operation::ReadTorrentFile { path } => {
            log!("Handling ReadTorrentFile: {}", path);

            // Validate path ends with .torrent
            if path.to_lowercase().ends_with(".torrent") {
                match std::fs::read(&path) {
                    Ok(contents) => {
                        use base64::Engine;
                        let encoded = base64::engine::general_purpose::STANDARD.encode(&contents);
                        let name = std::path::Path::new(&path)
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default();
                        Ok(ResponsePayload::TorrentFileContents {
                            name,
                            contents_base64: encoded,
                        })
                    }
                    Err(e) => Err(anyhow::anyhow!("Failed to read torrent file: {e}")),
                }
            } else {
                Err(anyhow::anyhow!(
                    "Invalid file type: path must end with .torrent"
                ))
            }
        }

        // Launch desktop app
        Operation::LaunchDesktop => {
            let profile_id = state.profile_id.lock().unwrap().clone();
            match updater::launch_desktop_app(profile_id.as_deref()) {
                Ok(()) => Ok(ResponsePayload::Empty),
                Err(e) => Err(e),
            }
        }

        // Update operations
        Operation::CheckForUpdates => match updater::run_update_check(false).await {
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
        },

        Operation::InstallUpdate => match updater::run_update_check(true).await {
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
        },

        // Profile management (no handshake required)
        Operation::ListProfiles => {
            let unified = rpc::read_discovery_file();
            let mut profiles = Vec::with_capacity(unified.profiles.len());
            for p in &unified.profiles {
                let live = rpc::check_profile_liveness(p.port, &p.token).await;
                profiles.push(protocol::ProfileListEntry {
                    profile_id: p.profile_id.clone(),
                    display_name: p.display_name.clone(),
                    created: p.created,
                    last_used: p.last_used,
                    client_type: p.client_type.clone(),
                    client_version: p.client_version.clone(),
                    live,
                });
            }
            Ok(ResponsePayload::ProfileList { profiles })
        }

        Operation::RenameProfile {
            profile_id,
            display_name,
        } => match rpc::rename_profile(&profile_id, &display_name) {
            Ok(()) => {
                // Also update in-memory state if this is our current profile
                if let Ok(mut info_guard) = state.rpc_info.lock() {
                    if let Some(info) = info_guard.as_mut() {
                        if info.profile_id == profile_id {
                            info.display_name.clone_from(&display_name);
                        }
                    }
                }
                Ok(ResponsePayload::Empty)
            }
            Err(e) => Err(anyhow::anyhow!("Failed to rename profile: {e}")),
        },

        Operation::GetVersionInfo => {
            let rpc = rpc::read_discovery_file();
            Ok(ResponsePayload::VersionInfo {
                version: env!("CARGO_PKG_VERSION").to_string(),
                desktop_version: rpc.desktop_version,
            })
        }

        // KV storage operations — require handshake first
        Operation::KvGet { key } => {
            let kv = state.kv.lock().unwrap();
            let kv = kv
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Handshake required before KV operations"));
            match kv {
                Ok(kv) => kv.get(&key).map(|value| ResponsePayload::KvValue { value }),
                Err(e) => Err(e),
            }
        }

        Operation::KvGetMulti { keys } => {
            let kv = state.kv.lock().unwrap();
            let kv = kv
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Handshake required before KV operations"));
            match kv {
                Ok(kv) => kv
                    .get_multi(&keys)
                    .map(|entries| ResponsePayload::KvMultiValue { entries }),
                Err(e) => Err(e),
            }
        }

        Operation::KvSet { key, value } => {
            let kv = state.kv.lock().unwrap();
            let kv = kv
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Handshake required before KV operations"));
            match kv {
                Ok(kv) => kv.set(&key, &value).map(|()| ResponsePayload::Empty),
                Err(e) => Err(e),
            }
        }

        Operation::KvDelete { key } => {
            let kv = state.kv.lock().unwrap();
            let kv = kv
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Handshake required before KV operations"));
            match kv {
                Ok(kv) => kv.delete(&key).map(|()| ResponsePayload::Empty),
                Err(e) => Err(e),
            }
        }

        Operation::KvKeys { prefix } => {
            let kv = state.kv.lock().unwrap();
            let kv = kv
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Handshake required before KV operations"));
            match kv {
                Ok(kv) => kv
                    .keys(prefix.as_deref())
                    .map(|keys| ResponsePayload::KvKeys { keys }),
                Err(e) => Err(e),
            }
        }

        Operation::KvClear { prefix } => {
            let kv = state.kv.lock().unwrap();
            let kv = kv
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Handshake required before KV operations"));
            match kv {
                Ok(kv) => kv.clear(prefix.as_deref()).map(|()| ResponsePayload::Empty),
                Err(e) => Err(e),
            }
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
