import { BtEngine, MAX_PIECE_SIZE } from './bt-engine'
import { Torrent } from './torrent'
import { TorrentParser, ParsedTorrent } from './torrent-parser'
import { TorrentContentStorage } from './torrent-content-storage'
import { IStorageHandle } from '../io/storage-handle'
import { toHex } from '../utils/buffer'
import { computeReq2Hash } from '../crypto/key-derivation'

/**
 * Initialize a torrent with metadata (info dictionary).
 *
 * This handles:
 * - Parsing the info buffer (if not already parsed)
 * - Validating piece size limits
 * - Initializing bitfield and piece info
 * - Creating content storage
 *
 * Used by:
 * - addTorrent() when adding a .torrent file (has metadata immediately)
 * - metadata event handler when magnet link receives metadata from peers
 * - session restore when we have saved metadata
 */
export async function initializeTorrentMetadata(
  engine: BtEngine,
  torrent: Torrent,
  infoBuffer: Uint8Array,
  preParsed?: ParsedTorrent,
  options?: { magnetSelectOnly?: number[] },
): Promise<void> {
  if (torrent.hasMetadata) {
    return // Already initialized
  }

  const infoHashStr = toHex(torrent.infoHash)

  // Parse if not already parsed
  const parsedTorrent =
    preParsed || (await TorrentParser.parseInfoBuffer(infoBuffer, engine.hasher))

  // Validate piece size
  if (parsedTorrent.pieceLength > MAX_PIECE_SIZE) {
    const sizeMB = (parsedTorrent.pieceLength / (1024 * 1024)).toFixed(1)
    const maxMB = (MAX_PIECE_SIZE / (1024 * 1024)).toFixed(0)
    const error = new Error(
      `Torrent piece size (${sizeMB}MB) exceeds maximum supported size (${maxMB}MB)`,
    )
    torrent.emit('error', error)
    engine.emit('error', error)
    throw error
  }

  // Set metadata on torrent
  torrent.setMetadata(infoBuffer)

  // Precompute MSE identifier for incoming connection routing
  // (skip if already computed in addTorrent - magnets compute earlier)
  if (!torrent.mseIdentifier) {
    const mseId = await computeReq2Hash(torrent.infoHash, (data) =>
      engine.hasher.sha1(data, 'mse-req2'),
    )
    torrent.setMseIdentifier(mseId)
  }

  // Set private flag (BEP 27) - disables DHT/PEX for private torrents
  if (parsedTorrent.isPrivate) {
    torrent.isPrivate = true
  }

  torrent.metadataUrlSeeds = parsedTorrent.urlSeeds ? [...parsedTorrent.urlSeeds] : []

  // Set optional metadata fields (only available from .torrent files, not magnets)
  if (parsedTorrent.comment) torrent.comment = parsedTorrent.comment
  if (parsedTorrent.createdBy) torrent.createdBy = parsedTorrent.createdBy
  if (parsedTorrent.creationDate) torrent.creationDate = parsedTorrent.creationDate

  // Initialize bitfield (torrent owns the bitfield)
  torrent.initBitfield(parsedTorrent.pieces.length)
  torrent.initPieceAvailability(parsedTorrent.pieces.length)

  // Initialize piece info
  const lastPieceLength =
    parsedTorrent.length % parsedTorrent.pieceLength || parsedTorrent.pieceLength
  torrent.initPieceInfo(parsedTorrent.pieces, parsedTorrent.pieceLength, lastPieceLength)

  // Restore bitfield from saved state if available
  const savedState = await engine.sessionPersistence.loadTorrentState(infoHashStr)
  if (savedState?.bitfield) {
    torrent.restoreBitfieldFromHex(savedState.bitfield)
  }

  // Initialize content storage
  const storageHandle: IStorageHandle = {
    id: infoHashStr,
    name: parsedTorrent.name || infoHashStr,
    getFileSystem: () => engine.storageRootManager.getFileSystemForTorrent(infoHashStr),
  }

  const contentStorage = new TorrentContentStorage(
    engine,
    storageHandle,
    torrent.diskQueue,
    engine.useAdaptiveBatching,
  )
  await contentStorage.open(parsedTorrent.files, parsedTorrent.pieceLength)
  torrent.contentStorage = contentStorage

  // Initialize file priorities and classification
  torrent.initFilePriorities()

  // Restore file priorities from saved state if available
  if (savedState?.filePriorities) {
    torrent.restoreFilePriorities(savedState.filePriorities)
  } else if (options?.magnetSelectOnly && options.magnetSelectOnly.length > 0) {
    const selectedIndices = new Set(
      options.magnetSelectOnly.filter((index) => index >= 0 && index < parsedTorrent.files.length),
    )
    if (selectedIndices.size > 0) {
      const filePriorities = new Array(parsedTorrent.files.length).fill(1)
      for (const index of selectedIndices) {
        filePriorities[index] = 0
      }
      torrent.restoreFilePriorities(filePriorities)
      engine.sessionPersistence.saveTorrentState(torrent)
    }
  }

  // Initialize .parts file for boundary pieces
  await torrent.initPartsFile()

  // Verify resume data integrity (fast stat-based check).
  // Sets torrent.needsDataCheck if files don't match the persisted bitfield,
  // which triggers a full hash recheck in start().
  await torrent.verifyResumeData()
}

/**
 * Initialize only the storage for a torrent that already has metadata.
 * Used for recovery when storage becomes available after initial failure.
 *
 * @throws MissingStorageRootError if storage root is not found
 */
export async function initializeTorrentStorage(
  engine: BtEngine,
  torrent: Torrent,
  infoBuffer: Uint8Array,
): Promise<void> {
  if (torrent.contentStorage) {
    return // Already initialized
  }

  if (!torrent.hasMetadata) {
    throw new Error('Cannot initialize storage without metadata')
  }

  const infoHashStr = toHex(torrent.infoHash)

  // Re-parse the info buffer to get file list
  const parsedTorrent = await TorrentParser.parseInfoBuffer(infoBuffer, engine.hasher)

  // Initialize content storage (may throw MissingStorageRootError)
  const storageHandle: IStorageHandle = {
    id: infoHashStr,
    name: parsedTorrent.name || infoHashStr,
    getFileSystem: () => engine.storageRootManager.getFileSystemForTorrent(infoHashStr),
  }

  const contentStorage = new TorrentContentStorage(
    engine,
    storageHandle,
    torrent.diskQueue,
    engine.useAdaptiveBatching,
  )
  await contentStorage.open(parsedTorrent.files, parsedTorrent.pieceLength)
  torrent.contentStorage = contentStorage

  // Initialize file priorities and classification (may already be set from restore)
  torrent.initFilePriorities()

  // Initialize .parts file for boundary pieces
  await torrent.initPartsFile()
}
