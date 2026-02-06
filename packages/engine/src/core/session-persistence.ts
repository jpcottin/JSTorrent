import { ISessionStore } from '../interfaces/session-store'
import { BtEngine } from './bt-engine'
import { Torrent } from './torrent'
import { toHex } from '../utils/buffer'
import { TorrentUserState } from './torrent-state'
import { Logger } from '../logging/logger'
import { initializeTorrentMetadata } from './torrent-initializer'

const TORRENTS_KEY = 'torrents'
const TORRENT_PREFIX = 'torrent:'
const STATE_SUFFIX = ':state'
const TORRENTFILE_SUFFIX = ':torrentfile'
const INFODICT_SUFFIX = ':infodict'
const PEERS_SUFFIX = ':peers'

/** Maximum number of peers to cache per torrent */
const MAX_CACHED_PEERS = 100

function stateKey(infoHash: string): string {
  return `${TORRENT_PREFIX}${infoHash}${STATE_SUFFIX}`
}

function torrentFileKey(infoHash: string): string {
  return `${TORRENT_PREFIX}${infoHash}${TORRENTFILE_SUFFIX}`
}

function infoDictKey(infoHash: string): string {
  return `${TORRENT_PREFIX}${infoHash}${INFODICT_SUFFIX}`
}

function peersKey(infoHash: string): string {
  return `${TORRENT_PREFIX}${infoHash}${PEERS_SUFFIX}`
}

/**
 * A cached peer address for persistence between sessions.
 * Minimal data - just enough to reconnect.
 */
export interface CachedPeer {
  ip: string
  port: number
}

/**
 * Entry in the lightweight torrent index.
 */
export interface TorrentListEntry {
  infoHash: string // Hex string
  source: 'file' | 'magnet'
  magnetUri?: string // Only for magnet source
  addedAt: number // Timestamp when added
}

/**
 * The torrent list index.
 */
export interface TorrentListData {
  version: number
  torrents: TorrentListEntry[]
}

/**
 * Per-torrent mutable state.
 */
export interface TorrentStateData {
  // User state
  userState: TorrentUserState
  storageKey?: string
  queuePosition?: number
  forceActive?: boolean

  // Progress (absent until metadata received)
  bitfield?: string // Hex-encoded bitfield
  pieceCount?: number // Total pieces (for accurate completion check without parsing metadata)
  uploaded: number
  downloaded: number
  updatedAt: number

  // File priorities (absent until metadata received and user sets priorities)
  filePriorities?: number[] // Per-file: 0=normal, 1=skip
}

/**
 * Handles persisting and restoring torrent session state.
 */
export class SessionPersistence {
  private _logger: Logger | null = null

  // Throttled piece persistence: tracks torrents with pending saves
  private _pendingPieceSaves = new Set<string>() // infoHash hex strings
  private _pieceFlushTimer: ReturnType<typeof setTimeout> | null = null
  private _pieceFlushIntervalMs = 1000 // Flush every 1 second

  constructor(
    private _store: ISessionStore,
    private engine: BtEngine,
  ) {}

  /**
   * Get the underlying session store.
   * Used by BtEngine for DHT state persistence.
   */
  get store(): ISessionStore {
    return this._store
  }

  private get logger(): Logger {
    if (!this._logger) {
      this._logger = this.engine.scopedLoggerFor({
        getLogName: () => 'session',
        getStaticLogName: () => 'session',
        engineInstance: this.engine,
      })
    }
    return this._logger
  }

  /**
   * Save the lightweight torrent index.
   * Only contains identifiers and source info - no large data.
   */
  async saveTorrentList(): Promise<void> {
    const data: TorrentListData = {
      version: 2,
      torrents: this.engine.torrents.map((t) => {
        const entry: TorrentListEntry = {
          infoHash: toHex(t.infoHash),
          source: t.magnetLink ? 'magnet' : 'file',
          addedAt: t.addedAt,
        }
        if (t.magnetLink) {
          entry.magnetUri = t.magnetLink
        }
        return entry
      }),
    }

    this.logger.info(
      `saveTorrentList: saving ${data.torrents.length} torrents: ${data.torrents.map((t) => `${t.infoHash.slice(0, 8)}(${t.source})`).join(', ')}`,
    )
    await this._store.setJson(TORRENTS_KEY, data)
    this.logger.info('saveTorrentList: save completed')
  }

  /**
   * Save mutable state for a specific torrent (progress, userState, etc).
   */
  async saveTorrentState(torrent: Torrent): Promise<void> {
    const infoHash = toHex(torrent.infoHash)
    const root = this.engine.storageRootManager.getRootForTorrent(infoHash)

    const state: TorrentStateData = {
      userState: torrent.userState,
      storageKey: root?.key,
      queuePosition: torrent.queuePosition,
      forceActive: torrent.forceActive || undefined,
      bitfield: torrent.bitfield?.toHex(),
      pieceCount: torrent.bitfield?.size,
      uploaded: torrent.totalUploaded,
      downloaded: torrent.totalDownloaded,
      updatedAt: Date.now(),
      filePriorities: torrent.filePriorities?.length > 0 ? [...torrent.filePriorities] : undefined,
    }

    await this._store.setJson(stateKey(infoHash), state)
  }

  /**
   * Schedule a throttled save for piece completion.
   * Unlike saveTorrentState(), this batches multiple piece completions into
   * periodic flushes to avoid excessive storage writes during fast downloads.
   */
  schedulePiecePersistence(torrent: Torrent): void {
    const infoHash = toHex(torrent.infoHash)
    this._pendingPieceSaves.add(infoHash)

    // Start flush timer if not already running
    if (!this._pieceFlushTimer) {
      this._pieceFlushTimer = setTimeout(() => {
        this._pieceFlushTimer = null
        void this._flushPendingPieceSaves()
      }, this._pieceFlushIntervalMs)
    }
  }

  /**
   * Flush all pending piece persistence saves.
   */
  private async _flushPendingPieceSaves(): Promise<void> {
    const pending = Array.from(this._pendingPieceSaves)
    this._pendingPieceSaves.clear()

    for (const infoHash of pending) {
      const torrent = this.engine.torrents.find((t) => toHex(t.infoHash) === infoHash)
      if (torrent) {
        await this.saveTorrentState(torrent)
      }
    }
  }

  /**
   * Save the .torrent file bytes. Called once when adding a file-source torrent.
   */
  async saveTorrentFile(infoHash: string, torrentFile: Uint8Array): Promise<void> {
    await this._store.set(torrentFileKey(infoHash), torrentFile)
  }

  /**
   * Save the info dictionary bytes. Called once when a magnet torrent receives metadata.
   */
  async saveInfoDict(infoHash: string, infoDict: Uint8Array): Promise<void> {
    await this._store.set(infoDictKey(infoHash), infoDict)
  }

  /**
   * Save cached peers for a torrent.
   * Called on torrent stop and engine shutdown to enable fast reconnection next session.
   */
  async savePeers(infoHash: string, peers: CachedPeer[]): Promise<void> {
    if (peers.length === 0) {
      await this._store.delete(peersKey(infoHash))
      return
    }
    const toSave = peers.slice(0, MAX_CACHED_PEERS)
    await this._store.setJson(peersKey(infoHash), toSave)
    this.logger.debug(`Saved ${toSave.length} cached peers for ${infoHash.slice(0, 8)}`)
  }

  /**
   * Load cached peers for a torrent.
   */
  async loadPeers(infoHash: string): Promise<CachedPeer[]> {
    const peers = await this._store.getJson<CachedPeer[]>(peersKey(infoHash))
    return peers ?? []
  }

  /**
   * Save state for all torrents immediately.
   * Call this on shutdown.
   */
  async flushPendingSaves(): Promise<void> {
    // Cancel any pending throttle timer
    if (this._pieceFlushTimer) {
      clearTimeout(this._pieceFlushTimer)
      this._pieceFlushTimer = null
    }
    this._pendingPieceSaves.clear()

    // Save all torrents immediately (state + cached peers)
    for (const torrent of this.engine.torrents) {
      await this.saveTorrentState(torrent)
      const infoHash = toHex(torrent.infoHash)
      const peers = torrent.getGoodPeersForCache()
      await this.savePeers(infoHash, peers)
    }
  }

  /**
   * Load the torrent index from storage.
   */
  async loadTorrentList(): Promise<TorrentListEntry[]> {
    const data = await this._store.getJson<TorrentListData>(TORRENTS_KEY)
    if (!data) {
      this.logger.info('loadTorrentList: no data found in storage')
      return []
    }
    const entries = data.torrents || []
    this.logger.info(
      `loadTorrentList: loaded ${entries.length} entries: ${entries.map((t) => `${t.infoHash.slice(0, 8)}(${t.source})`).join(', ')}`,
    )
    return entries
  }

  /**
   * Load mutable state for a specific torrent.
   */
  async loadTorrentState(infoHash: string): Promise<TorrentStateData | null> {
    return this._store.getJson<TorrentStateData>(stateKey(infoHash))
  }

  /**
   * Load the .torrent file bytes for a file-source torrent.
   */
  async loadTorrentFile(infoHash: string): Promise<Uint8Array | null> {
    return this._store.get(torrentFileKey(infoHash))
  }

  /**
   * Load the info dictionary bytes for a magnet-source torrent.
   */
  async loadInfoDict(infoHash: string): Promise<Uint8Array | null> {
    return this._store.get(infoDictKey(infoHash))
  }

  /**
   * Remove all persisted data for a torrent.
   */
  async removeTorrentData(infoHash: string): Promise<void> {
    await Promise.all([
      this._store.delete(stateKey(infoHash)),
      this._store.delete(torrentFileKey(infoHash)),
      this._store.delete(infoDictKey(infoHash)),
      this._store.delete(peersKey(infoHash)),
    ])
  }

  /**
   * Reset torrent state (progress, file priorities) without removing the infodict.
   * Used for "reset state" which clears progress but preserves metadata for magnet torrents.
   */
  async resetState(infoHash: string): Promise<void> {
    await this._store.delete(stateKey(infoHash))
  }

  /**
   * Restore all torrents from storage.
   * Call this on engine startup while engine is suspended.
   */
  async restoreSession(): Promise<number> {
    const entries = await this.loadTorrentList()
    let restoredCount = 0

    for (const entry of entries) {
      try {
        const state = await this.loadTorrentState(entry.infoHash)
        let torrent: Torrent | null = null

        if (entry.source === 'file') {
          // File-source: load .torrent file
          const torrentFile = await this.loadTorrentFile(entry.infoHash)
          if (!torrentFile) {
            this.logger.error(`Missing torrent file for ${entry.infoHash}, skipping`)
            continue
          }
          const result = await this.engine.addTorrent(torrentFile, {
            storageKey: state?.storageKey,
            source: 'restore',
            userState: state?.userState ?? 'active',
          })
          torrent = result.torrent
        } else {
          // Magnet-source: use magnetUri
          if (!entry.magnetUri) {
            this.logger.error(`Missing magnetUri for ${entry.infoHash}, skipping`)
            continue
          }
          const result = await this.engine.addTorrent(entry.magnetUri, {
            storageKey: state?.storageKey,
            source: 'restore',
            userState: state?.userState ?? 'active',
          })
          torrent = result.torrent

          // If we have saved infodict, initialize metadata
          if (torrent && !torrent.hasMetadata) {
            const infoDict = await this.loadInfoDict(entry.infoHash)
            if (infoDict) {
              this.logger.debug(`Initializing torrent ${entry.infoHash} from saved infodict`)
              try {
                await initializeTorrentMetadata(this.engine, torrent, infoDict)
              } catch (e) {
                if (e instanceof Error && e.name === 'MissingStorageRootError') {
                  torrent.errorMessage = `Download location unavailable. Storage root not found.`
                  this.logger.warn(`Torrent ${entry.infoHash} restored with missing storage`)
                } else {
                  throw e
                }
              }
            }
          }
        }

        if (torrent) {
          // Restore progress from state
          if (state) {
            if (state.bitfield && torrent.hasMetadata) {
              torrent.restoreBitfieldFromHex(state.bitfield)
            }
            torrent.totalUploaded = state.uploaded
            torrent.totalDownloaded = state.downloaded
            torrent.queuePosition = state.queuePosition
            if (state.forceActive) torrent.forceActive = true

            // Restore file priorities (must be after metadata is initialized)
            if (state.filePriorities && torrent.hasMetadata) {
              torrent.restoreFilePriorities(state.filePriorities)
            }
          }

          // Restore addedAt from list entry
          torrent.addedAt = entry.addedAt

          restoredCount++
        }
      } catch (e) {
        this.logger.error(`Failed to restore torrent ${entry.infoHash}:`, e)
      }
    }

    return restoredCount
  }
}
