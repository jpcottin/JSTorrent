# Tauri App Changelog

All notable changes to the JSTorrent Desktop app are documented here.

## [0.1.12]

- Fix CI: publish releases as non-prerelease directly, validate platform assets before showing on website

## [0.1.11]

- Fix CI: prevent main branch builds from uploading to tag release

## [0.1.10]

- Fix CI release flow: use prerelease instead of draft so finalize job can edit it

## [0.1.9]

- Accept raw file paths (not just file:// URLs) for .torrent file association on Windows
- Downgrade periodic tick/maintenance/backpressure/upload stats from info to debug log level
- Fix CI release flow: make Tauri release draft until finalize-release job publishes

## [0.1.8]

- Add single-instance plugin for Windows/Linux deep link forwarding
- Add Linux ARM64 builds to CI matrix
- Add openExternalUrl utility using Tauri opener plugin
- Fix io-daemon resolution to search with target triple suffix (NSIS layout)
- Fix sysinfo startup: use refresh_processes() instead of slow new_all()
- Convert unwrap() to proper error propagation in RPC server and KV store init
- Use app_local_data_dir for Windows native host manifest (matches NSIS cleanup)
- Hide extension-only settings in Tauri standalone mode

## [0.1.7]

- Fix CI build on Linux/Windows: gate macOS-only `RunEvent::Reopen` with `#[cfg(target_os = "macos")]`

## [0.1.6]

- Fix formatting / CI issue from v0.1.5 release

## [0.1.5]

- Add shared SQLite KV store for desktop, route extension and Tauri KV through native host
- Add native messaging host registration and macOS fixes
- Simplify config storage to local-only, add windowMode setting and Tauri notifications

## [0.1.4]

- Add system tray stats showing download/upload speed
- Add auto-updater with user-facing update notifications
- Add extension popup window support
- Fix Windows CORS by adding http://tauri.localhost origin for WebView2
- Hide sidecar console window on Windows (CREATE_NO_WINDOW flag)
- Add NSIS installer hooks and platform-specific tray click behavior

## [0.1.3]

- Enable WebView devtools in release builds for all platforms (F12 / right-click Inspect)

## [0.1.2]

- Fix macOS notarization so Gatekeeper no longer blocks the app
- Improve sidecar resolution to handle different installer layouts (with/without target triple, binaries subdirectory, exe directory)
- Show native error dialog on Windows when app fails to start instead of silently exiting
- Write crash.log next to executable on fatal errors
- Embed WebView2 bootstrapper on Windows so installer works offline

## [0.1.1]

- Notarization fix attempt (incomplete - missing APPLE_API_KEY env var)

## [0.1.0]

Initial release of the JSTorrent desktop app.

- Tauri 2 app with shared engine, client, and UI packages
- Deep link handling for magnet URIs and .torrent file associations
- System tray with close-to-tray behavior
- System bridge native messaging integration
- Auto-updater support
- IndexedDB session store
- Signed and notarized builds for macOS, Windows, and Linux
