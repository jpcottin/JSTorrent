# Changelog

All notable changes to the @jstorrent/engine package are documented here.

## [Unreleased]

## [1.0.1] - 2026-02-04

### Fixed
- Include CLI build script in package (fixes npm build)

## [1.0.0] - 2026-02-04

### Changed
- Improved README with CLI and library usage documentation
- CLI now bundled with esbuild for reliable Node.js ESM execution

## [0.1.0] - 2026-02-04

### Added
- Initial npm release
- Node.js CLI: `jstorrent "magnet:?..." --download-path ./downloads`
- Full BitTorrent protocol implementation (BEP 3, 5, 6, 9, 10, 23, 29)
- DHT support for peer discovery
- Tracker support (HTTP, HTTPS, UDP)
- Message Stream Encryption (MSE/PE)
- SOCKS5 proxy support with UDP
- Session persistence for resume capability
- Multi-file torrent support

<!-- Template for new releases:
## [x.x.x] - YYYY-MM-DD

### Added
- New features

### Changed
- Changes to existing features

### Fixed
- Bug fixes
-->
