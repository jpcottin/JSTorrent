import { BtEngine } from '../core/bt-engine'
import { Torrent } from '../core/torrent'
import { infoHashFromBytes } from '../utils/infohash'
import { createNodeEngine, NodeEngineConfig } from '../presets/node'
import { globalLogStore, LogLevel } from '../logging/logger'
import {
  createStreamingFileProvider,
  createStreamingPlaybackSession,
} from '../streaming/streaming-playback-session'
import type { ByteRangeStreamingSession } from '../streaming/streaming-file-provider'

const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
}

function guessMimeType(filePath: string): string | null {
  const lowerPath = filePath.toLowerCase()
  const lastDot = lowerPath.lastIndexOf('.')
  if (lastDot < 0) return null
  return MIME_TYPES_BY_EXTENSION[lowerPath.slice(lastDot)] ?? null
}

export interface EngineStatus {
  ok: boolean
  running: boolean
  version?: string
  port?: number
  torrents?: Array<{ id: string; state: string }>
}

export interface TorrentStatus {
  ok: boolean
  id: string
  state: string
  progress: number
  downloadRate: number
  uploadRate: number
  totalUploaded: number
  peers: number
}

export interface TorrentFileContentInfo {
  ok: boolean
  id: string
  fileIndex: number
  filePath: string
  fileSize: number
  complete: boolean
  mimeType: string | null
}

export interface TorrentFileStreamingHandle {
  info: TorrentFileContentInfo
  session: ByteRangeStreamingSession
}

export class EngineController {
  private engine: BtEngine | null = null

  constructor() {}

  startEngine(config: Partial<NodeEngineConfig> = {}): void {
    if (this.engine) {
      throw new Error('EngineAlreadyRunning')
    }

    const engineConfig: NodeEngineConfig = {
      downloadPath: config.downloadPath || process.cwd(),
      port: 0, // Default to 0 (random)
      ...config,
    }

    // Ensure port is 0 if undefined in config (because ...config might overwrite with undefined)
    if (engineConfig.port === undefined) {
      engineConfig.port = 0
    }

    this.engine = createNodeEngine(engineConfig)
  }

  async stopEngine(): Promise<void> {
    if (!this.engine) {
      throw new Error('EngineNotRunning')
    }
    await this.engine.destroy()
    this.engine = null
  }

  getEngineStatus(): EngineStatus {
    if (!this.engine) {
      return { ok: true, running: false }
    }

    const torrents = this.engine.torrents.map((t) => ({
      id: infoHashFromBytes(t.infoHash),
      state: 'active', // Simplified for now
    }))

    return {
      ok: true,
      running: true,
      version: '1.0.0', // Placeholder
      port: this.engine.port,
      torrents,
    }
  }

  async addTorrent(params: {
    type: string
    data: string
    storagePath?: string
  }): Promise<{ ok: boolean; id: string }> {
    if (!this.engine) {
      throw new Error('EngineNotRunning')
    }

    let torrent: Torrent | null
    if (params.type === 'magnet') {
      const result = await this.engine.addTorrent(params.data)
      torrent = result.torrent
    } else if (params.type === 'file') {
      // data is base64 encoded buffer
      const buffer = Buffer.from(params.data, 'base64')
      const result = await this.engine.addTorrent(buffer)
      torrent = result.torrent
    } else {
      throw new Error('Invalid torrent type')
    }

    if (!torrent) {
      throw new Error('Failed to add torrent')
    }

    return { ok: true, id: infoHashFromBytes(torrent.infoHash) }
  }

  getTorrentStatus(id: string): TorrentStatus {
    if (!this.engine) {
      throw new Error('EngineNotRunning')
    }

    const torrent = this.engine.getTorrent(id)
    if (!torrent) {
      throw new Error('TorrentNotFound')
    }

    // Get actual status from torrent
    return {
      ok: true,
      id,
      state: torrent.progress >= 1.0 ? 'seeding' : 'downloading',
      progress: torrent.progress,
      downloadRate: torrent.downloadSpeed,
      uploadRate: torrent.uploadSpeed,
      totalUploaded: torrent.totalUploaded,
      peers: torrent.numPeers,
    }
  }

  getTorrentFileContentInfo(id: string, fileIndex: number): TorrentFileContentInfo {
    if (!this.engine) {
      throw new Error('EngineNotRunning')
    }

    const torrent = this.engine.getTorrent(id)
    if (!torrent) {
      throw new Error('TorrentNotFound')
    }

    const file = torrent.files[fileIndex]
    if (!file) {
      throw new Error('TorrentFileNotFound')
    }

    return {
      ok: true,
      id,
      fileIndex,
      filePath: file.path,
      fileSize: file.length,
      complete: torrent.isFileComplete(fileIndex),
      mimeType: guessMimeType(file.path),
    }
  }

  async readTorrentFileContent(
    id: string,
    fileIndex: number,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    if (!this.engine) {
      throw new Error('EngineNotRunning')
    }

    const torrent = this.engine.getTorrent(id)
    if (!torrent) {
      throw new Error('TorrentNotFound')
    }

    const file = torrent.files[fileIndex]
    if (!file) {
      throw new Error('TorrentFileNotFound')
    }

    if (!torrent.isFileComplete(fileIndex)) {
      throw new Error('TorrentFileIncomplete')
    }

    return torrent.readFileBytes(fileIndex, offset, length)
  }

  createTorrentFileStreamingHandle(id: string, fileIndex: number): TorrentFileStreamingHandle {
    if (!this.engine) {
      throw new Error('EngineNotRunning')
    }

    const torrent = this.engine.getTorrent(id)
    if (!torrent) {
      throw new Error('TorrentNotFound')
    }

    const file = torrent.files[fileIndex]
    if (!file) {
      throw new Error('TorrentFileNotFound')
    }

    return {
      info: {
        ok: true,
        id,
        fileIndex,
        filePath: file.path,
        fileSize: file.length,
        complete: torrent.isFileComplete(fileIndex),
        mimeType: guessMimeType(file.path),
      },
      session: createStreamingPlaybackSession(createStreamingFileProvider(torrent, fileIndex)),
    }
  }

  pauseTorrent(id: string): void {
    if (!this.engine) throw new Error('EngineNotRunning')
    const torrent = this.engine.getTorrent(id)
    if (!torrent) throw new Error('TorrentNotFound')
    // torrent.pause() // Not implemented in BtEngine yet?
  }

  resumeTorrent(id: string): void {
    if (!this.engine) throw new Error('EngineNotRunning')
    const torrent = this.engine.getTorrent(id)
    if (!torrent) throw new Error('TorrentNotFound')
    // torrent.resume() // Not implemented in BtEngine yet?
  }

  removeTorrent(id: string): void {
    if (!this.engine) throw new Error('EngineNotRunning')
    this.engine.removeTorrentByHash(id)
  }

  async addPeer(torrentId: string, ip: string, port: number): Promise<void> {
    if (!this.engine) throw new Error('EngineNotRunning')
    const torrent = this.engine.getTorrent(torrentId)
    if (!torrent) throw new Error('TorrentNotFound')

    // Connect to peer
    await torrent.connectToPeer({ ip, port })
  }

  async recheckTorrent(id: string): Promise<void> {
    if (!this.engine) throw new Error('EngineNotRunning')
    const torrent = this.engine.getTorrent(id)
    if (!torrent) throw new Error('TorrentNotFound')

    await torrent.recheckData()
  }

  getPeerInfo(id: string) {
    if (!this.engine) throw new Error('EngineNotRunning')
    const torrent = this.engine.getTorrent(id)
    if (!torrent) throw new Error('TorrentNotFound')
    return { ok: true, peers: torrent.getPeerInfo() }
  }

  disconnectPeer(id: string, ip: string, port: number) {
    if (!this.engine) throw new Error('EngineNotRunning')
    const torrent = this.engine.getTorrent(id)
    if (!torrent) throw new Error('TorrentNotFound')
    torrent.disconnectPeer(ip, port)
    return { ok: true }
  }

  setTorrentSettings(id: string, settings: { maxPeers?: number }) {
    if (!this.engine) throw new Error('EngineNotRunning')
    const torrent = this.engine.getTorrent(id)
    if (!torrent) throw new Error('TorrentNotFound')
    if (settings.maxPeers !== undefined) {
      torrent.setMaxPeers(settings.maxPeers)
    }
    return { ok: true }
  }

  getLogs(level: string = 'info', limit: number = 100) {
    const levelPriority: Record<LogLevel, number> = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
    }
    const minPriority = levelPriority[level as LogLevel] ?? 1
    const allLogs = globalLogStore.getEntries()
    const filtered = allLogs.filter((l) => levelPriority[l.level] >= minPriority)
    const logs = filtered.slice(-limit)
    return { ok: true, logs }
  }

  getTickStats() {
    if (!this.engine) throw new Error('EngineNotRunning')
    const stats = this.engine.getEngineStats()
    return { ok: true, ...stats }
  }
}
