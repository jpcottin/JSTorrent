# Sidecar Binary Resolution

The Tauri app bundles two sidecar binaries: `jstorrent-host` (system bridge) and
`jstorrent-io-daemon`. Getting the right binary to the right place is surprisingly
complex due to Tauri's naming conventions and the two-level resolution chain.

## Why the triple suffix exists

Tauri's `externalBin` system requires binaries in `src-tauri/binaries/` to be named
`{name}-{target-triple}` (e.g., `jstorrent-host-aarch64-apple-darwin`). This is how
Tauri knows which binary to bundle for each platform during cross-compilation.

## Resolution chain

The Tauri app doesn't launch the io-daemon directly. Instead:

1. **Tauri app** finds `jstorrent-host` via `resolve_sidecar()` in `lib.rs`
2. **jstorrent-host** finds `jstorrent-io-daemon` via `find_io_daemon_path()` in `daemon_manager.rs`

Each has its own search logic, creating two layers where things can go wrong.

## Binary locations by mode

### Dev mode (`pnpm tauri dev`)

`prepare-sidecar.sh` builds release binaries and copies them to:

| Location | Name | Purpose |
|----------|------|---------|
| `src-tauri/binaries/` | `*-{triple}` | Tauri bundler requirement |
| `target/debug/binaries/` | `*` (no triple) | Dev runtime |
| `target/debug/binaries/` | `*-{triple}` | Prevents stale shadowing (see below) |

`resolve_sidecar()` searches `resource_dir` (= `src-tauri/`) first, then `exe_dir`.
Within each dir it checks triple-suffixed first, then plain.

`find_io_daemon_path()` searches relative to the host binary's own directory,
checking triple-suffixed first, then plain.

### Production macOS (`install-local-tauri-macos.sh` / CI release)

Tauri bundles everything into `JSTorrent.app`. The host and io-daemon end up in
separate `.app` bundles installed to `~/Library/Application Support/JSTorrent/`:

```
JSTorrent Native Host.app/Contents/MacOS/jstorrent-host
JSTorrent IO.app/Contents/MacOS/jstorrent-io-daemon
```

`find_io_daemon_path()` detects the `.app/Contents/MacOS` path and uses the sibling
app bundle lookup. The triple search is **not used** on macOS production.

### Production Windows/Linux (NSIS / bundled)

Tauri places binaries in the install directory with triple suffix. `find_io_daemon_path()`
finds them via the triple-suffixed candidate.

## The stale binary trap

**What happened (Feb 2026):** A stale `jstorrent-io-daemon-aarch64-apple-darwin` in
`target/debug/binaries/` (from a previous build) shadowed the fresh
`jstorrent-io-daemon` because `find_io_daemon_path()` checks triple-suffixed first.
The stale binary had old CORS config that broke Tauri dev mode.

**Fix:** `prepare-sidecar.sh` now copies both triple-suffixed and plain names to
`target/debug/binaries/` so they always stay in sync.

**If you hit weird issues with stale binaries:** `rm -rf desktop/target/debug/binaries/`
and re-run `pnpm tauri dev` (which triggers `prepare-sidecar.sh`).
