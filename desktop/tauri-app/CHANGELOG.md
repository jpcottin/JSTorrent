# Tauri App Changelog

All notable changes to the JSTorrent Desktop app are documented here.

## [0.1.2]

- Fix macOS notarization so Gatekeeper no longer blocks the app

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
