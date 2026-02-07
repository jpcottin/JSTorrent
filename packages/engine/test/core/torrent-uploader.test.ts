import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TorrentUploader } from '../../src/core/torrent-uploader'
import { PeerConnection } from '../../src/core/peer-connection'
import { MockEngine } from '../utils/mock-engine'
import { ITcpSocket } from '../../src/interfaces/socket'

// Minimal mock socket for PeerConnection construction
class MockSocket implements ITcpSocket {
  send(_data: Uint8Array) {}
  onData(_cb: (data: Uint8Array) => void) {}
  onClose(_cb: (hadError: boolean) => void) {}
  onError(_cb: (err: Error) => void) {}
  close() {}
}

/** Create a real PeerConnection with mock socket for testing */
function createMockPeer(engine: MockEngine): PeerConnection {
  return new PeerConnection(engine, new MockSocket())
}

/** Mock content reader with controllable promises */
function createMockStorage() {
  const pendingReads: Array<{
    resolve: (data: Uint8Array) => void
    reject: (err: Error) => void
    index: number
    begin: number
    length: number
  }> = []

  const storage = {
    read: vi.fn(
      (index: number, begin: number, length: number) =>
        new Promise<Uint8Array>((resolve, reject) => {
          pendingReads.push({ resolve, reject, index, begin, length })
        }),
    ),
    pendingReads,
    /** Resolve the oldest pending read */
    resolveNext() {
      const entry = pendingReads.shift()!
      entry.resolve(new Uint8Array(entry.length))
    },
    /** Resolve all pending reads */
    resolveAll() {
      while (pendingReads.length > 0) {
        this.resolveNext()
      }
    },
    /** Reject the oldest pending read */
    rejectNext(err: Error) {
      pendingReads.shift()!.reject(err)
    },
  }
  return storage
}

/** Mock upload bucket */
function createMockBucket(limited = false) {
  return {
    isLimited: limited,
    tryConsume: vi.fn(() => true),
    msUntilAvailable: vi.fn(() => 0),
  }
}

describe('TorrentUploader', () => {
  let engine: MockEngine
  let uploader: TorrentUploader
  let storage: ReturnType<typeof createMockStorage>
  let bucket: ReturnType<typeof createMockBucket>
  let connectedPeers: Set<PeerConnection>
  let recordUpload: ReturnType<typeof vi.fn>

  beforeEach(() => {
    engine = new MockEngine()
    storage = createMockStorage()
    bucket = createMockBucket()
    connectedPeers = new Set()
    recordUpload = vi.fn()

    uploader = new TorrentUploader({
      engine,
      infoHash: new Uint8Array(20),
      uploadBucket: bucket,
      isPeerConnected: (peer) => connectedPeers.has(peer),
      canServePiece: () => true,
      recordUpload,
    })
    uploader.setContentStorage(storage)

    // Restore default watermark for tests
    TorrentUploader.SEND_BUFFER_WATERMARK = 512 * 1024
    TorrentUploader.MAX_REQUEST_QUEUE_PER_PEER = 500
  })

  function addPeer(): PeerConnection {
    const peer = createMockPeer(engine)
    peer.amChoking = false // We're not choking them
    connectedPeers.add(peer)
    return peer
  }

  describe('queueRequest', () => {
    it('queues request for unchoked peer', () => {
      const peer = addPeer()
      expect(uploader.queueRequest(peer, 0, 0, 16384)).toBe(true)
      expect(uploader.queueLength).toBe(1)
    })

    it('rejects request from choked peer', () => {
      const peer = addPeer()
      peer.amChoking = true
      expect(uploader.queueRequest(peer, 0, 0, 16384)).toBe(false)
      expect(uploader.queueLength).toBe(0)
    })

    it('rejects request when piece not serveable', () => {
      const customUploader = new TorrentUploader({
        engine,
        infoHash: new Uint8Array(20),
        uploadBucket: bucket,
        isPeerConnected: (peer) => connectedPeers.has(peer),
        canServePiece: () => false,
        recordUpload,
      })
      customUploader.setContentStorage(storage)
      const peer = addPeer()
      expect(customUploader.queueRequest(peer, 0, 0, 16384)).toBe(false)
    })

    it('rejects request when no content storage', () => {
      uploader.setContentStorage(null)
      const peer = addPeer()
      expect(uploader.queueRequest(peer, 0, 0, 16384)).toBe(false)
    })

    it('creates per-peer queues', () => {
      const peer1 = addPeer()
      const peer2 = addPeer()
      uploader.queueRequest(peer1, 0, 0, 16384)
      uploader.queueRequest(peer2, 1, 0, 16384)
      uploader.queueRequest(peer1, 2, 0, 16384)
      expect(uploader.queueLength).toBe(3)
    })

    it('enforces per-peer queue limit', () => {
      TorrentUploader.MAX_REQUEST_QUEUE_PER_PEER = 3
      const peer = addPeer()
      expect(uploader.queueRequest(peer, 0, 0, 16384)).toBe(true)
      expect(uploader.queueRequest(peer, 1, 0, 16384)).toBe(true)
      expect(uploader.queueRequest(peer, 2, 0, 16384)).toBe(true)
      expect(uploader.queueRequest(peer, 3, 0, 16384)).toBe(false)
      expect(uploader.queueLength).toBe(3)
    })

    it('does NOT trigger reads (pull model)', () => {
      const peer = addPeer()
      uploader.queueRequest(peer, 0, 0, 16384)
      expect(storage.read).not.toHaveBeenCalled()
    })
  })

  describe('fillSendBuffers', () => {
    it('issues reads for queued requests', () => {
      const peer = addPeer()
      uploader.queueRequest(peer, 0, 0, 16384)
      uploader.queueRequest(peer, 1, 0, 16384)

      uploader.fillSendBuffers([peer])

      expect(storage.read).toHaveBeenCalledTimes(2)
      expect(storage.read).toHaveBeenCalledWith(0, 0, 16384)
      expect(storage.read).toHaveBeenCalledWith(1, 0, 16384)
    })

    it('sends piece data after read completes', async () => {
      const peer = addPeer()
      const sendPiece = vi.spyOn(peer, 'sendPiece')
      uploader.queueRequest(peer, 5, 0, 16384)

      uploader.fillSendBuffers([peer])
      expect(storage.pendingReads.length).toBe(1)

      storage.resolveNext()
      await vi.waitFor(() => expect(sendPiece).toHaveBeenCalledTimes(1))
      expect(sendPiece).toHaveBeenCalledWith(5, 0, expect.any(Uint8Array))
      expect(recordUpload).toHaveBeenCalledWith(16384)
    })

    it('stops at watermark', () => {
      TorrentUploader.SEND_BUFFER_WATERMARK = 32768
      const peer = addPeer()
      // Queue 3 requests of 16384 bytes each
      uploader.queueRequest(peer, 0, 0, 16384)
      uploader.queueRequest(peer, 1, 0, 16384)
      uploader.queueRequest(peer, 2, 0, 16384)

      uploader.fillSendBuffers([peer])

      // With watermark 32768: first read (readingBytes=16384 < 32768), second read
      // (readingBytes=32768 >= 32768) -> should stop after 2 reads
      expect(storage.read).toHaveBeenCalledTimes(2)
      // Third request stays queued
      expect(uploader.queueLength).toBe(1)
    })

    it('preserves requests when watermark full', () => {
      TorrentUploader.SEND_BUFFER_WATERMARK = 16384
      const peer = addPeer()
      uploader.queueRequest(peer, 0, 0, 16384)
      uploader.queueRequest(peer, 1, 0, 16384)

      uploader.fillSendBuffers([peer])

      // Only first request issued (readingBytes becomes 16384 >= watermark)
      expect(storage.read).toHaveBeenCalledTimes(1)
      // Second request preserved in queue
      expect(uploader.queueLength).toBe(1)
    })

    it('resumes after reads complete and send buffer is flushed', async () => {
      TorrentUploader.SEND_BUFFER_WATERMARK = 16384
      const peer = addPeer()
      uploader.queueRequest(peer, 0, 0, 16384)
      uploader.queueRequest(peer, 1, 0, 16384)

      uploader.fillSendBuffers([peer])
      expect(storage.read).toHaveBeenCalledTimes(1)

      // Complete the first read — sendPiece() adds data to sendQueue
      storage.resolveNext()
      await vi.waitFor(() => expect(recordUpload).toHaveBeenCalledTimes(1))

      // Simulate OUTPUT phase flushing the send queue
      peer.flush()
      expect(peer.sendBufferBytes).toBe(0)

      // Next fillSendBuffers should issue the second read
      uploader.fillSendBuffers([peer])
      expect(storage.read).toHaveBeenCalledTimes(2)
    })

    it('accounts for sendBufferBytes in watermark check', () => {
      TorrentUploader.SEND_BUFFER_WATERMARK = 32768
      const peer = addPeer()

      // Simulate existing data in send buffer by sending a message first
      // We use sendHave which adds data to sendQueue
      peer.amChoking = false
      // Directly queue something to inflate sendBufferBytes
      // sendHave adds a ~9 byte message, but we need something bigger
      // Let's queue requests and check watermark with pre-existing buffer
      // Actually, let's use a different approach: create a peer with data already in buffer
      for (let i = 0; i < 2; i++) {
        // Each sendHave adds ~9 bytes, not enough. Let's use sendPiece with big data
        peer.sendPiece(0, 0, new Uint8Array(16384))
      }
      // Now peer.sendBufferBytes should be ~32780 (2 * (16384 + 13 byte header))
      expect(peer.sendBufferBytes).toBeGreaterThanOrEqual(32768)

      uploader.queueRequest(peer, 0, 0, 16384)
      uploader.fillSendBuffers([peer])

      // Watermark exceeded from sendBufferBytes alone — no reads issued
      expect(storage.read).not.toHaveBeenCalled()
      expect(uploader.queueLength).toBe(1)
    })

    it('discards requests from choked peers', () => {
      const peer = addPeer()
      uploader.queueRequest(peer, 0, 0, 16384)
      uploader.queueRequest(peer, 1, 0, 16384)

      // Now choke the peer
      peer.amChoking = true
      uploader.fillSendBuffers([peer])

      // Requests should be discarded, no reads issued
      expect(storage.read).not.toHaveBeenCalled()
      expect(uploader.queueLength).toBe(0)
    })

    it('does not send to disconnected peer after read completes', async () => {
      const peer = addPeer()
      const sendPiece = vi.spyOn(peer, 'sendPiece')
      uploader.queueRequest(peer, 0, 0, 16384)

      uploader.fillSendBuffers([peer])

      // Disconnect peer before read completes
      connectedPeers.delete(peer)
      storage.resolveNext()

      // Wait for microtask
      await Promise.resolve()
      expect(sendPiece).not.toHaveBeenCalled()
      expect(recordUpload).not.toHaveBeenCalled()
    })

    it('does not send to peer choked after read completes', async () => {
      const peer = addPeer()
      const sendPiece = vi.spyOn(peer, 'sendPiece')
      uploader.queueRequest(peer, 0, 0, 16384)

      uploader.fillSendBuffers([peer])

      peer.amChoking = true
      storage.resolveNext()

      await Promise.resolve()
      expect(sendPiece).not.toHaveBeenCalled()
    })

    it('handles read errors gracefully', async () => {
      const peer = addPeer()
      uploader.queueRequest(peer, 0, 0, 16384)

      uploader.fillSendBuffers([peer])
      storage.rejectNext(new Error('disk read failed'))

      // Should not throw
      await Promise.resolve()
      expect(recordUpload).not.toHaveBeenCalled()
    })

    it('handles multiple peers independently', () => {
      TorrentUploader.SEND_BUFFER_WATERMARK = 16384
      const peer1 = addPeer()
      const peer2 = addPeer()

      uploader.queueRequest(peer1, 0, 0, 16384)
      uploader.queueRequest(peer1, 1, 0, 16384)
      uploader.queueRequest(peer2, 2, 0, 16384)
      uploader.queueRequest(peer2, 3, 0, 16384)

      uploader.fillSendBuffers([peer1, peer2])

      // Each peer should get 1 read (watermark = 16384, each read = 16384)
      expect(storage.read).toHaveBeenCalledTimes(2)
      expect(storage.read).toHaveBeenCalledWith(0, 0, 16384)
      expect(storage.read).toHaveBeenCalledWith(2, 0, 16384)
    })

    it('skips peers with no queued requests', () => {
      const peer1 = addPeer()
      const peer2 = addPeer()
      uploader.queueRequest(peer1, 0, 0, 16384)
      // peer2 has no requests

      uploader.fillSendBuffers([peer1, peer2])

      expect(storage.read).toHaveBeenCalledTimes(1)
      expect(storage.read).toHaveBeenCalledWith(0, 0, 16384)
    })

    it('does nothing when no content storage', () => {
      const peer = addPeer()
      uploader.queueRequest(peer, 0, 0, 16384)
      uploader.setContentStorage(null)

      uploader.fillSendBuffers([peer])
      expect(storage.read).not.toHaveBeenCalled()
    })
  })

  describe('rate limiting', () => {
    it('stops all peers when rate limited', () => {
      bucket.isLimited = true
      bucket.tryConsume.mockReturnValue(false)

      const peer1 = addPeer()
      const peer2 = addPeer()
      uploader.queueRequest(peer1, 0, 0, 16384)
      uploader.queueRequest(peer2, 1, 0, 16384)

      uploader.fillSendBuffers([peer1, peer2])

      // Rate limit hit on first peer's first request — stops entirely
      expect(storage.read).not.toHaveBeenCalled()
      // All requests preserved
      expect(uploader.queueLength).toBe(2)
    })

    it('consumes tokens for issued reads', () => {
      bucket.isLimited = true
      bucket.tryConsume.mockReturnValue(true)

      const peer = addPeer()
      uploader.queueRequest(peer, 0, 0, 16384)
      uploader.queueRequest(peer, 1, 0, 16384)

      uploader.fillSendBuffers([peer])

      expect(bucket.tryConsume).toHaveBeenCalledTimes(2)
      expect(bucket.tryConsume).toHaveBeenCalledWith(16384)
    })

    it('does not check rate limit when unlimited', () => {
      bucket.isLimited = false

      const peer = addPeer()
      uploader.queueRequest(peer, 0, 0, 16384)

      uploader.fillSendBuffers([peer])

      expect(bucket.tryConsume).not.toHaveBeenCalled()
      expect(storage.read).toHaveBeenCalledTimes(1)
    })
  })

  describe('removeQueuedUploads', () => {
    it('removes all queued requests for a peer', () => {
      const peer = addPeer()
      uploader.queueRequest(peer, 0, 0, 16384)
      uploader.queueRequest(peer, 1, 0, 16384)

      const removed = uploader.removeQueuedUploads(peer)
      expect(removed).toBe(2)
      expect(uploader.queueLength).toBe(0)
    })

    it('does not affect other peers', () => {
      const peer1 = addPeer()
      const peer2 = addPeer()
      uploader.queueRequest(peer1, 0, 0, 16384)
      uploader.queueRequest(peer2, 1, 0, 16384)

      uploader.removeQueuedUploads(peer1)
      expect(uploader.queueLength).toBe(1)
    })

    it('returns 0 for peer with no state', () => {
      const peer = addPeer()
      expect(uploader.removeQueuedUploads(peer)).toBe(0)
    })
  })
})
