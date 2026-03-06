# Streaming UI — Vision & Phase 1

See also: [on-demand-streaming.md](on-demand-streaming.md) for the technical architecture (Source interface, abort/cancellation flow, keyframe index extraction, segment request flow).

## Vision

JSTorrent streaming has two faces:

### 1. Power User (embedded player)

Click a video file in the Files tab → full-screen overlay covers the torrent UI, pauses the render loop. Close button returns to normal view. Same page, same JS context, engine calls are direct function calls.

### 2. Casual User (standalone web page)

Open `jstorrent.com/watch#xt=urn:btih:HASH&dn=Movie.mkv` → video player, nothing else. No torrent UI, no file lists, no peers. The page connects to the local daemon, adds the torrent, streams, and cleans up on tab close. The user never sees the word "torrent." Share button generates the same hash-fragment URL — magnet params stay client-side, never hit the server.

This is the primary marketing surface: "paste a magnet link and watch instantly."

### Discovery & Launch

The watch page needs to find the local daemon. This varies by browser:

- **Chrome**: Cross-origin fetch to `localhost:7800` works. Stream directly.
- **Safari**: Cross-origin localhost is blocked. Show "Open in JSTorrent" button → `jstorrent://watch#...` custom protocol link → Tauri app launches daemon → opens `localhost:7800/watch#...` in system browser (same-origin, works everywhere).
- **No daemon found**: Install CTA (extension, desktop app, or Android app depending on platform).

The daemon can also serve the player page itself at `localhost:7800/watch` for offline use and to avoid CORS entirely. `jstorrent.com/watch` is the shareable entry point that redirects there when possible.

### Cleanup Behavior

When the watch page is the entry point (not the extension), the torrent is ephemeral:
- Added on page load, starts downloading immediately
- Removed with data on tab close
- No persistence, no session, no UI for managing it

---

## Library Split: playsvideo + @jstorrent/player

### playsvideo (library, published to npm)

Playsvideo is restructured from a web app into a library + app. The library handles everything video: container parsing, segment planning, hls.js integration, audio transcoding. It accepts a Source (the mediabunny abstraction for byte-level reads) and a `<video>` element.

```typescript
import { PlaysVideoEngine } from 'playsvideo'

const engine = new PlaysVideoEngine(videoElement, source)
await engine.load()    // parse container, build segment plan, start playback
engine.destroy()       // cleanup
```

The Source interface (see [on-demand-streaming.md § Source Interface](on-demand-streaming.md#source-interface) for full details):

```typescript
_read(start, end, signal?: AbortSignal) → ReadResult | Promise<ReadResult> | null
```

- `ReadResult` — data available synchronously
- `Promise<ReadResult>` — data coming (e.g., torrent pieces being downloaded)
- `null` — data cannot be obtained

Playsvideo doesn't know where bytes come from. The Source is the only integration point.

### Abort/Cancellation

Detailed in [on-demand-streaming.md § Abort/Cancellation](on-demand-streaming.md#abortcancellation). Summary:

- `AbortSignal` flows from hls.js fLoader → playsvideo segment processing → Source `_read()`
- TorrentSource listens on the signal to deprioritize pieces and reject pending promises
- Demux/transcode are fast — let them finish, discard results if aborted
- playsvideo owns the signal lifecycle; jstorrent's Source reacts to it

### @jstorrent/player (JSTorrent package)

Thin integration layer. Creates a TorrentSource, passes it to PlaysVideoEngine, owns the torrent-aware loading UI.

```
@jstorrent/player
  ├── playsvideo          (video pipeline — Source in, playback out)
  └── @jstorrent/engine   (Torrent type, waitForPieces, readFileBytes, etc.)
```

**TorrentSource** (`_read`): prioritizes pieces, returns a Promise that resolves when pieces arrive. Listens on AbortSignal to deprioritize and reject on seek. See [on-demand-streaming.md](on-demand-streaming.md#abortcancellation) for the implementation sketch.

**Loading UI**: JSTorrent watches torrent stats directly (peers, speed, piece availability) to show connecting/buffering/ready states. This is torrent-specific UX that doesn't belong in playsvideo.

**Dependency graph:**

```
@jstorrent/player
  ├── @jstorrent/engine   (piece-level primitives)
  └── playsvideo           (video pipeline)

@jstorrent/client
  └── @jstorrent/player    (mounts the overlay)

jstorrent.com/watch (future)
  └── @jstorrent/player    (standalone, no client needed)
```

The engine has no video dependencies. Android never imports the player package (no MSE). The watch page imports the player directly without the full client.

---

## Streaming RPC Protocol

Three messages. Transport-agnostic — works as direct calls, postMessage, WebSocket, or HTTP.

### `open(torrentHash, fileIndex, onProgress?) → StreamInfo`

Adds the torrent (if needed), prioritizes container index pieces, waits for them, parses container, builds keyframe index, generates HLS playlist.

**Progress callback** (optional, for loading UI):
```typescript
onProgress({
  phase: 'metadata' | 'ready',
  piecesNeeded: number,
  piecesHave: number,
  bytesNeeded: number,
  downloadSpeed: number,   // bytes/sec
  eta: number | null,      // seconds, null if speed is 0
  peers: number,
})
```

UI maps this to:
- `peers === 0` → "No peers available"
- `speed === 0 && peers > 0` → "Connecting..."
- `eta !== null` → "Ready in ~3s" with progress bar
- `phase === 'ready'` → start playback

**Returns:**
```typescript
{ streamId: string, duration: number, playlist: string /* m3u8 */ }
```

### `segment(streamId, segmentIndex, abortSignal?) → Uint8Array`

Called by hls.js fLoader. Prioritizes the required pieces, waits for them, reads bytes via playsvideo's segment processing, returns fMP4 segment.

Abort signal propagates: seek → hls.js aborts in-flight loader → signal cancels `waitForPieces` → priority window shifts to new playhead position.

### `close(streamId) → void`

Clears streaming piece priorities, tears down PlaysVideoEngine. If ephemeral (watch page), removes torrent and deletes data.

### HTTP Mapping (for daemon)

| RPC | HTTP |
|-----|------|
| `open` | `POST /stream/open` |
| `segment` | `GET /stream/{id}/segment/{n}` |
| `close` | `DELETE /stream/{id}` |

Progress delivered via SSE on the open request, final response is the StreamInfo JSON.

---

## Phase 1: Embedded Overlay Player

Get streaming working inside the existing UI page. Full-screen overlay, no new windows or web pages.

### What We Build

1. **`packages/player/` package** — new workspace package. Depends on `playsvideo` and `@jstorrent/engine`.

2. **TorrentSource** — mediabunny Source backed by torrent pieces. Returns data for available pieces, null for missing. Already exists at `packages/engine/src/streaming/torrent-source.ts`.

3. **StreamingSession** — orchestrates the flow: create TorrentSource, ensure pieces are available (waitForPieces + setStreamingPieces), create PlaysVideoEngine with Source, manage lifecycle. Implements `open`/`segment`/`close`.

4. **StreamingRPC interface** — the three-method contract. Phase 1 implementation calls StreamingSession directly (same JS context). Future implementations wrap postMessage, WebSocket, or HTTP.

5. **Player overlay component** — mounts over the torrent UI. Contains `<video>` element wired to PlaysVideoEngine. Loading state driven by `onProgress` watching torrent stats. Close button tears down everything.

6. **Render loop pause** — when overlay is active, pause the throttled RAF loop and stats intervals. Resume on close.

### What We Skip (for now)

- Watch web page (`jstorrent.com/watch`)
- Daemon HTTP streaming endpoints
- Pop-out windows
- Custom protocol handler (`jstorrent://`)
- Safari/cross-browser discovery
- Share button
- Audio transcoding (ffmpeg.wasm) — play files with browser-native codecs first

### Verification

```bash
pnpm run typecheck && pnpm run test && pnpm run lint
```
