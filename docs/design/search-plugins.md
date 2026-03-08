# Search Plugins

## Status

Draft design for a lightweight search plugin system that can start in the extension and later be hosted by native runtimes.

## Goals

- Let users install a search provider with a simple URL-based flow.
- Keep the plugin authoring surface small and close to qBittorrent-style search plugins.
- Start with an extension-hosted implementation without immediately requiring new desktop or Android runtime work.
- Preserve a clean path to a native QuickJS host later for desktop and Android.
- Keep plugin permissions narrow and reviewable.
- Support a built-in plugin lab for iterative development and debugging.

## Non-Goals

- Full runtime compatibility with arbitrary qBittorrent Python plugins.
- A general-purpose remote code platform.
- Arbitrary socket access, file access, or process execution from plugin code.
- Promise-heavy or event-loop-heavy plugin APIs in v1.

## Context

qBittorrent's search plugin model is small at the API level:

- provider metadata
- `search(...)`
- optional torrent download hook
- helper functions for HTTP and output

Many providers appear to be thin wrappers over hidden JSON or XML endpoints rather than full browser automation. That makes a JSTorrent-native JavaScript plugin format practical.

The main product goal is convenience: easier than dismissing ads and pop-ups manually, not real-time interactivity.

## Design Summary

Define a JSTorrent search plugin contract that is:

- JavaScript-based
- synchronous from plugin code's perspective
- permissioned by a lightweight manifest
- host-agnostic at the API boundary

The first implementation can run inside the extension using a sandboxed context with brokered network access. Later implementations can run the same plugin contract in QuickJS on desktop or Android.

This design separates:

- plugin contract: stable
- host/runtime implementation: replaceable
- install/update UX: shared

## High-Level Architecture

### Shared Pieces

- Plugin manifest
- Plugin source bundle
- Normalized search result shape
- Search plugin host API
- Installer and update logic
- Plugin lab UI

### Runtime Options

#### V1: Extension Sandbox Host

- Plugin code runs in a sandboxed extension page, iframe, or worker.
- Plugin code has no `chrome.*` access.
- Network access is brokered by the extension host.
- Good for fast prototyping and Chrome Web Store review clarity.

#### Later: Native QuickJS Host

- Same plugin contract executed in QuickJS.
- Network access is brokered by desktop daemon or Android native companion.
- Better long-term cross-platform story.

The extension prototype should target the same API surface as the later QuickJS host.

## Plugin Manifest

Keep the manifest intentionally small.

```ts
export type SearchPluginManifest = {
  id?: string
  name: string
  version?: string
  description?: string
  homepage?: string
  source?: string
  hosts: string[]
  categories?: string[]
}
```

### Field Notes

- `name` is required.
- `hosts` is required.
- `id` is optional in v1.
- `version` is optional in v1.
- `source` records the original install URL when known.

### ID Strategy

Plugin authors should not be forced to invent globally meaningful IDs for v1.

Resolution rules:

1. If manifest includes `id`, use it.
2. Otherwise derive a local stable ID from:
   - slugified `name`
   - short hash of normalized source URL if present
3. If no source URL exists, derive from:
   - slugified `name`
   - short content hash

Examples:

- `github.lightdestory.thepiratebay`
- `the-pirate-bay-7f3c2a91`

Internally keep:

- `pluginId`: stable local identifier
- `sourceUrl`: install source, if any

## Plugin Module Shape

The plugin contract should be browser-free and host-centric.

```ts
export const manifest = {
  name: 'The Pirate Bay',
  hosts: ['apibay.org', 'thepiratebay.org'],
}

export function search(ctx, input) {
  const results = ctx.fetchJson(
    `https://apibay.org/q.php?q=${ctx.encode(input.query)}&cat=0`
  )

  for (const item of results) {
    ctx.emitResult({
      name: item.name,
      size: Number(item.size),
      seeds: Number(item.seeders),
      leeches: Number(item.leechers),
      infoHash: item.info_hash,
      detailsUrl: `https://thepiratebay.org/description.php?id=${item.id}`,
      source: manifest.name,
    })
  }
}
```

### Search Entry Point

```ts
type SearchInput = {
  query: string
  category?: string
}
```

```ts
type SearchPluginModule = {
  manifest: SearchPluginManifest
  search(ctx: SearchPluginContext, input: SearchInput): void
}
```

### Optional Future Hooks

Not needed in v1, but plausible later:

- `downloadTorrent(ctx, input)`
- `getCapabilities(ctx)`

## Search Plugin Context

The host API should remain synchronous from the plugin's perspective.

```ts
type SearchPluginContext = {
  encode(value: string): string
  fetchText(input: FetchInput): string
  fetchJson<T = unknown>(input: FetchInput): T
  parseHtml(html: string): HtmlDocument
  emitResult(result: SearchResult): void
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
}
```

```ts
type FetchInput = {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  responseType?: 'text' | 'json'
}
```

### Why Synchronous

The qBittorrent-style workload is batch-oriented:

- fetch page
- parse page
- emit results
- maybe fetch another page

Synchronous plugin APIs avoid:

- promise plumbing
- event-loop pumping
- timer semantics
- QuickJS pending-job complexity
- awkward cancellation behavior across platforms

The host may still perform asynchronous work internally and block the plugin call until it returns.

## Result Shape

Normalize results into a JSTorrent-native schema.

```ts
type SearchResult = {
  name: string
  source: string
  size?: number
  seeds?: number
  leeches?: number
  magnetUrl?: string
  torrentUrl?: string
  infoHash?: string
  detailsUrl?: string
  publishedAt?: number
}
```

Notes:

- Support either `magnetUrl`, `torrentUrl`, or `infoHash`.
- Host may derive a magnet URL from `infoHash` when enough metadata exists.
- Plugins should emit partial-but-useful results rather than failing if one field is absent.

## HTML Parsing

Do not require raw regex-only scraping.

Provide `parseHtml(...)` as a first-class helper. The implementation can vary by host:

- extension sandbox: bundled pure-JS parser
- native QuickJS host: bundled parser library or host-side parse bridge

This keeps plugin code close to the simple mental model plugin authors expect without requiring a full browser DOM.

The HTML parser API should be limited and query-focused rather than exposing a large browser-like surface.

## Permissions Model

The manifest should be the main permission declaration.

### Initial Permissions

- `hosts`

### Enforced by Host

- allow outbound HTTP(S) only to declared hosts
- deny local-network access by default
- deny file access
- deny arbitrary socket access
- deny process execution
- apply request timeout
- apply response size cap
- apply request count cap per run

### Why This Matters

Even if plugin execution starts in an extension sandbox, the system should not become a generic fetch proxy or remote execution platform.

## Install and Update Flow

Use community pages or wiki pages as discovery, but do not execute directly from live URLs on every search.

### Install

1. User pastes a raw plugin URL.
2. Host fetches the source once.
3. Host extracts and validates manifest.
4. Host shows requested hosts and metadata.
5. If accepted, host stores a frozen local copy plus source metadata.

### Execute

- Execute the stored local copy, not the live remote URL.

### Update

1. Check original source URL.
2. Re-fetch source.
3. Compare content hash or version.
4. Re-validate manifest and permissions.
5. Prompt or auto-update according to policy.

This model keeps URL-based installation simple while keeping runtime behavior stable and inspectable.

## Storage Model

Each installed plugin should track:

```ts
type InstalledPluginRecord = {
  pluginId: string
  manifest: SearchPluginManifest
  sourceUrl?: string
  sourceHash: string
  installedAt: number
  updatedAt: number
  enabled: boolean
  code: string
}
```

## Plugin Lab

The system should ship with a lightweight development and debugging surface.

### Core Features

- source input:
  - paste plugin code
  - paste plugin URL
- test input:
  - query
  - category
- run button
- install-from-draft button

### Output Panels

- results
- console
- network
- raw error

### Captured Data

```ts
type PluginRunTrace = {
  ok: boolean
  durationMs: number
  results: SearchResult[]
  logs: Array<{
    level: 'debug' | 'info' | 'warn' | 'error'
    message: string
  }>
  requests: Array<{
    url: string
    method: string
    status?: number
    durationMs?: number
    bytes?: number
    error?: string
  }>
  error?: {
    phase: 'load' | 'manifest' | 'search' | 'parse'
    name: string
    message: string
    stack?: string
  }
}
```

This is the equivalent of "show stderr and interpreter errors" without depending on real POSIX stderr semantics.

## UI Plan

### User-Facing Entry Points

- Header action near Settings for "Plugins" or "Search Plugins"
- Plugin manager modal

### Modal Sections

- Installed
- Add from URL
- Lab

### Manager Actions

- install
- enable/disable
- update
- remove
- test

### Search Results UI

The manager modal is appropriate for installation and testing.

Actual end-user searching may eventually want a fuller panel or page rather than staying modal-only.

## Runtime Abstraction

Avoid baking webview-specific assumptions into the plugin contract.

Instead define a host abstraction:

```ts
type SearchPluginHost = {
  install(source: string): Promise<InstalledPluginRecord>
  run(pluginId: string, input: SearchInput): Promise<PluginRunTrace>
  list(): Promise<InstalledPluginRecord[]>
  update(pluginId: string): Promise<void>
  remove(pluginId: string): Promise<void>
}
```

Implementations:

- extension sandbox host
- native QuickJS host

The plugin module contract should not care which host is used.

## V1 Runtime Recommendation

Start with an extension-hosted prototype.

### Why

- fastest path to something usable
- no immediate desktop app embedding work
- no immediate Android companion work
- easier to learn what plugin shapes actually appear in practice

### Constraints

- sandboxed execution context
- no `chrome.*` access in plugin code
- brokered fetch only
- local frozen copies after install

### Important Caveat

The prototype must still target the shared manifest and host API defined here so later native hosts can reuse plugin content.

## Later Native Runtime Recommendation

If the feature proves valuable and needs to run on desktop and Android, add a QuickJS-based native host that implements the same plugin contract.

This is preferable to defining the system around hidden webviews on every platform.

### Why Not Make Hidden Webviews the Primary Architecture

- heavier runtime
- harder lifecycle management
- bridge surface tends to sprawl
- platform-specific behavior leaks into plugin design

Hidden webviews are acceptable as an implementation detail for a prototype, not as the core abstraction.

## Conversion from qBittorrent Plugins

Support qBittorrent plugins as an import source, not as a runtime contract.

### Practical Strategy

- identify simple fetch-parse-emit Python plugins
- convert them to JSTorrent JS plugins
- review or patch generated output
- store and run as JSTorrent plugins

### Good Candidates

- plugins backed by hidden JSON/XML endpoints
- plugins with simple HTML parsing

### Harder Candidates

- plugins with brittle scraping
- plugins with unusual referer/cookie behavior
- plugins that rely on Python-specific standard library behavior

## Security and Review Notes

The design should stay understandable and bounded:

- small declared host list
- no page-context access
- no content scripts required
- no arbitrary local capabilities
- no live execution from mutable remote URLs after install

Even if the first runtime is extension-hosted, the system should be designed as a constrained provider framework, not as general remote code execution.

## Rollout Plan

### Phase 0: Design

- write this document
- finalize manifest and host API

### Phase 1: Extension Prototype

- sandbox runtime
- brokered `fetchText`, `fetchJson`, `parseHtml`, `emitResult`, `log`
- plugin lab
- one or two sample plugins

### Phase 2: Plugin Manager

- install from URL
- local storage
- enable/disable
- update checks

### Phase 3: Search UX

- end-user search UI
- result add-to-torrent flow

### Phase 4: Native Host Evaluation

- decide whether desktop daemon and Android companion should host plugins directly
- if yes, implement same contract in QuickJS

## Open Questions

- Should `version` remain optional, or be required for installed plugins?
- How much HTML parser surface should be exposed to plugins?
- Should wildcard hosts be allowed at all?
- Should custom headers and POST bodies be allowed in v1?
- Should plugin installation default to manual updates or auto-update?
- Should production installs allow arbitrary pasted code, or only URL-based imports and curated sources?
