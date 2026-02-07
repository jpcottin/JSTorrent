<img src="extension/public/icons/js-128.png" alt="JSTorrent" width="64" align="left" style="margin-right: 16px;">

# JSTorrent

A modern, full-featured BitTorrent client built on a shared TypeScript engine that runs everywhere.

**[Chrome Web Store](https://chromewebstore.google.com/detail/jstorrent/dbokmlpefliilbjldladbimlcfgbolhk)** | **[Desktop App](https://github.com/kzahel/JSTorrent/releases)** | **[new.jstorrent.com](https://new.jstorrent.com)**

## Platforms

| Platform | Status | Notes |
|----------|--------|-------|
| **Desktop App** | 🚧 Coming soon | Standalone app for macOS, Windows, and Linux (Tauri) |
| **Chrome Extension** | ✅ Available | Chrome, Edge, Brave, and other Chromium browsers |
| **Android** | ✅ Available | Native app with QuickJS engine |
| **ChromeOS** | ✅ Available | Extension + Android companion app |
| **iOS** | 🚧 Planned | Sideload only |

## Architecture

One TypeScript BitTorrent engine powers all platforms. Platform-specific native code handles networking and disk I/O, while the core protocol logic remains shared and tested across environments.

## Features

### BitTorrent Protocol
- ✅ Full BitTorrent protocol implementation
- ✅ Magnet link support
- ✅ .torrent file support
- ✅ Protocol encryption (MSE/PE)
- ✅ Seeding and leeching
- ✅ Tit-for-tat choking algorithm
- ✅ Optimistic unchoking
- ✅ Rarest-first piece selection
- ✅ Endgame mode
- ✅ Request pipelining
- ✅ SHA1 piece verification
- ✅ Fast extension (BEP 6)
- ✅ Extension protocol (BEP 10)
- ✅ Metadata exchange / magnet resolution (BEP 9)

### Networking
- ✅ UPnP port mapping
- ✅ DHT (Distributed Hash Table)
- ✅ PEX (Peer Exchange)
- ✅ UDP and HTTP trackers
- ✅ IPv4 and IPv6

### Performance
- ✅ Native host for fast networking and disk I/O
- ✅ File skipping and priorities
- ✅ Bandwidth throttling
- ✅ Connection limits

### User Experience
- ✅ Traditional torrent client UI
- ✅ Customizable interface
- ✅ Super responsive
- ✅ Dark mode
- ✅ Drag and drop torrents
- ✅ Click magnet links to add
- ✅ Per-torrent and global statistics

## About

JSTorrent started as a Chrome App, was rebuilt as a Chrome Extension when Apps were deprecated, and has since expanded to Android and desktop platforms—all sharing the same TypeScript engine.

Written in TypeScript with comprehensive test coverage, including integration tests against libtorrent.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for build instructions and project structure.

## License

MIT
