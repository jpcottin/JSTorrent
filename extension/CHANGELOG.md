# Extension Changelog

All notable changes to the Chrome extension are documented here.

## [Unreleased]

## [1.1.1] - 2026-03-14

### Fixed
- Video player not releasing file lock on close
- Stale streaming suppressions persisting after file lock removal, preventing pieces from resuming download

### Changed
- Internet Archive search plugin now filters results to Creative Commons and public domain licenses only

## [1.1.0] - 2026-03-14

### Added
- Video streaming: right-click "Watch" on video files to stream directly from the torrent swarm with MKV keyframe-aware seeking and piece timeline visualization
- Web seed support (BEP 17/19): concurrent HTTP downloads from web seeds with keep-alive, rate limiting, redirect handling, and health-based source selection
- LAN media sharing: generate shareable URLs for completed files accessible by other devices on the local network (desktop only, capability-gated)
- Search plugins infrastructure (behind feature flag): sandboxed plugin install and execution, Internet Archive sample plugin, search results with torrent actions
- Configurable active piece memory limit
- IO daemon and native host contract version advertising and conformance testing
- Toast notification system for recheck results
- Magnet URI select-only file indices (pre-select specific files before metadata)

### Fixed
- Companion write backpressure deadlock: downloads stalling after 32MB of cumulative writes on ChromeOS
- ChromeOS download root state sync not reflecting current roots
- Extension takeover from desktop app failing
- File progress not updating after torrent recheck
- Data check using wrong batch size
- Zero upload slots causing incorrect choking behavior
- Streaming file lock preemption and cleanup on file completion
- Boundary .parts file materialization on session restore

### Changed
- Rewrote .parts partial file storage to use fixed header slots (libtorrent partfile compatibility)
- Prefer UTF-8 torrent metadata and file paths over legacy encodings
- Streaming-aware peer selection: prioritize peers with pieces needed for active video playback
- Moved ChromeOS capability discovery from HTTP polling to control WebSocket channel
- Decoupled popup video player from engine bundle for faster loading
- Recommended backend versions: Tauri App v0.2.0, Android v1.0.23

## [1.0.6] - 2026-03-03

### Added
- Crostini mode UI for ChromeOS without ARC (io-daemon in Linux container)
- NAT-PMP (RFC 6886) and PCP (RFC 6887) port mapping clients
- Default gateway detection across all backends
- Legacy migration snooze support and aggressive nag system
- Legacy app/extension IDs in externally_connectable for bidirectional detection
- Torrents-added usage metric tracking

### Fixed
- Tauri 10s startup delay from unnecessary backend-ready synchronization
- Tauri startup race: wait for backend-ready event before IPC
- TauriChannel handshake retry for setup race condition
- Stale profileId causing permanent "Connection Lost" on desktop
- Native host and io-daemon lingering when no extension UI is open
- Native port cleanup on failed handshake
- Version check for Crostini: treat as desktop backend, not Android
- Tauri desktop app plugin-opener resolution and daemon handshake

### Changed
- Report Bug button routes to feedback.html instead of GitHub
- Replaced new.jstorrent.com URLs with jstorrent.com
- Removed chromeos-testbed/ and extension/tools/ (moved to standalone repo)
- Renamed upnp/ to port-mapping/ for NAT-PMP and PCP support

## [1.0.5] - 2026-02-25

### Added
- Batch file deletion for faster torrent data removal
- Loading state in confirmation dialog during torrent data removal
- Profile removal in Settings > Profiles tab
- Engine state, usage metrics, and daemon uptime in bug reports
- Periodic desktop version refresh from rpc-info.json

### Fixed
- Torrent data deletion skipping multi-file torrents
- Torrent data deletion checking wrong root directory
- System bridge showing Ready when no usable download location exists
- UDP hostname resolution failing on IPv4-bound sockets
- Duplicate update dialogs in Tauri app
- UPnP status display
- Desktop app update verification timeout

### Changed
- Stop torrent network immediately on removal (faster cleanup)
- Simplified desktop version reporting and update UX
- Minimum backend versions: Tauri App v0.1.28, Android v1.0.22
- Refactored daemon bridge into smaller, testable modules

## [1.0.4] - 2026-02-16

### Changed
- Minimum backend versions: Tauri App v0.1.24, Android v1.0.18

## [1.0.3] - 2026-02-16

### Added
- Context menu options on extension icon: open as tab, popup, or desktop app
- Batch piece hash verification (verifyChunks API)
- Recursive file listing (listTree) for faster resume and recheck

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
