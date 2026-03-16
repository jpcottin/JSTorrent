# File Selection Modal

## Overview

When a user adds a torrent (magnet or .torrent file), optionally show a modal that lets them choose which files to download and where to save them before any file data is transferred. This doubles as an onboarding improvement: the modal requires a download location to be set before proceeding, eliminating the current error state when no storage root is configured.

## Motivation

- Users with large torrents often only want specific files
- Current flow lets users start torrents without a download location configured, leading to confusing error states
- Other clients (qBittorrent, Transmission) provide this as a standard feature

## User-Facing Behavior

### Setting

"Show file selection when adding torrents" — stored in user preferences.

Options:
- **Always** (default for new users) — show for every torrent added
- **Never** — current behavior, add and start immediately

### Modal Layout

Top to bottom:

1. **Torrent name** — from magnet `dn=` parameter, .torrent file name, or info hash
2. **Download location** — dropdown of configured storage roots. Each shows free disk space. If none configured, shows a prompt to add one. **Download button disabled until a location is selected.**
3. **File tree** — hierarchical with checkboxes per file and folder-level aggregation. Shows file sizes. If metadata not yet available (magnet), shows a spinner in this area.
4. **Summary bar** — "X files selected, Y GB" vs "Z GB free on selected location". Warning color if selected > free.
5. **Actions:**
   - **Download** — set file priorities from selection, set download location, transition to active. Disabled until location is set (and at least one file selected, if metadata available).
   - **Download All** — skip file selection, download everything to selected location. Available even while metadata is loading. For magnets where metadata hasn't arrived, torrent proceeds and downloads all files once metadata arrives.
   - **Cancel** — remove the torrent entirely.

### "Don't show again" checkbox

In the modal. Flips the global setting to "Never".

### Multiple Torrents

One modal rendered at a time. The queue is derived from all torrents in `awaitingFileSelection` state, ordered by `addedAt` timestamp. Dismissing/confirming the current modal reveals the next one (if any). Queued torrents are visible in the main torrent list with a distinct visual state.

### .torrent Files vs Magnets

Same flow for both. The only difference is whether the file tree is available immediately (.torrent — metadata parsed locally, essentially instant) or after a wait (magnet — metadata fetched from peers via BEP 9).

## Engine Changes

### New Persisted State

Add `awaitingFileSelection: boolean` to `TorrentPersistedState`. Default `false`.

When `true`:
- Torrent is active in the network (connects to peers, fetches metadata via BEP 9)
- All files are implicitly skipped — no piece data is requested
- Distinct from "user skipped all files" — this is a transient pre-download state

### addTorrent() Option

`addTorrent(input, { awaitSelection: true })` — creates the torrent in `awaitingFileSelection` state.

### New Methods on Torrent / Engine

- `confirmFileSelection(infoHash, { rootKey, fileIndices })` — sets the download location, sets selected files to normal priority (rest stay skipped), clears `awaitingFileSelection`, starts downloading.
- `confirmAllFiles(infoHash, { rootKey })` — sets the download location, clears `awaitingFileSelection`, un-skips all files, starts downloading. Works even before metadata arrives (torrent will download everything once metadata is available).
- `cancelAwaitingTorrent(infoHash)` — removes the torrent entirely.

### Metadata Event

When metadata is received for a torrent with `awaitingFileSelection: true`, the engine emits an event (e.g., `'metadata-ready'`) but does NOT auto-start piece downloads. The UI listens for this to populate the file tree in the modal.

### Persistence / Restart

On app restart, torrents with `awaitingFileSelection: true` restore into that state. The UI rebuilds the modal queue from persisted state.

## Client / Adapter Changes

- `addTorrent()` passes `awaitSelection` based on user setting
- New adapter methods: `confirmFileSelection()`, `confirmAllFiles()`, `cancelAwaitingTorrent()`
- Adapter exposes file list and metadata status for awaiting torrents
- Adapter exposes storage roots with free disk space (requires new `IFileSystem.getFreeDiskSpace()` — can be added later, show roots without free space initially)

## Free Disk Space (Future Enhancement)

Adding `getFreeDiskSpace(path): Promise<number>` to `IFileSystem` requires implementation across all backends (Node, daemon, native, memory, null, iOS). Not required for v1 of this feature — the modal can show storage roots without free space initially, and free space display can be added incrementally.

## Platform Notes

### Extension / Tauri (daemon backend)

Modal is part of the extension UI (React). File selection calls go through the existing daemon adapter.

### Android (native, standalone mode)

Android has its own native Compose UI. The file selection flow would need a native equivalent — a Compose screen/dialog with the same behavior. Engine changes are shared since the same TypeScript engine runs in QuickJS.

### iOS

Same as Android — native SwiftUI equivalent needed. Engine changes shared via JavaScriptCore.

### Node CLI

Not applicable for modal UI. The `addTorrent()` option exists but CLI users would use magnet `so=` parameter or a future `--select-files` flag.

## Implementation Order

1. Engine: `awaitingFileSelection` state, `addTorrent({ awaitSelection })`, confirm/cancel methods
2. Client adapter: wire up new methods
3. UI (extension/Tauri): modal component, setting, queue rendering
4. Free disk space: `IFileSystem.getFreeDiskSpace()` across all backends, surface in modal
5. Android native UI: Compose dialog equivalent
6. iOS native UI: SwiftUI sheet equivalent
