# Extension Changelog

All notable changes to the Chrome extension are documented here.

## [Unreleased]

## [1.0.3] - 2026-02-16

### Added
- Context menu options on extension icon: open as tab, popup, or desktop app
- Batch piece hash verification (verifyChunks API)
- Recursive file listing (listTree) for faster resume and recheck

### Changed
- Minimum backend versions: Tauri App v0.1.24, Android v1.0.18

## [1.0.2] - 2026-02-11

### Added
- Desktop app launch from extension settings with version reporting
- Profile picker UI and backend support
- Launch page token routing and extension torrent handling
- Extension TakeOver flow for desktop mutual exclusion
- Shared SQLite KV store for desktop, routed through native host
- Tray stats, auto-updater, and extension popup window
- Torrent queue management with active download/seed limits
- Log viewer, file opening, and completion notifications
- Seed rotation and reset command
- Resume data verification and auto data check on start
- Piece-level no-data timeout for aggressive peer snubbing
- RTT-based peer snubbing, adaptive timeouts, and peer caching
- Slow-start queue sizing for peer pipeline depth
- DiskId plumbing across all platforms for disk I/O layer

### Changed
- Renamed installId to telemetryId across extension codebase
- Renamed ChromeExtensionEngineManager to DaemonEngineManager
- Simplified config storage to local-only with windowMode setting
- Refactored uploader to pull-based model with per-peer send buffer watermarks
- Replaced exclusive ownership with soft affinity piece requesting
- Replaced piece abandonment with failed-peer tracking
- Keep in-flight requests on choke (libtorrent alignment)
- Consolidated link handling and improved companion server reliability

### Fixed
- Companion token mismatch recovery loop
- Magnet link handling
- TCP data reordering race condition in onTcpClose
- Disconnect peers sending invalid message lengths (>1MB)
- Recheck race in torrent file operations

## [1.0.1] - 2026-02-04

### Changed
- Test release to verify CI workflow

## [1.0.0] - 2026-02-04

### Added
- SOCKS5 proxy support with UDP for tracker announces
- Torrent recheck functionality to verify downloaded data
- ETA display for active downloads
- File truncation support for pre-allocating disk space
- Tracker status display in torrent details
- Torrent metadata display (creation date, comment, etc.)
- Settings reset and clear options
- Standalone daemon mode for ChromeOS companion
- High-throughput batched disk writes with adaptive batching
- Worker-based hasher for improved hashing performance

### Changed
- Improved MSE handshake performance with O(1) info hash lookup and batch SHA1 hashing
- Better removal UX with improved connection handling
- Per-torrent subscription model for more efficient UI updates
- Unified write error classification with intelligent retry logic

### Fixed
- MSE/plaintext protocol detection reliability
- Race conditions during startup and fast connections
- Connection race condition during torrent removal

## [0.1.5] - 2026-02-04

### Added
- Initial changelog

<!-- Template for new releases:
## [x.x.x] - YYYY-MM-DD

### Added
- New features

### Changed
- Changes to existing features

### Fixed
- Bug fixes
-->
