# Android Changelog

All notable changes to the Android app are documented here.

## [1.0.13] - 2026-02-05

### Fixed
- ForegroundServiceDidNotStartInTimeException crash on Android 12+
- Foreground service lifecycle on rapid stop/start cycles
- Subscription lifecycle across engine restarts

### Changed
- Show network waiting status in torrent list
- Auto-pause new torrents when network is restricted
- Navigate to torrent list after clearing all data

## [1.0.12] - 2026-02-04

### Fixed
- Engine startup race conditions with command queueing
- Stale cache entries after torrent removal
- Race conditions in batch operations (pause/resume/remove selected)

## [1.0.11] - 2026-02-04

### Added
- Torrent recheck functionality (verify and re-download corrupted pieces)
- File truncation support for accurate file sizes
- Conservative seeding mode with pending read limit
- Worker hasher for improved hashing performance

### Fixed
- Startup race conditions
- Connection race conditions during torrent removal

## [1.0.10] - 2026-02-03

### Changed
- Enabled R8 minification and resource shrinking (83% smaller APK, ~9.5MB vs ~55MB)
- Added 16KB memory page size support for Android 15+ devices

## [1.0.9] - 2026-02-03

### Added
- Feedback/bug report feature

## [1.0.8] - 2026-01-31

### Added
- Torrent metadata display (file list, size, piece info)
- Improved settings UX

### Changed
- Simplified adaptive batching for better performance
- Increased disk worker throughput

## [1.0.6]

### Added
- Background service with lazy engine startup
- Torrent summary cache for faster app launch
- Engine status indicator in UI

### Changed
- Improved app lifecycle and service management
- Better TCP socket performance

## [1.0.5]

### Added
- Batch verified writes for reduced FFI overhead
- Zero-copy PIECE message handling

### Fixed
- Binary data encoding between JS engine and Kotlin

## [1.0.4]

### Added
- NIO-based TCP implementation
- Pooled file handles for better I/O

### Changed
- Improved tick loop timing and metrics

## [1.0.3]

### Added
- Initial Play Store release
- BitTorrent v1 and v2 support
- Magnet link handling
- DHT, PEX, and tracker support
