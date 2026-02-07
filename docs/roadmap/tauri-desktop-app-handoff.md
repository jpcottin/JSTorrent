# Tauri Desktop App — Handoff

**Date:** 2026-02-07
**Status:** Scaffold complete, sidecar working, ready for engine + UI integration

---

## What's Done

### App Shell
- Tauri v2.10 app at `desktop/tauri-app/`
- React 18 + Vite 7 frontend
- Joins the `desktop/` Cargo workspace
- Added to `pnpm-workspace.yaml`

### Sidecar
- io-daemon launches as a Tauri sidecar on app startup
- Port discovery: io-daemon prints port to stdout, Rust backend captures it
- Auth: UUID token generated per session, passed as CLI arg
- `get_daemon_info` Tauri command exposes `{ port, token, host }` to frontend
- Frontend polls until daemon is ready, shows connection status

### Dev Workflow
- `pnpm tauri dev` — builds io-daemon, starts Vite + Tauri
- `pnpm tauri build --no-bundle` — production build
- `scripts/prepare-sidecar.sh` — builds io-daemon and copies to both:
  - `src-tauri/binaries/` (for `tauri build` bundling, with target triple suffix)
  - `target/debug/binaries/` (for `tauri dev` runtime, no suffix)

### File Layout
```
desktop/tauri-app/
├── package.json              # @jstorrent/desktop-app
├── index.html
├── vite.config.ts
├── tsconfig.json
├── tsconfig.node.json
├── scripts/
│   └── prepare-sidecar.sh   # Builds + copies io-daemon binary
├── src/
│   ├── main.tsx              # React root
│   ├── App.tsx               # Shows daemon connection status
│   └── vite-env.d.ts
└── src-tauri/
    ├── Cargo.toml            # tauri 2, shell plugin, uuid, tokio
    ├── build.rs
    ├── tauri.conf.json       # Window config, sidecar, build commands
    ├── capabilities/default.json
    ├── src/
    │   ├── lib.rs            # Sidecar spawn, DaemonInfo state, get_daemon_info command
    │   └── main.rs
    ├── icons/                # Placeholder icons
    └── binaries/             # gitignored — sidecar binary placed here by prepare-sidecar.sh
```

---

## Next Steps

### 1. Wire Engine into Frontend

**Goal:** Create the BtEngine instance using `createDaemonEngine()` and get it running in the webview.

- Add `@jstorrent/engine` as a workspace dependency in `package.json`
- After `get_daemon_info` returns, call:
  ```typescript
  import { createDaemonEngine, MemorySessionStore } from '@jstorrent/engine'

  const engine = await createDaemonEngine({
    daemon: { port: info.port, authToken: info.token, host: info.host },
    contentRoots: [{ key: 'default', path: downloadPath, diskId: 'local' }],
    sessionStore: new MemorySessionStore(),
  })
  ```
- The engine connects to io-daemon via WebSocket (`ws://127.0.0.1:{port}/io`)
- Need to figure out `contentRoots` — either hardcode a default download path, or add a folder picker (Tauri has `@tauri-apps/plugin-dialog`)

### 2. Wire UI Components

**Goal:** Replace the placeholder with the actual JSTorrent UI.

- Add `@jstorrent/ui` as a workspace dependency
- Import and render the torrent table, detail pane, etc.
- The UI components expect an engine instance — pass it via React context or props
- Check if all `@jstorrent/ui` peer dependencies are met (React 18, solid-js, uplot)

### 3. Download Folder Picker

**Goal:** Let users choose where to save files.

- Add `@tauri-apps/plugin-dialog` for native folder picker
- Add a Tauri command to register download roots with io-daemon (POST to `/control/add-root`)
- Persist chosen roots (Tauri `plugin-store` or `localStorage`)

### 4. Session Persistence

**Goal:** Remember torrents across app restarts.

- Switch from `MemorySessionStore` to `LocalStorageSessionStore` (webview has `localStorage`)
- Or implement a file-based session store using Tauri's `plugin-fs`

### 5. Tray Icon

**Goal:** Minimize to tray, show download status.

- Tauri has built-in tray support via `tao`
- Add tray icon with context menu (show/hide, quit)
- Show active download count or speed in tooltip

### 6. Deep Links (Magnet)

**Goal:** Handle `magnet:` links and `jstorrent://` protocol.

- Add `@tauri-apps/plugin-deep-link`
- Register `magnet:` URI scheme in `tauri.conf.json`
- On deep link event, add torrent to engine

### 7. Auto-Update

**Goal:** Update app via GitHub Releases.

- Add `@tauri-apps/plugin-updater`
- Configure update endpoint in `tauri.conf.json` (points to GitHub Releases)
- Tauri handles signature verification, download, and restart

### 8. CI/CD

**Goal:** Automated builds for all platforms.

- GitHub Actions workflow: matrix build for macOS (arm64 + x86_64), Windows, Linux
- Code signing: macOS (already have Apple Developer cert), Windows (Azure Trusted Signing)
- Upload to GitHub Releases on tag push (`desktop-app-v*`)

### 9. App Icons

**Goal:** Replace placeholder Tauri icons with JSTorrent branding.

- Generate icon set from source image using `pnpm tauri icon <source.png>`
- Replaces all files in `src-tauri/icons/`

---

## Key Design Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| I/O approach | Sidecar (Option A) | Fastest path, reuses existing daemon adapter |
| React version | 18 | Matches extension UI |
| Sidecar binary placement | Separate for dev vs build | Tauri resolves relative to exe at runtime |
| State management | Tauri managed state | Clean, type-safe, accessible from commands |

## Reference Repos
- `~/code/tauri` — Tauri framework source + examples
- `~/code/tauri-plugins` — Official plugins (shell, dialog, store, updater, deep-link)
