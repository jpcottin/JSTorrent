# Native Host Contract

This document defines the shared bootstrap contract for the desktop native-host
surface used by the browser extension and the Tauri desktop app.

It is the normative source for:

- native messaging handshake request/response shapes
- `DaemonInfo` bootstrap semantics
- `ProfileInUse` takeover semantics
- profile and KV isolation guarantees
- native-host conformance case IDs

Machine-readable companion:

- [native-host-conformance.json](/Users/kgraehl/code/jstorrent/contracts/native-host-conformance.json)

## Scope

This contract covers the desktop native-host bootstrap path, not the IO daemon
HTTP/WebSocket surface.

Desktop today has two distinct contracts:

- native-host bootstrap via native messaging `handshake -> DaemonInfo`
- IO daemon surface via `/io`, `/control`, and HTTP endpoints

The IO daemon contract is documented separately in
[io-daemon-contract.md](/Users/kgraehl/code/jstorrent/docs/contracts/io-daemon-contract.md).

## Transport

The native-host protocol runs over Chrome native messaging or an equivalent
stdin/stdout bridge.

Messages are:

- length-prefixed JSON
- request/response correlated by `id`
- tagged by operation name in the request and `type` in the response payload

## Handshake Request

Baseline handshake request:

```json
{
  "id": "req-1",
  "op": "handshake",
  "extensionId": "dbokmlpefliilbjldladbimlcfgbolhk"
}
```

Optional request fields:

- `profileId`
- `clientType`
- `clientVersion`
- legacy `installId`

Semantics:

- missing `profileId` creates a new profile
- present `profileId` requests reuse of that profile
- invalid `profileId` is recovered by creating a new profile

## DaemonInfo Response

Successful handshake returns:

```json
{
  "id": "req-1",
  "ok": true,
  "type": "DaemonInfo",
  "payload": {
    "profileId": "...",
    "port": 7800,
    "token": "...",
    "version": "...",
    "roots": [],
    "addToken": "...",
    "capabilities": {
      "roots_manageable": true,
      "lan_share_urls": true
    },
    "desktopVersion": "..."
  }
}
```

Required payload fields:

- `profileId`
- `port`
- `token`
- `version`
- `roots`

Optional payload fields:

- `addToken`
- `capabilities`
- `desktopVersion`
- future additive version fields such as `protocolVersion` / `behaviorVersion`

Semantics:

- handshake may start the IO daemon as part of fulfilling the request
- returned `port` and `token` bootstrap subsequent daemon communication
- `roots` is the initial download-root snapshot for the selected profile
- `addToken` is stable across restarts for the same config directory

## ProfileInUse Response

If a requested profile is actively owned by another live host instance, the
native host returns:

```json
{
  "id": "req-2",
  "ok": false,
  "error": "profile_in_use",
  "type": "ProfileInUse",
  "payload": {
    "profileId": "...",
    "clientType": "extension",
    "clientVersion": "...",
    "browserName": "...",
    "pid": 1234,
    "started": 1700000000
  }
}
```

Semantics:

- `profile_in_use` is an expected conflict state, not an internal failure
- a separate `takeOver` request may resolve the conflict
- stale incumbents may be reclaimed automatically without returning
  `ProfileInUse`

## Profile Rules

Required behavior:

- `profileId: null` always creates a new profile
- explicit valid `profileId` reuses that profile
- explicit invalid `profileId` creates a new profile
- live incumbent on same profile returns `ProfileInUse`
- stale incumbent on same profile is reclaimed
- explicit `takeOver` transfers the profile to the new host

## KV Isolation Rules

Required behavior:

- KV storage is scoped per profile
- different profiles must not observe each other's KV values
- reconnecting to the same profile must preserve KV data

## Capability Model

The native-host `DaemonInfo.capabilities` field describes host-level features
advertised during bootstrap.

Current keys:

- `roots_manageable`
- `lan_share_urls`

Capabilities are additive and optional.

## Conformance Model

Conformance is tracked by stable case IDs in
[native-host-conformance.json](/Users/kgraehl/code/jstorrent/contracts/native-host-conformance.json).

Initial required case areas:

- successful handshake returns `DaemonInfo`
- handshake returns capabilities
- handshake returns roots snapshot
- live profile conflict returns `ProfileInUse`
- invalid profile ID creates a new profile
- KV data is isolated per profile

## Backward Compatibility

Compatibility rules:

- new response fields must be additive
- existing clients must ignore unknown fields
- absence of newer optional fields must be treated as legacy behavior, not as a
  protocol error
