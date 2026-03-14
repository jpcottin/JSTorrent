# Tauri App Changelog

All notable changes to the JSTorrent Desktop app are documented here.

## [0.2.0]

- Add video streaming: right-click Watch on video files for in-app playback with MKV keyframe seeking
- Add desktop video fullscreen support (double-click to toggle)
- Add LAN media share server for streaming to other devices on the network
- Add web seed support: concurrent transfers, keep-alive connections, redirect handling, rate limiting
- Add search plugin system with installable Internet Archive plugin
- Add toast notification system (recheck results, etc.)
- Port media streaming session contract to Rust io-daemon
- Advertise IO daemon contract versions for conformance testing
- Return 404 for missing daemon deletes instead of silently succeeding
- Fix background update check spawning Tauri app window
- Fix Windows taskbar icon and Linux window icon
- Fix zero upload slots choking behavior
- Fix file progress display after torrent recheck
- Fix extension takeover from desktop app
- Prefer UTF-8 torrent metadata and paths
- Support magnet select-only file indices
- Add configurable active piece memory limit
- Add diagnostic logging for magnet deep link routing
- Fix io-daemon spurious shutdown on transient parent process check failure (e.g., after sleep/wake)

## [0.1.31]

- Fix 10-second startup delay by removing unnecessary backend-ready synchronization
- Fix startup race condition: wait for backend-ready event before IPC
- Add retry logic to TauriChannel handshake for setup race condition
- Add Crostini mode UI and ensure download root exists
- Fix version check for Crostini: treat as desktop backend, not Android
- Fix Crostini standalone daemon /status response for extension compatibility

## [0.1.30]

- Add auto-updater hardening tests and CI gates
- Fix plugin-opener resolution and daemon handshake
- Fix Crostini standalone daemon serializing snake_case keys for /status
- Route Report Bug button to feedback.html instead of GitHub

## [0.1.29]

- Publish standalone io-daemon Linux binaries to GitHub Releases for ChromeOS Crostini
- Add Crostini install script (`curl -fsSL https://jstorrent.com/install-crostini.sh | bash`)
- Add default gateway detection across all backends (port-mapping)
- Fix stale profileId causing permanent "Connection Lost" on desktop
- Fix app not fully quitting on window close when "Run in Background" is off

## [0.1.28]

- Add batchDelete endpoint to io-daemon for faster torrent data removal
- Stop torrent network immediately on removal
- Add loading state to confirm dialog during torrent data removal
- Add engine state, usage metrics, and daemon uptime to bug reports
- Add check-for-update ID and reason headers to update checks
- Add TTL for cached failed file opens
- Fix Windows taskbar icon appearing as blank page
- Fix removeTorrentWithData skipping multi-file deletion
- Fix removeTorrentWithData checking wrong directory for torrent root
- Fix system bridge showing Ready when no usable download location
- Fix duplicate update dialogs
- Clear tray speed stats when window closes without background mode

## [0.1.27]

- Fix Windows build: update icon path after legacy installer removal
- Fix UPnP status display

## [0.1.26]

- Simplify desktop version reporting and improve update UX
- Add profile removal to Settings > Profiles tab
- Fix desktop app update verification timeout
- Remove legacy System Bridge installers and link-handler scripts
- Refactor daemon bridge into smaller modules with characterization tests

## [0.1.25]

- Fix UDP hostname resolution failing on IPv4-bound sockets
- Periodically refresh desktopVersion from rpc-info.json

## [0.1.24]

- Add list_tree endpoint to io-daemon for recursive file listing
- Add verifyChunks API for batch piece hash verification
- Fix .torrent file open failing for filenames with spaces
- Fix tray menu items firing twice on macOS
- Sync check menu items between app menu and tray menu on macOS
- Aggregate changelogs across skipped versions in update server

## [0.1.23]

- Fix formatting (cargo fmt)

## [0.1.22]

- Add jstorrent:// deep link protocol as fallback from web launch page to desktop app
- Remove manual magnet handler setting (Desktop/Extension/Auto) — routing is now always auto-mode
- Show "Open in Desktop App" button on launch page when extension is unavailable

## [0.1.21]

- Remember window position across restarts

## [0.1.20]

- Add magnet/torrent routing: tray menu with routing options, desktop activation marking, launch page token routing
- Launch desktop app from extension settings
- Report desktop app version through extension to website
- Add native Tauri folder picker dialog and platform-specific notifications
- Fix default startup action
- Fix magnet link handling

## [0.1.19]

- Add profile picker UI: list, rename, and switch profiles from Settings > Profiles tab
- Add restart_app Tauri command for profile switching
- Support user-domain macOS .pkg installs (~/Applications, no admin required)

## [0.1.18]

- Add profile system: per-profile KV isolation, liveness checks, profile_id identity
- Add system bridge updater and headless Tauri updater
- Add macOS .pkg installer with postinstall/preinstall scripts
- Add NSIS native host registration hooks
- Recreate main window from tray when run_in_background is off
- Persist and resend profileId in Tauri app handshake
- Isolate host bridge integration test from real config directory

## [0.1.17]

- Add desktop/extension mutual exclusion: Tauri kills incumbent Chrome native host on startup; extension shows TakeOver flow to quit desktop app
- Add tauri-plugin-autostart with "Start at Login" tray menu toggle
- Add "Run in Background" tray menu toggle (when disabled, closing window quits)
- Tauri app exits when its sidecar dies to avoid lingering after TakeOver
- Pass --launcher tauri arg when spawning system bridge sidecar

## [0.1.16]

- Add SQLite busy timeout (5s) to prevent SQLITE_BUSY crashes from concurrent sidecar/native host access on Windows
- Strip `\\?\` extended-length path prefix from Windows paths for Chrome native messaging compatibility

## [0.1.15]

- Add tauri-plugin-nosleep to prevent system sleep during active downloads
- Add nosleep:default capability
- Fix eprint! crash on Windows when native messaging host has no stderr handle

## [0.1.14]

- Consolidate logging to config dir (~/.config/jstorrent-native/) instead of exe dir
- Copy triple-suffixed sidecars in prepare-sidecar.sh to prevent stale shadowing
- Add process:allow-restart and process:allow-exit Tauri capabilities
- Inject package version into Vite define for runtime access
- Clean up settings UI: remove unused sections (reset UI, interface mode, component log levels, daemon rate limiting, max active seeds)
- Log app and system bridge versions on daemon connect

## [0.1.13]

- Add Linux ARM64 download links to website with architecture auto-detection
- Fix release version detection: sort by semver instead of relying on GitHub API order
- Show app version in system bridge panel and settings

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
