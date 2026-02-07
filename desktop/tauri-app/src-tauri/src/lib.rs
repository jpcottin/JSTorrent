use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_shell::process::CommandChild;
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
    #[allow(dead_code)]
    sidecar: Mutex<Option<CommandChild>>,
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
        sidecar: Mutex::new(None),
    });

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(daemon_state.clone())
        .invoke_handler(tauri::generate_handler![get_daemon_info])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .setup(move |app| {
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

            // Spawn io-daemon sidecar
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

            let (mut rx, child) = sidecar.spawn().expect("failed to spawn io-daemon sidecar");
            *daemon_state.sidecar.lock().unwrap() = Some(child);

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
