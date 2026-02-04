# Extension Changelog

All notable changes to the Chrome extension are documented here.

## [Unreleased]

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
