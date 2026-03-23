# iOS Changelog

All notable changes to the iOS app are documented here.

## [1.0.7]

### Changed
- Fix CI: repurpose versions in any non-terminal state (cancel active submissions first)

## [1.0.6]

### Changed
- Fix CI: handle all ASC submission states (READY_FOR_REVIEW cleanup, version repurposing, build wait)

## [1.0.5]

### Changed
- Fix CI: cancel stale review submissions before creating new ones (concurrent limit fix)

## [1.0.4]

### Changed
- Fix CI: wait for newly uploaded build to appear in ASC before creating version

## [1.0.3]

### Changed
- Fix CI ADP fetch: use Admin API key, handle version conflicts, bump notarization timeout to 90 min

## [1.0.2]

### Changed
- Automated AltStore PAL notarization and ADP fetch in CI

## [1.0.1]

### Added
- File selection and priority editing UI
- Free disk space display
- Async boundary-piece writes for improved I/O performance

### Fixed
- Invalid torrent URL input now shows a friendly error
- Live updates for torrent detail tabs
- Pieces tab refresh and rendering
- File opening uses system handoff correctly
- Header title layout
- Flaky interval test in CI

### Changed
- Localization updates

## [1.0.0]

### Added
- Initial AltStore PAL release
- BitTorrent v1 and v2 protocol support
- Magnet link and .torrent file handling
- DHT, PEX, and tracker support
- Native SwiftUI UI with torrent list, detail, and settings screens
- JavaScriptCore engine with native TCP/UDP bindings via Network.framework
- File sharing and document picker integration
- Torrent search with Internet Archive plugin
- Session persistence across app restarts
- File priority selection
- Localization (18 languages)
