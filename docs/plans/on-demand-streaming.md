# On-Demand Video Streaming

Stream video from an in-progress torrent with instant seek, codec transcoding, and no HTTP server.

## Motivation

The legacy implementation (`jstorrent-legacy-app/gui/media.js`, `webhandlers.js`) ran an HTTP server inside the Chrome extension and pointed a `<video>` element at `/stream?hash=X&file=Y`. The browser made Range requests; jstorrent translated those into torrent piece priorities via a "bridge" pattern. This worked but had major limitations:

- **No codec control** — AC3, EAC3, DTS audio just failed with `MEDIA_ERR_NOT_SUPPORTED`
- **No segment awareness** — the browser's video element decided what to buffer and when
- **No keyframe index parsing** — relied on the browser to discover moov/Cues on its own
- **Hacky readiness detection** — counted `progress` events to 40 and assumed playback was working
- **Required an HTTP server** — `web-server-chrome` added complexity and Chrome extension constraints

## Architecture

### Pipeline

```
torrent pieces → mediabunny (demux) → ffmpeg.wasm (transcode if needed) → fMP4 segments → hls.js (fLoader) → MSE → <video>
```

This is the same pipeline as [playsvideo](https://playsvideo.com), with the torrent engine as the byte source instead of a local file.

### Key Components

- **hls.js with `fLoader`** — programmatic segment loading, no HTTP server or service worker needed. hls.js requests segments by index; our loader returns bytes directly from JavaScript.
- **mediabunny** — demuxes MP4 and MKV containers, produces encoded packets for remuxing into fMP4 segments.
- **ffmpeg.wasm (audio-only build, 1.5MB)** — transcodes AC3/EAC3/DTS/FLAC/etc. to AAC on the fly. Lazy-loaded only when the codec probe detects an unsupported audio codec.

### Safari / iOS Compatibility

- macOS Safari: MSE supported, hls.js + fLoader works.
- iOS 17+: MSE supported, same as desktop.
- iOS < 17: No MSE. Would require a service worker fallback (not planned — low priority).

## Keyframe Index Extraction

The first step in streaming is parsing the container's keyframe index so we can map seek positions to byte ranges and build a segment plan.

### Strategy: Always Download the First Torrent Piece

The first piece of the file is sufficient to bootstrap index discovery for all common formats.

### By Container Format

**MP4** (`.mp4`, `.m4v`, `.mov`):
- Keyframe index lives in the `moov` atom (`stss` sync samples, `stco`/`co64` chunk offsets, `stsz` sample sizes).
- `moov` is at the beginning (fast-start) or end of the file.
- From the first piece, chain top-level box headers (`offset += size`) to locate `moov`. If `moov` is at the end, the `mdat` box's size tells you exactly where `moov` starts — pure arithmetic, no scanning.
- Edge case: `mdat` with `size=0` means "rest of file", implying `moov` must be before `mdat` (already in first piece).

**MKV / WebM** (`.mkv`, `.webm`):
- Keyframe index is the `Cues` element (maps timestamps → byte offsets of clusters).
- `Cues` are typically at the end of the file.
- The `SeekHead` element is always near the start (~first 1-4KB). It contains the exact byte offset and size of `Cues`.
- Parse SeekHead from first piece → compute which pieces contain Cues → prioritize those (usually 1 piece, Cues are ~20-30KB for a 2-hour movie).

**WebM is a subset of MKV** — same EBML container, same SeekHead/Cues structure, same code path.

### Moov/Cues Size Heuristics

| Format | Index element | Typical size (2hr movie) | Driven by |
|--------|--------------|-------------------------|-----------|
| MP4 | `moov` | 2-10 MB | Total frame count × tracks |
| MKV | `Cues` | 20-30 KB | Keyframe count only |

MP4 moov is larger because it indexes every frame (`stsz`), not just keyframes. MKV Cues only index keyframes (~one every 5 seconds).

### mediabunny Integration

mediabunny's `Reader` abstraction uses `requestSlice(start, length)` — it fetches data on demand, never reads the whole file. It returns `null` gracefully on missing data rather than throwing. This means:

- A custom `Source` backed by torrent piece availability works naturally.
- For MP4, mediabunny parses moov without ever touching mdat.
- For MKV, it can parse SeekHead and Cues from sparse byte ranges.
- Zero-filled gaps between downloaded regions cause the box parser to stop gracefully (`readBoxHeader` returns null, loop breaks).

## Segment Request Flow

1. Build segment list from keyframe index (Cues/moov → "segment N = keyframe at time T, byte range X-Y").
2. Generate in-memory HLS manifest with segment durations.
3. hls.js requests segments in playback order via `fLoader`.
4. On segment request:
   - Map segment to byte range → compute overlapping torrent pieces.
   - If pieces are downloaded → demux with mediabunny → transcode audio if needed → return fMP4 bytes.
   - If pieces are not downloaded → boost priority of those pieces in the torrent engine → resolve promise when they arrive.
5. On seek: hls.js calls `abort()` on in-flight loads → deprioritize those torrent pieces.

### Priority

Priority is implicit in hls.js call order. The oldest unresolved `fLoader` request is the most urgent (playhead needs it now). Subsequent requests are buffer-ahead. Aborted requests are no longer needed.

### Buffering

hls.js manages its own buffer-ahead target (~30s by default). It decides how far to prefetch. The torrent engine just needs to respond to piece priority changes.

## Formats Supported

For practical purposes, only two container formats matter for torrents:

| Format | Extensions | Prevalence |
|--------|-----------|------------|
| MKV | `.mkv`, `.webm` | ~90% of scene releases, fansubs |
| MP4 | `.mp4`, `.m4v`, `.mov` | Web-sourced, remuxes |

AVI (`.avi`) and FLV (`.flv`) are effectively dead for new content. TS (`.ts`) has no index at all (pure streaming format). None of these are planned.

## Implementation Steps

1. **Custom mediabunny Source** — torrent-piece-backed Source that returns data from downloaded pieces and null/promise for missing ranges.
2. **Keyframe index extractor** — parse moov (MP4) or SeekHead→Cues (MKV) from first piece + index pieces, return `{ time, byteOffset, size }[]`.
3. **Segment plan builder** — convert keyframe index to HLS segment list with durations.
4. **fLoader implementation** — bridge between hls.js segment requests and torrent piece priorities.
5. **Codec probe + transcode** — reuse playsvideo's `audioNeedsTranscode` and ffmpeg.wasm audio pipeline for AC3/EAC3/DTS.
6. **Player UI** — piece availability visualization (like the old green canvas bar), playhead, seek controls.
