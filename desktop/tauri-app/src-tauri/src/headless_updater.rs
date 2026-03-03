use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

/// Result written to `update-check-result.json` in the app data directory.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct UpdateCheckResult {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Path to the result file within the app data directory.
const RESULT_FILENAME: &str = "update-check-result.json";

/// Run a headless update check (and optionally auto-install).
/// This builds a minimal Tauri app with only the updater plugin,
/// performs the check, writes the result to a JSON file, then exits.
pub fn run(auto_update: bool, context: tauri::Context) {
    let app = tauri::Builder::default()
        .setup(move |app| {
            // Register the updater plugin with CFU ID and reason headers
            #[cfg(desktop)]
            {
                let mut builder =
                    tauri_plugin_updater::Builder::new().header("X-Check-Reason", "host")?;
                if let Some(cfu_id) = jstorrent_common::get_or_create_cfu_id() {
                    builder = builder.header("X-CFU-Id", &cfu_id)?;
                }
                app.handle().plugin(builder.build())?;
            }

            // Close the window immediately — we don't need UI
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.destroy();
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                do_update_check(&handle, auto_update).await;
                handle.exit(0);
            });

            Ok(())
        })
        .build(context)
        .unwrap_or_else(|e| {
            eprintln!("headless-updater: failed to init: {e}");
            write_result_to_shared_dir(&UpdateCheckResult {
                available: false,
                version: None,
                current_version: None,
                body: None,
                error: Some(format!("Failed to initialize: {e}")),
            });
            std::process::exit(1);
        });

    app.run(|_app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}

async fn do_update_check(handle: &tauri::AppHandle, auto_update: bool) {
    let result = check_and_maybe_install(handle, auto_update).await;
    write_result(handle, &result);
    if result.error.is_some() {
        eprintln!(
            "headless-updater: error: {}",
            result.error.as_deref().unwrap_or("unknown")
        );
    } else if result.available {
        eprintln!(
            "headless-updater: update available: {}",
            result.version.as_deref().unwrap_or("unknown")
        );
    } else {
        eprintln!("headless-updater: up to date");
    }
}

async fn check_and_maybe_install(
    handle: &tauri::AppHandle,
    auto_update: bool,
) -> UpdateCheckResult {
    let updater = match handle.updater() {
        Ok(u) => u,
        Err(e) => {
            return UpdateCheckResult {
                available: false,
                version: None,
                current_version: None,
                body: None,
                error: Some(format!("Failed to create updater: {e}")),
            };
        }
    };

    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            return UpdateCheckResult {
                available: false,
                version: None,
                current_version: None,
                body: None,
                error: None,
            };
        }
        Err(e) => {
            return UpdateCheckResult {
                available: false,
                version: None,
                current_version: None,
                body: None,
                error: Some(format!("Update check failed: {e}")),
            };
        }
    };

    let result = UpdateCheckResult {
        available: true,
        version: Some(update.version.clone()),
        current_version: Some(update.current_version.clone()),
        body: update.body.clone(),
        error: None,
    };

    if !auto_update {
        return result;
    }

    // Write interim result before download (in case install kills the process on Windows)
    write_result(handle, &result);

    eprintln!("headless-updater: downloading update {}...", update.version);
    if let Err(e) = update
        .download_and_install(
            |chunk_len, content_len| {
                eprintln!("headless-updater: download progress: +{chunk_len} / {content_len:?}");
            },
            || {
                eprintln!("headless-updater: download complete, installing...");
            },
        )
        .await
    {
        return UpdateCheckResult {
            available: true,
            version: Some(result.version.unwrap_or_default()),
            current_version: result.current_version,
            body: result.body,
            error: Some(format!("Install failed: {e}")),
        };
    }

    // On macOS/Linux, restart launches the new binary.
    // The new binary will see --auto-update, check, find no update, and exit.
    // On Windows, the NSIS installer may have already killed this process.
    eprintln!("headless-updater: install complete, restarting...");
    handle.restart();
}

fn write_result(_handle: &tauri::AppHandle, result: &UpdateCheckResult) {
    write_result_to_shared_dir(result);
}

/// Write result to the shared config directory that the native host can also read.
/// Uses `~/.config/jstorrent-native/` (same directory as the native host's KV store).
fn write_result_to_shared_dir(result: &UpdateCheckResult) {
    let dir = dirs::config_dir().map(|d| d.join("jstorrent-native"));
    if let Some(dir) = dir {
        write_result_to_dir(result, &dir);
    }
}

/// Write result JSON to a specific directory.
fn write_result_to_dir(result: &UpdateCheckResult, dir: &std::path::Path) {
    std::fs::create_dir_all(dir).ok();
    let path = dir.join(RESULT_FILENAME);
    if let Ok(json) = serde_json::to_string_pretty(result) {
        if let Err(e) = std::fs::write(&path, json) {
            eprintln!(
                "headless-updater: failed to write result to {}: {e}",
                path.display()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_update_check_result_serialization() {
        // Full result with all fields
        let result = UpdateCheckResult {
            available: true,
            version: Some("1.0.0".to_string()),
            current_version: Some("0.9.0".to_string()),
            body: Some("Release notes".to_string()),
            error: None,
        };
        let json = serde_json::to_string(&result).unwrap();
        let parsed: UpdateCheckResult = serde_json::from_str(&json).unwrap();
        assert_eq!(result, parsed);

        // "error" field should be omitted when None (skip_serializing_if)
        assert!(!json.contains("error"));

        // Minimal result (no update available)
        let minimal = UpdateCheckResult {
            available: false,
            version: None,
            current_version: None,
            body: None,
            error: None,
        };
        let json = serde_json::to_string(&minimal).unwrap();
        assert!(!json.contains("version"));
        assert!(!json.contains("body"));

        // Error result
        let error = UpdateCheckResult {
            available: false,
            version: None,
            current_version: None,
            body: None,
            error: Some("connection refused".to_string()),
        };
        let json = serde_json::to_string(&error).unwrap();
        assert!(json.contains("connection refused"));
        let parsed: UpdateCheckResult = serde_json::from_str(&json).unwrap();
        assert_eq!(error, parsed);
    }

    #[test]
    fn test_write_result_to_dir() {
        let dir = tempfile::tempdir().unwrap();
        let result = UpdateCheckResult {
            available: true,
            version: Some("2.0.0".to_string()),
            current_version: Some("1.5.0".to_string()),
            body: Some("New features".to_string()),
            error: None,
        };

        write_result_to_dir(&result, dir.path());

        let path = dir.path().join(RESULT_FILENAME);
        assert!(path.exists(), "result file should be created");

        let contents = std::fs::read_to_string(&path).unwrap();
        let parsed: UpdateCheckResult = serde_json::from_str(&contents).unwrap();
        assert_eq!(parsed, result);
    }
}
