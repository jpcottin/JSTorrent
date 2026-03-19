import type { BtEngine } from './bt-engine'
import type { Torrent } from './torrent'
import type { IFileSystem } from '../interfaces/filesystem'
import { generateMagnet } from '../utils/magnet'
import type { InfoHashHex } from '../utils/infohash'

/** Debounce interval for coalescing rapid piece completions. */
const FLUSH_INTERVAL_MS = 1000

/** Filename pattern: .{infohash}.jstorrent.json */
function manifestFilename(infoHash: InfoHashHex): string {
  return `.${infoHash}.jstorrent.json`
}

export interface ManifestJson {
  infohash: string
  magnet: string
  files: Record<string, { index: number; complete: boolean }>
}

/**
 * Build the manifest JSON for a torrent.
 * File keys are relative to the directory containing the manifest.
 */
export function buildManifestJson(torrent: Torrent): ManifestJson | null {
  if (!torrent.hasMetadata || !torrent.contentStorage) return null

  const files = torrent.contentStorage.filesList
  if (files.length === 0) return null

  const isSingleFile = files.length === 1 && !files[0].path.includes('/')

  const magnet = generateMagnet({
    infoHash: torrent.infoHashStr,
    name: torrent.name,
    announce: torrent.announce,
  })

  const fileMap: Record<string, { index: number; complete: boolean }> = {}
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    // For multi-file torrents, paths are "TorrentName/sub/file.ext".
    // The manifest sits in the TorrentName/ directory, so strip the first segment.
    // For single-file torrents, paths are just "filename.ext" — use as-is.
    let relativePath: string
    if (isSingleFile) {
      relativePath = file.path
    } else {
      const slashIdx = file.path.indexOf('/')
      relativePath = slashIdx >= 0 ? file.path.substring(slashIdx + 1) : file.path
    }
    fileMap[relativePath] = {
      index: i,
      complete: torrent.isFileComplete(i),
    }
  }

  return {
    infohash: torrent.infoHashStr,
    magnet,
    files: fileMap,
  }
}

/**
 * Computes the manifest file path relative to the storage root.
 * Multi-file: "TorrentName/.{hash}.jstorrent.json"
 * Single-file: ".{hash}.jstorrent.json"
 */
function manifestPath(torrent: Torrent): string | null {
  if (!torrent.hasMetadata || !torrent.contentStorage) return null
  const files = torrent.contentStorage.filesList
  if (files.length === 0) return null

  const filename = manifestFilename(torrent.infoHashStr)
  const isSingleFile = files.length === 1 && !files[0].path.includes('/')

  if (isSingleFile) {
    return filename
  }

  // Multi-file: first path segment is the torrent folder name
  const firstSlash = files[0].path.indexOf('/')
  const torrentDir = firstSlash >= 0 ? files[0].path.substring(0, firstSlash) : ''
  return torrentDir ? `${torrentDir}/${filename}` : filename
}

/**
 * Writes .jstorrent.json manifest files alongside downloaded torrents.
 * Follows the same debounce pattern as SessionPersistence.schedulePiecePersistence().
 */
export class ManifestWriter {
  private _pendingSaves = new Set<InfoHashHex>()
  private _flushTimer: ReturnType<typeof setTimeout> | null = null
  private _engine: BtEngine

  constructor(engine: BtEngine) {
    this._engine = engine
  }

  /** Schedule a debounced manifest write for a torrent. */
  scheduleSave(torrent: Torrent): void {
    this._pendingSaves.add(torrent.infoHashStr)
    if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null
        void this._flushPending()
      }, FLUSH_INTERVAL_MS)
    }
  }

  /** Write manifest immediately (for metadata-ready or torrent-complete). */
  async writeNow(torrent: Torrent): Promise<void> {
    this._pendingSaves.delete(torrent.infoHashStr)
    await this._writeManifest(torrent)
  }

  /** Delete manifest file when torrent is removed. */
  async deleteManifest(torrent: Torrent): Promise<void> {
    this._pendingSaves.delete(torrent.infoHashStr)
    const path = manifestPath(torrent)
    if (!path) return

    const fs = this._getFileSystem(torrent)
    if (!fs) return

    try {
      await fs.delete(path)
    } catch {
      // File may not exist — that's fine
    }
  }

  /** Flush all pending saves (called on engine shutdown). */
  async flushPendingSaves(): Promise<void> {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
    }

    const pending = Array.from(this._pendingSaves)
    this._pendingSaves.clear()

    for (const infoHash of pending) {
      const torrent = this._engine.torrents.find((t) => t.infoHashStr === infoHash)
      if (torrent) {
        await this._writeManifest(torrent)
      }
    }
  }

  dispose(): void {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer)
      this._flushTimer = null
    }
    this._pendingSaves.clear()
  }

  private async _flushPending(): Promise<void> {
    const pending = Array.from(this._pendingSaves)
    this._pendingSaves.clear()

    for (const infoHash of pending) {
      const torrent = this._engine.torrents.find((t) => t.infoHashStr === infoHash)
      if (torrent) {
        await this._writeManifest(torrent)
      }
    }
  }

  private async _writeManifest(torrent: Torrent): Promise<void> {
    const json = buildManifestJson(torrent)
    if (!json) return

    const path = manifestPath(torrent)
    if (!path) return

    const fs = this._getFileSystem(torrent)
    if (!fs) return

    try {
      const data = new TextEncoder().encode(JSON.stringify(json, null, 2))
      await fs.writeAtomic(path, data)
    } catch (err) {
      // Log but don't throw — manifest writing is best-effort
      // Use console since ManifestWriter doesn't extend EngineComponent
      // to keep it lightweight
      const msg = err instanceof Error ? err.message : String(err)
      void msg // suppress unused warning; logging added when wired to engine logger
    }
  }

  private _getFileSystem(torrent: Torrent): IFileSystem | null {
    return torrent.contentStorage?.storage?.getFileSystem() ?? null
  }
}
