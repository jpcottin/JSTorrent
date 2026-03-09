# Popup Byte-Range Session Refactor

See also:
- [torrent-file-http-serving.md](torrent-file-http-serving.md) - HTTP serving modes and proposed control-plane additions
- [on-demand-streaming.md](on-demand-streaming.md) - current JS streaming pipeline context
- [streaming-ui-vision.md](streaming-ui-vision.md) - current player/watch UX direction
- [android-native-streaming-player-mvp.md](android-native-streaming-player-mvp.md) - Android-native playback boundary and byte-source direction

## Purpose

Sketch a refactor plan for the popup watch-player transport so the future playback/session boundary becomes byte-range-based and torrent-unaware, while still preserving torrent-specific diagnostics like piece visualization.

This is meant as a review document for another agent before implementation work starts.

## Why This Refactor Is Worth Doing

Today the popup player transport is still engine-shaped rather than consumer-shaped.

Current popup boundary:

- `waitForPieces(pieceIndices)`
- `setStreamingPieces(Set<piece>)`
- `updateStreamingDemand(token, Set<piece>, urgency)`
- `fileBytesToPieces(offset, length)`
- `readFileBytes(offset, length)`

Relevant files:

- [packages/client/src/utils/video-popup-session.ts](/Users/kgraehl/code/jstorrent/packages/client/src/utils/video-popup-session.ts)
- [packages/client/src/components/VideoPopupPage.tsx](/Users/kgraehl/code/jstorrent/packages/client/src/components/VideoPopupPage.tsx)
- [packages/client/src/AppContent.tsx](/Users/kgraehl/code/jstorrent/packages/client/src/AppContent.tsx)
- [packages/engine/src/streaming/streaming-file-provider.ts](/Users/kgraehl/code/jstorrent/packages/engine/src/streaming/streaming-file-provider.ts)
- [packages/engine/src/streaming/streaming-playback-session.ts](/Users/kgraehl/code/jstorrent/packages/engine/src/streaming/streaming-playback-session.ts)

That shape works for an in-process popup, but it is not the right long-term transport contract for:

- daemon-backed blocking `206`
- future control-WebSocket daemon <-> engine RPC
- any non-popup consumer that just wants file bytes

The consumer should not need to understand torrent pieces. The engine/session layer should own:

- byte range -> piece mapping
- `waitForPieces`
- demand / file lock tokens
- abort and cleanup policy

This matches the architectural guidance already captured in [torrent-file-http-serving.md](torrent-file-http-serving.md): keep torrent semantics in the engine, keep transport boundaries byte-oriented, and treat piece state as diagnostics rather than the operational API.

This refactor should focus on the future session boundary first, not on rename-only cleanup. Naming cleanup can happen later once the new boundary exists and real call sites can migrate to it.

## Problem Statement

We want two different surfaces:

1. Core playback/session interface
- byte-range based
- torrent-unaware
- suitable for popup playback and future daemon RPC

2. Optional diagnostics/visualization interface
- torrent-aware
- piece snapshots and similar metadata for UI/debugging

The refactor should make those two surfaces explicit instead of mixing them together in the popup transport.

## Current Shape

### Popup launch contract

The popup is currently launched with:

- `sessionId`
- `fileName`
- `fileSize`
- `fileOffset`
- `pieceLength`

Relevant files:

- [packages/client/src/host/types.ts](/Users/kgraehl/code/jstorrent/packages/client/src/host/types.ts)
- [packages/client/src/components/VideoPopupPage.tsx](/Users/kgraehl/code/jstorrent/packages/client/src/components/VideoPopupPage.tsx)
- [extension/src/sw.ts](/Users/kgraehl/code/jstorrent/extension/src/sw.ts)

The presence of `fileOffset` and `pieceLength` in the popup descriptor is the clearest sign that the popup-side transport boundary is leaking torrent internals.

### Popup transport contract

In [video-popup-session.ts](/Users/kgraehl/code/jstorrent/packages/client/src/utils/video-popup-session.ts):

- host -> popup messages include:
  - `setStreamingPieces`
  - `updateStreamingFileLock`
  - `updateStreamingDemand`
  - `call`
  - `abort`
  - `close`
- popup -> host messages include:
  - `result`
  - `error`
  - `closing`

RPC methods currently include:

- `waitForPieces`
- `readFileBytes`
- `buildPrebuiltKeyframeIndex`
- `getPieceTimelineSnapshot`

### Engine/session internals

The right torrent-aware logic is already concentrated lower in the stack:

- [packages/engine/src/streaming/streaming-playback-session.ts](/Users/kgraehl/code/jstorrent/packages/engine/src/streaming/streaming-playback-session.ts)
- [packages/engine/src/streaming/streaming-file-provider.ts](/Users/kgraehl/code/jstorrent/packages/engine/src/streaming/streaming-file-provider.ts)
- [packages/engine/src/core/torrent.ts](/Users/kgraehl/code/jstorrent/packages/engine/src/core/torrent.ts)

That is a good place for:

- piece mapping
- wait policy
- demand windows
- lock lifecycle

It is not a good idea to spread those concerns outward into popup transport, daemon transport, and UI-facing contracts separately.

The current name also contributes to the confusion. `StreamingFileProvider` sounds like the generic playback abstraction, but in practice it is the torrent-backed, piece-aware adapter. That is a real naming issue, but it should be treated as follow-up cleanup after the new byte-range session boundary exists.

## Target Shape

### Core interface

Introduce a narrower byte-range-oriented session interface for consumers:

```ts
interface ByteRangeStreamingSession {
  readonly fileSize: number
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>
  waitForRange(offset: number, length: number, signal?: AbortSignal): Promise<void>
  setHint(
    hintId: string,
    offset: number,
    length: number,
    urgency: 'metadata' | 'next' | 'now',
  ): void
  clearHint(hintId: string): void
  close(): void
}
```

Notes:

- `read()` is the essential operation.
- `waitForRange()` exists for daemon/control-plane parity even if popup mostly relies on blocking `read()`.
- hints need stable IDs and explicit clearing so seek-driven demand can be updated or canceled cleanly.
- `close()` is explicit session cleanup.

### Naming

Proposed names:

- keep `StreamingPlaybackSession` if it becomes the byte-range session implementation
- introduce a transport-facing name like `ByteRangeStreamingSession` for the consumer contract
- defer rename-only cleanup of lower-level torrent-facing types until after the new session boundary exists

This gives a cleaner split:

- existing torrent-facing provider types = low-level torrent primitives
- `ByteRangeStreamingSession` = consumer-facing byte-range API
- `StreamingVisualization` = optional diagnostics

### Diagnostics interface

Keep torrent-aware visualization as an auxiliary surface:

```ts
interface StreamingVisualization {
  getPieceTimelineSnapshot?(): Promise<StreamingFilePieceSnapshot | null>
  buildPrebuiltKeyframeIndex?(): Promise<PrebuiltKeyframeIndex | null>
}
```

This keeps piece visualization available without making piece-level operations part of the core transport contract.

### Popup launch contract after refactor

The popup launch descriptor should shrink toward:

- `sessionId`
- `fileName`
- `fileSize`

Potentially nothing else is required once the popup talks only to a byte-range session.

That means `fileOffset` and `pieceLength` should no longer be necessary in:

- [packages/client/src/host/types.ts](/Users/kgraehl/code/jstorrent/packages/client/src/host/types.ts)
- [packages/client/src/components/VideoPopupPage.tsx](/Users/kgraehl/code/jstorrent/packages/client/src/components/VideoPopupPage.tsx)
- [extension/src/sw.ts](/Users/kgraehl/code/jstorrent/extension/src/sw.ts)

## Mapping From Current API To Target API

Current popup-facing operations:

- `waitForPieces(pieceIndices)`
- `setStreamingPieces(Set<piece>)`
- `updateStreamingDemand(token, Set<piece>, urgency)`
- `updateStreamingFileLock(token, enabled)`
- `readFileBytes(offset, length)`

Target popup-facing operations:

- `waitForRange(offset, length)`
- `setHint(hintId, offset, length, urgency)`
- `clearHint(hintId)`
- `read(offset, length)`
- `close`

Internal translation should happen inside the engine/session implementation:

- `waitForRange(offset, length)` ->
  `fileBytesToPieces(offset, length)` ->
  `waitForPieces(pieceIndices)`

- `setHint(hintId, offset, length, urgency)` ->
  `fileBytesToPieces(offset, length)` ->
  `updateStreamingDemand(tokenForHintId, pieces, urgency)`

- `clearHint(hintId)` ->
  `updateStreamingDemand(tokenForHintId, null, 'now')`

- `close()` ->
  clear hint tokens + clear read-scoped demand + release file lock + abort outstanding waits

That keeps the transport byte-based while preserving the current torrent-aware behavior under the hood.

## Recommended Refactor Order

### Phase 1: Extract the future engine-side session boundary

Goal:

- define the future byte-range session abstraction in the engine before changing popup transport

Changes:

- introduce `ByteRangeStreamingSession` above the existing torrent-facing provider layer
- implement it by adapting current `StreamingPlaybackSession` behavior rather than replacing that behavior
- keep range -> piece translation, file locks, demand windows, and abort cleanup inside the session implementation

Expected result:

- there is a concrete future-facing session object that popup and daemon transports can proxy directly

### Phase 2: Make streaming hints explicit in the session contract

Goal:

- preserve current demand behavior while making the future transport byte-oriented

Changes:

- add `setHint(hintId, offset, length, urgency)` and `clearHint(hintId)` to the session contract
- map each `hintId` to a stable internal demand token
- keep read-scoped demand separate from hint-scoped demand
- ensure `clearHint()` and `close()` immediately release hint demand

Validation concerns:

- replacing a hint with the same `hintId` should update, not accumulate
- seek-driven hint changes must not leave stale demand behind

### Phase 3: Add explicit range waiting to the session

Goal:

- support future control-plane parity without requiring piece-aware RPC

Changes:

- expose `waitForRange(offset, length, signal)` on the engine session
- implement it via byte-range -> piece mapping plus the existing wait behavior
- share abort semantics with blocking reads

Expected result:

- future daemon RPC can model `WAIT_FOR_RANGE` / `CANCEL_RANGE_WAIT` directly on the same session shape

### Phase 4: Refactor popup transport to proxy the session directly

Goal:

- make [video-popup-session.ts](/Users/kgraehl/code/jstorrent/packages/client/src/utils/video-popup-session.ts) proxy the future session contract rather than torrent primitives

Changes:

- host side proxies a `ByteRangeStreamingSession`, not a `StreamingFileProvider`
- popup RPC methods become `read`, `waitForRange`, `setHint`, `clearHint`, and `close`
- remove popup-side use of `fileBytesToPieces`
- keep diagnostics as optional extra RPC methods

Expected result:

- popup transport becomes the clean reference model for future daemon control RPC

### Phase 5: Cut popup playback to the new session contract

Goal:

- make the public popup boundary match the future architecture with a clean break

Changes:

- make popup playback consume the byte-range session transport directly
- remove `fileOffset` and `pieceLength` from popup launch/session inputs
- keep diagnostics optional so playback does not depend on torrent-aware metadata

Expected result:

- popup playback uses the future session boundary with no rollback path and no legacy transport retained

### Phase 6: Align daemon control-WebSocket design with the same contract

Goal:

- use the popup refactor as the model for the future blocking `206` control plane

After the popup refactor, the proposed control messages in [torrent-file-http-serving.md](torrent-file-http-serving.md) should conceptually align with:

- `REGISTER_STREAM_SESSION`
- `READ_RANGE`
- `WAIT_FOR_RANGE`
- `CANCEL_RANGE_WAIT`
- `SET_STREAM_HINT`
- `CLEAR_STREAM_HINT`
- `CLOSE_STREAM_SESSION`

At that point the daemon transport is not inventing a new model. It is reusing a byte-range session contract already proven in popup playback.

## Concrete Review Questions

These are the main questions another agent should review before implementation:

1. Should popup use only blocking `read()`, or should it also issue explicit `waitForRange()` calls for parity with the future daemon transport?

2. What hint IDs should the popup/session use in practice, for example stable IDs such as `metadata` and `next`?

3. Should `StreamingPlaybackSession` itself become the transport-facing session object, or should there be a thinner adapter exposing only the future contract?

4. Is `buildPrebuiltKeyframeIndex()` part of diagnostics, metadata, or a separate optional capability adjacent to the core session contract?

5. Are there any current `VideoPlayer` / `playsvideo` behaviors that still require transport-level control beyond `read`, `waitForRange`, and explicit hints?

## Risks

### Risk: losing current streaming demand behavior

The current popup path has working demand/lock semantics. A naive “just rename methods” refactor could accidentally simplify away behavior that matters for real playback.

Mitigation:

- preserve `StreamingPlaybackSession` behavior first
- extract the future session boundary before changing popup transport
- make hint lifecycle explicit rather than folding it into unnamed range updates

### Risk: interface churn without helping daemon work

If the refactor only renames popup methods but still leaks piece details indirectly, it will not actually help the control-WebSocket daemon design.

Mitigation:

- evaluate success by whether daemon RPC can be modeled directly on the new session boundary
- avoid rename-only cleanup that does not move the future transport shape forward

### Risk: over-designing the contract

It is easy to introduce too many abstractions before the daemon path needs them.

Mitigation:

- keep the target interface minimal
- expose only `read`, `waitForRange`, explicit hints, and `close`, plus optional diagnostics

## Suggested Success Criteria

This refactor is successful if:

- popup playback no longer requires `pieceLength` or `fileOffset` in its public launch/session boundary
- popup transport does not expose `waitForPieces()` or raw piece sets
- popup/session hinting uses explicit byte-range hints with stable IDs and clear cleanup
- piece visualization still works via an optional diagnostics path
- the resulting popup session contract is directly reusable as the conceptual model for daemon `READ_RANGE` / `WAIT_FOR_RANGE` / `CANCEL_RANGE_WAIT` / hint RPC

## Suggested First Implementation Slice

If another agent picks this up, the smallest useful first slice is:

1. Introduce a `ByteRangeStreamingSession` around the existing session behavior in the engine.
2. Add explicit `setHint()` / `clearHint()` semantics backed by stable internal demand tokens.
3. Add `waitForRange()` on that session.
4. Leave popup transport unchanged until the engine-side session contract is concrete.

That should be enough to prove the future boundary change without yet rewriting popup transport.

The next slice after that should be a clean popup cutover to the new session transport with no feature flag and no legacy transport retained.
