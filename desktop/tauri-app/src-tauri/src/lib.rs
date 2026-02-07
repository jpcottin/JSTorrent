use serde::Serialize;
use std::sync::Arc;
use tauri_plugin_shell::ShellExt;
use tokio::sync::OnceCell;

#[derive(Debug, Clone, Serialize)]
pub struct DaemonInfo {
    pub port: u16,
    pub token: String,
    pub host: String,
}

struct DaemonState {
    info: OnceCell<DaemonInfo>,
}

#[tauri::command]
async fn get_daemon_info(state: tauri::State<'_, Arc<DaemonState>>) -> Result<DaemonInfo, String> {
    state
        .info
        .get()
        .cloned()
        .ok_or_else(|| "Daemon not yet started".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let token = uuid::Uuid::new_v4().to_string();
    let install_id = uuid::Uuid::new_v4().to_string();
    let daemon_state = Arc::new(DaemonState {
        info: OnceCell::new(),
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(daemon_state.clone())
        .invoke_handler(tauri::generate_handler![get_daemon_info])
        .setup(move |app| {
            let shell = app.shell();
            let sidecar = shell
                .sidecar("binaries/jstorrent-io-daemon")
                .expect("failed to create sidecar command")
                .args([
                    "--port",
                    "0",
                    "--token",
                    &token,
                    "--parent-pid",
                    &std::process::id().to_string(),
                    "--install-id",
                    &install_id,
                ]);

            let state = daemon_state.clone();
            let token_clone = token.clone();

            let (mut rx, _child) = sidecar.spawn().expect("failed to spawn io-daemon sidecar");

            // Read stdout in background to capture the port
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;

                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let line = String::from_utf8_lossy(&line);
                            let line = line.trim();
                            if let Ok(port) = line.parse::<u16>() {
                                let info = DaemonInfo {
                                    port,
                                    token: token_clone.clone(),
                                    host: "127.0.0.1".to_string(),
                                };
                                eprintln!("io-daemon started on port {port}");
                                let _ = state.info.set(info);
                                break;
                            }
                        }
                        CommandEvent::Stderr(line) => {
                            let line = String::from_utf8_lossy(&line);
                            eprintln!("io-daemon: {}", line.trim());
                        }
                        CommandEvent::Error(err) => {
                            eprintln!("io-daemon error: {err}");
                            break;
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("io-daemon terminated: {:?}", payload.code);
                            break;
                        }
                        _ => {}
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
