# iOS Changelog

All notable changes to the iOS app are documented here.

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
