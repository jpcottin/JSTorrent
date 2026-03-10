import type { BtEngine } from '../core/bt-engine'
import type { Torrent } from '../core/torrent'
import {
  createStreamingFileProvider,
  createStreamingPlaybackSession,
} from '../streaming/streaming-playback-session'
import type {
  NodeIoDaemonHttpStreamBridge,
  NodeIoDaemonHttpStreamCloseRequest,
  NodeIoDaemonHttpStreamLifecycleEvent,
  NodeIoDaemonHttpStreamSessionDescriptor,
  NodeIoDaemonHttpStreamWaitRequest,
} from './types'

interface ActiveHttpStreamSession {
  torrentId: string
  fileIndex: number
  torrent: Torrent
  closed: boolean
  close(reason?: string): void
  waitForRange(offset: number, length: number, signal?: AbortSignal): Promise<void>
}

export function createNodeIoDaemonEngineHttpStreamBridge(
  engine: BtEngine,
): NodeIoDaemonHttpStreamBridge {
  const sessions = new Map<string, ActiveHttpStreamSession>()

  const closeSession = (streamToken: string, reason?: string): void => {
    const current = sessions.get(streamToken)
    if (!current) {
      return
    }
    sessions.delete(streamToken)
    current.close(reason)
  }

  const isAbortError = (error: unknown): boolean => {
    if (!(error instanceof Error)) {
      return false
    }
    return error.name === 'AbortError' || error.message === 'Aborted'
  }

  const isRangeAvailable = (torrent: Torrent, fileIndex: number, offset: number, length: number): boolean => {
    if (length === 0) {
      return true
    }
    const pieces = torrent.fileBytesToPieces(fileIndex, offset, length)
    return pieces.every((pieceIndex) => torrent.hasPiece(pieceIndex))
  }

  const createSession = ({
    streamToken,
    torrentId,
    fileIndex,
  }: NodeIoDaemonHttpStreamSessionDescriptor): ActiveHttpStreamSession => {
    const torrent = engine.getTorrent(torrentId)
    if (!torrent) {
      throw new Error('TorrentNotFound')
    }

    const file = torrent.files[fileIndex]
    if (!file) {
      throw new Error('TorrentFileNotFound')
    }

    const session = createStreamingPlaybackSession(createStreamingFileProvider(torrent, fileIndex), {
      tokenPrefix: `daemon-http:${streamToken}`,
      logPrefix: `[daemon-http:${streamToken}]`,
    })
    let closeReason: string | null = null
    let closed = false

    return {
      torrentId,
      fileIndex,
      torrent,
      get closed() {
        return closed
      },
      close: (reason?: string) => {
        if (closed) {
          return
        }
        closeReason = reason ?? null
        closed = true
        session.close()
      },
      waitForRange: async (offset, length, signal) => {
        const currentTorrent = engine.getTorrent(torrentId)
        if (!currentTorrent) {
          throw new Error('TorrentRemoved')
        }
        if (currentTorrent !== torrent) {
          throw new Error('TorrentRemoved')
        }
        if (isRangeAvailable(torrent, fileIndex, offset, length)) {
          return
        }
        if (torrent.userState === 'stopped') {
          throw new Error('TorrentStopped')
        }

        try {
          await session.waitForRange(offset, length, signal)
        } catch (error) {
          if (isAbortError(error) && closeReason === 'torrent-stopped') {
            throw new Error('TorrentStopped')
          }
          if (isAbortError(error) && closeReason === 'torrent-removed') {
            throw new Error('TorrentRemoved')
          }
          throw error
        }
      },
    }
  }

  return {
    openStreamSession(descriptor: NodeIoDaemonHttpStreamSessionDescriptor): void {
      closeSession(descriptor.streamToken, 'replaced')
      sessions.set(descriptor.streamToken, createSession(descriptor))
    },

    waitForRange(request: NodeIoDaemonHttpStreamWaitRequest): Promise<void> {
      let session = sessions.get(request.streamToken)
      if (!session) {
        return Promise.reject(new Error('StreamSessionNotFound'))
      }
      if (session.torrentId !== request.torrentId || session.fileIndex !== request.fileIndex) {
        return Promise.reject(new Error('StreamSessionMismatch'))
      }
      if (session.closed && session.torrent.userState === 'active') {
        session = createSession({
          streamToken: request.streamToken,
          torrentId: request.torrentId,
          fileIndex: request.fileIndex,
        })
        sessions.set(request.streamToken, session)
      }
      return session.waitForRange(request.offset, request.length, request.signal)
    },

    closeStreamSession(request: NodeIoDaemonHttpStreamCloseRequest): void {
      const session = sessions.get(request.streamToken)
      if (!session) {
        return
      }
      if (session.torrentId !== request.torrentId || session.fileIndex !== request.fileIndex) {
        return
      }
      closeSession(request.streamToken, request.reason)
    },

    subscribeLifecycle(
      listener: (event: NodeIoDaemonHttpStreamLifecycleEvent) => void,
    ): () => void {
      const handleTorrentStopped = (torrent: Torrent) => {
        for (const session of sessions.values()) {
          if (session.torrentId !== torrent.infoHashStr) {
            continue
          }
          session.close('torrent-stopped')
        }
      }
      const handleTorrentRemoved = (torrent: Torrent) => {
        listener({
          torrentId: torrent.infoHashStr,
          reason: 'torrent-removed',
        })
      }
      engine.on('torrent-stopped', handleTorrentStopped)
      engine.on('torrent-removed', handleTorrentRemoved)
      return () => {
        engine.off('torrent-stopped', handleTorrentStopped)
        engine.off('torrent-removed', handleTorrentRemoved)
      }
    },
  }
}
