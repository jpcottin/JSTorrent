# Tauri App Changelog

All notable changes to the JSTorrent Desktop app are documented here.

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
