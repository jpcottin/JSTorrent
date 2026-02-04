# Desktop Changelog

All notable changes to the desktop native host components are documented here.

## [1.0.1] - 2026-02-04

- No functional changes from 1.0.0 (re-release due to CI issue)

## [1.0.0] - 2026-02-04

### Added
- File truncation support for sparse file handling

### Changed
- Improved error handling in file operations

## [0.1.12] - 2026-02-04

### Added
- Standalone daemon mode for ChromeOS companion app
- SHA1 batch hashing endpoint for improved performance
- Routing hasher with worker thread support
- SAF file handle pooling
- Daemon stats endpoint
- BEP 6/21 (Fast Extension) protocol support

### Changed
- Improved hasher interface with batching support
- Allow /control WebSocket without HTTP auth in standalone mode

### Fixed
- CORS issue on production sites
- Standalone daemon pairing and token handling
- HTTP client error handling improvements

## [0.1.11] - 2026-02-04

### Added
- Initial changelog

## [Unreleased]

<!-- Template for new releases:
## [x.x.x] - YYYY-MM-DD

### Added
- New features

### Changed
- Changes to existing features

### Fixed
- Bug fixes
-->
