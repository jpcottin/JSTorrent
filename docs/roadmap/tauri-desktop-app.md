# Tauri Desktop App (Standalone)

**Status:** Roadmap / Future
**Priority:** Nice-to-have
**Audience:** Desktop users who don't want Chrome or browser extensions

---

## Motivation

Current desktop distribution requires:
1. Chrome browser
2. Chrome extension installed
3. Native host + io-daemon installed

This is friction. Some users:
- Prefer Safari, Firefox, or other browsers
- Dislike browser extensions
- Want a "real app" experience

A Tauri-based standalone app would provide a single installer that "just works."

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Tauri Desktop App                     │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │          WebView (WebKit / WebView2)             │   │
│  │                                                   │   │
│  │   ┌─────────────────┐   ┌─────────────────────┐  │   │
│  │   │    React UI     │   │  @jstorrent/engine  │  │   │
│  │   │   (existing)    │◄──►  (TypeScript)       │  │   │
│  │   └─────────────────┘   └─────────────────────┘  │   │
│  │                                │                  │   │
│  └────────────────────────────────┼──────────────────┘   │
│                                   │ Tauri invoke()       │
│  ┌────────────────────────────────▼──────────────────┐   │
│  │               Rust Backend                         │   │
│  │                                                    │   │
│  │  ┌─────────────┐  ┌───────────┐  ┌────────────┐   │   │
│  │  │   Sockets   │  │   Files   │  │  Hashing   │   │   │
│  │  │ (TCP/UDP)   │  │  (read/   │  │  (SHA1)    │   │   │
│  │  │             │  │   write)  │  │            │   │   │
│  │  └─────────────┘  └───────────┘  └────────────┘   │   │
│  └────────────────────────────────────────────────────┘   │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Tauri Shell: tray icon, auto-update, deep links   │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Key Insight: No Node.js, No QuickJS

The Tauri webview **is** a JavaScript runtime (WebKit on Mac, WebView2 on Windows/Linux). The engine runs directly in the webview, just like it runs in the Chrome extension's service worker today.

This is simpler than:
- Node.js sidecar (50MB+ overhead)
- QuickJS (requires separate integration)

The webview gives us V8/JSC for free.

### I/O Binding Strategy

The engine needs four interfaces: sockets, files, hashing, session storage.

```typescript
// packages/engine/src/adapters/tauri/

// Instead of WebSocket to io-daemon, use Tauri invoke()
import { invoke } from '@tauri-apps/api/core';

class TauriSocketFactory implements ISocketFactory {
  async createTcpSocket(): Promise<ITcpSocket> {
    const id = await invoke('tcp_connect', { host, port });
    return new TauriTcpSocket(id);
  }
}

class TauriFileSystem implements IFileSystem {
  async open(rootKey: string, path: string): Promise<IFileHandle> {
    const handle = await invoke('file_open', { rootKey, path });
    return new TauriFileHandle(handle);
  }
}
```

The Rust backend implements the I/O commands. Much of this code already exists in `desktop/io-daemon/`.

---

## What Tauri Provides

| Feature | Benefit |
|---------|---------|
| Cross-platform webview | Same UI code works everywhere |
| Auto-updater | GitHub Releases integration, signature verification |
| Code signing | Unified workflow, just set env vars |
| System tray | Status icon, quick actions |
| Deep links | `jstorrent://` protocol handler |
| Native dialogs | File picker, notifications |
| Small binary | ~10-20MB (no Electron bloat) |

---

## Distribution

| Platform | Installer | Signing |
|----------|-----------|---------|
| macOS | `.dmg` | Apple Developer ($99/yr) - already have |
| Windows | `.msi` / `.exe` | Azure Trusted Signing - scaffolding exists |
| Linux | `.deb`, `.rpm`, `.AppImage` | None needed |

---

## What We Reuse

| Component | Source | Notes |
|-----------|--------|-------|
| React UI | `packages/ui/` | Same UI, different host |
| Engine | `packages/engine/` | New adapter for Tauri IPC |
| Rust I/O | `desktop/io-daemon/` | Adapt for Tauri commands |
| Signing infra | `desktop/windows_signing/` | Same Azure setup |

---

## What's New

1. **Tauri adapter** in `packages/engine/src/adapters/tauri/`
   - `TauriSocketFactory` - invoke() instead of WebSocket
   - `TauriFileSystem` - invoke() instead of HTTP
   - `TauriSessionStore` - use Tauri's store plugin or invoke()
   - `TauriHasher` - invoke() to Rust SHA1

2. **Tauri app shell** in `packages/desktop-app/` (new)
   - `src-tauri/` - Rust backend with I/O commands
   - Tray icon, auto-update config
   - Deep link registration

3. **CI workflow** for Tauri builds
   - Matrix build for macOS (arm64 + x86_64), Windows, Linux
   - Code signing integrated
   - GitHub Releases upload

---

## Migration Path from Current Desktop

The current extension + native host setup remains supported. The Tauri app is an **alternative** distribution for users who prefer standalone apps.

Eventually, could consolidate:
- Tauri app becomes the primary desktop distribution
- Extension remains for users who prefer it
- Native host becomes optional (only for extension users)

---

## Open Questions

- **Universal binary (macOS)?** Ship fat binary or separate arm64/x86_64?
- **Auto-update UX?** Prompt on tray click, or background download + restart?
- **Feature parity?** Does webview have all APIs the extension uses? (Likely yes, but verify)
- **Magnet handling?** Tauri can register URL protocols. When clicked, app launches and receives the magnet.

---

## Why Not Electron?

- 150MB+ overhead vs Tauri's ~20MB
- Chromium update burden
- Tauri uses system webview (WebKit on Mac is always up-to-date)

## Why Not Just the Current Setup?

- Requires Chrome
- Requires extension installation
- Requires native host installation
- Three separate pieces to install and keep updated

Tauri: one installer, one app, auto-updates.

---

## References

- [Tauri](https://tauri.app/) - Rust-based app framework
- [Tauri without bundled webview](https://github.com/nicokosi/tauri/blob/main/tooling/cli/docs/features/webview.md) - for headless mode if needed
- [yepanywhere desktop roadmap](https://github.com/kgraehl/yepanywhere/blob/main/docs/roadmap/desktop-app.md) - similar architecture (Node sidecar instead of webview engine)

---

## Estimated Effort

1. **Tauri adapter** - 1-2 weeks (new adapter, port io-daemon commands)
2. **Tauri app shell** - 1 week (tray, deep links, auto-update config)
3. **CI/CD** - 1 week (build matrix, signing, releases)
4. **Testing** - 1 week (all platforms, auto-update flow)

Total: ~4-6 weeks for MVP

Low priority since current desktop setup works, but a nice "v2" offering for broader appeal.
