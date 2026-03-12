import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { SubscriptionManager, TORRENTS_HASH } from '../../../src/adapters/native/subscriptions'
import type { BtEngine } from '../../../src/core/bt-engine'
import type { Torrent } from '../../../src/core/torrent'
import { EventEmitter } from 'events'

// Mock the native bindings
vi.stubGlobal('__jstorrent_on_state_update', vi.fn())
vi.stubGlobal('__jstorrent_on_error', vi.fn())

// Helper to create a mock torrent
function createMockTorrent(infoHash: string, options: Partial<Torrent> = {}): Torrent {
  const emitter = new EventEmitter()
  return {
    infoHash: new Uint8Array(Buffer.from(infoHash, 'hex')),
    name: options.name ?? 'Test Torrent',
    progress: options.progress ?? 0.5,
    downloadSpeed: options.downloadSpeed ?? 1000,
    uploadSpeed: options.uploadSpeed ?? 500,
    activityState: 'downloading',
    numPeers: 5,
    swarm: { total: 10 },
    filePriorities: [0, 0, 1],
    hasMetadata: true,
    totalUploaded: 5000,
    addedAt: Date.now() - 10000,
    eta: 3600,
    errorMessage: undefined,
    piecesCount: 100,
    completedPiecesCount: 50,
    pieceLength: 16384,
    lastPieceLength: 8192,
    bitfield: {
      toHex: () => 'ff'.repeat(13),
      count: () => 50,
    },
    files: [
      { path: 'file1.txt', length: 1000, downloaded: 500 },
      { path: 'file2.txt', length: 2000, downloaded: 2000 },
    ],
    magnetLink: 'magnet:?xt=urn:btih:' + infoHash,
    announce: ['http://tracker.example.com/announce'],
    comment: 'Test comment',
    createdBy: 'test',
    creationDate: Date.now() - 100000,
    isPrivate: false,
    completedAt: null,
    getDisplayPeers: () => [
      {
        key: '1.2.3.4:6881',
        ip: '1.2.3.4',
        port: 6881,
        kind: 'peer',
        state: 'connected',
        connection: {
          downloadSpeed: 500,
          uploadSpeed: 100,
          downloaded: 4096,
          uploaded: 1024,
          requestsPending: 2,
          bitfield: { count: () => 30 },
          isEncrypted: true,
          isIncoming: false,
          amInterested: true,
          peerChoking: false,
          peerInterested: false,
          amChoking: true,
        },
        swarmPeer: { clientName: 'µTorrent', source: 'tracker' },
        clientName: 'µTorrent',
        source: 'tracker',
        progress: 0.3,
        downloadSpeed: 500,
        uploadSpeed: 100,
        downloaded: 4096,
        uploaded: 1024,
        requestsPending: 2,
        isEncrypted: true,
        isIncoming: false,
        amInterested: true,
        peerChoking: false,
        peerInterested: false,
        amChoking: true,
        webSeedUrl: null,
        webSeedRetryAt: null,
        webSeedRemoteAddress: null,
      },
      {
        key: 'webseed:https://cdn.example.com/file.bin',
        ip: 'cdn.example.com',
        port: 443,
        kind: 'webseed',
        state: 'webseed-active',
        connection: null,
        swarmPeer: null,
        clientName: 'Web Seed',
        source: 'webseed',
        progress: null,
        downloadSpeed: 12345,
        uploadSpeed: 0,
        downloaded: 65536,
        uploaded: 0,
        requestsPending: 1,
        isEncrypted: true,
        isIncoming: false,
        amInterested: false,
        peerChoking: true,
        peerInterested: false,
        amChoking: true,
        webSeedUrl: 'https://cdn.example.com/file.bin',
        webSeedRetryAt: null,
        webSeedRemoteAddress: '203.0.113.10',
      },
    ],
    getTrackerStats: () => [
      {
        url: 'http://tracker.example.com/announce',
        type: 'http',
        status: 'ok',
        seeders: 10,
        leechers: 5,
        lastPeersReceived: 5,
        uniquePeersDiscovered: 15,
        lastError: undefined,
        connectionFamily: 'ipv4',
      },
    ],
    getActivePieceManager: () => ({
      activeCount: 3,
      partialKeys: () => [1, 2],
      fullyRequestedKeys: () => [3],
      fullyRespondedKeys: () => [],
    }),
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    ...options,
  } as unknown as Torrent
}

// Helper to create a mock engine
function createMockEngine(torrents: Torrent[] = []): BtEngine {
  const emitter = new EventEmitter()
  return {
    torrents,
    getTorrent: (hash: string) =>
      torrents.find((t) => Buffer.from(t.infoHash).toString('hex') === hash),
    storageRootManager: {
      getRootForTorrent: () => ({ key: 'default', label: 'Default', path: '/downloads' }),
    },
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
  } as unknown as BtEngine
}

describe('SubscriptionManager', () => {
  let manager: SubscriptionManager
  let engine: BtEngine
  let pushCallback: ReturnType<typeof vi.fn>
  let torrent: Torrent

  beforeEach(() => {
    vi.useFakeTimers()
    torrent = createMockTorrent('a'.repeat(40))
    engine = createMockEngine([torrent])
    pushCallback = vi.fn()
    manager = new SubscriptionManager(engine, pushCallback)
  })

  afterEach(() => {
    manager.destroy()
    vi.useRealTimers()
  })

  describe('subscribe', () => {
    it('should add subscription to the set', () => {
      manager.subscribe('state', TORRENTS_HASH, 500)
      expect(manager.hasSubscriptions()).toBe(true)
      expect(manager.getSubscriptionCount()).toBe(1)
    })

    it('should support multiple subscription types for same hash', () => {
      const hash = 'a'.repeat(40)
      manager.subscribe('peers', hash, 500)
      manager.subscribe('files', hash, 500)
      expect(manager.getSubscriptionCount()).toBe(1) // Still one hash entry
    })

    it('should trigger immediate push on subscribe', () => {
      manager.subscribe('state', TORRENTS_HASH, 500)
      expect(pushCallback).toHaveBeenCalledTimes(1)
    })

    it('should set the push interval', () => {
      manager.subscribe('state', TORRENTS_HASH, 1000)
      pushCallback.mockClear()

      // Advance time less than interval - should not push
      vi.advanceTimersByTime(500)
      expect(pushCallback).not.toHaveBeenCalled()

      // Advance to interval - should push
      vi.advanceTimersByTime(500)
      expect(pushCallback).toHaveBeenCalledTimes(1)
    })

    it('should update interval when subscribing with different interval', () => {
      manager.subscribe('state', TORRENTS_HASH, 1000)
      pushCallback.mockClear()

      manager.subscribe('peers', 'a'.repeat(40), 200)
      pushCallback.mockClear() // Clear the immediate push from subscribe

      // With 200ms interval, should push after 200ms
      vi.advanceTimersByTime(200)
      expect(pushCallback).toHaveBeenCalledTimes(1)
    })
  })

  describe('unsubscribe', () => {
    it('should remove specific subscription type', () => {
      const hash = 'a'.repeat(40)
      manager.subscribe('peers', hash, 500)
      manager.subscribe('files', hash, 500)
      pushCallback.mockClear()

      manager.unsubscribe('peers', hash)

      // Files should still be subscribed
      expect(manager.hasSubscriptions()).toBe(true)
    })

    it('should remove hash entry when last type unsubscribed', () => {
      const hash = 'a'.repeat(40)
      manager.subscribe('peers', hash, 500)

      manager.unsubscribe('peers', hash)

      expect(manager.hasSubscriptions()).toBe(false)
    })

    it('should not error when unsubscribing non-existent type', () => {
      expect(() => manager.unsubscribe('peers', 'nonexistent')).not.toThrow()
    })
  })

  describe('unsubscribeAll', () => {
    it('should remove all subscriptions for a hash', () => {
      const hash = 'a'.repeat(40)
      manager.subscribe('peers', hash, 500)
      manager.subscribe('files', hash, 500)
      manager.subscribe('trackers', hash, 500)

      manager.unsubscribeAll(hash)

      expect(manager.getSubscriptionCount()).toBe(0)
    })

    it('should not affect other hashes', () => {
      manager.subscribe('state', TORRENTS_HASH, 500)
      manager.subscribe('peers', 'a'.repeat(40), 500)

      manager.unsubscribeAll('a'.repeat(40))

      expect(manager.hasSubscriptions()).toBe(true)
      expect(manager.getSubscriptionCount()).toBe(1)
    })
  })

  describe('pause/resume', () => {
    it('should stop push loop when paused', () => {
      manager.subscribe('state', TORRENTS_HASH, 500)
      pushCallback.mockClear()

      manager.pause()

      vi.advanceTimersByTime(1000)
      expect(pushCallback).not.toHaveBeenCalled()
    })

    it('should restart push loop when resumed', () => {
      manager.subscribe('state', TORRENTS_HASH, 500)
      manager.pause()
      pushCallback.mockClear()

      manager.resume()

      // Should push immediately on resume
      expect(pushCallback).toHaveBeenCalledTimes(1)
    })

    it('should continue pushing at interval after resume', () => {
      manager.subscribe('state', TORRENTS_HASH, 500)
      manager.pause()
      manager.resume()
      pushCallback.mockClear()

      vi.advanceTimersByTime(500)
      expect(pushCallback).toHaveBeenCalledTimes(1)
    })
  })

  describe('clear', () => {
    it('should remove all subscriptions', () => {
      manager.subscribe('state', TORRENTS_HASH, 500)
      manager.subscribe('peers', 'a'.repeat(40), 500)

      manager.clear()

      expect(manager.hasSubscriptions()).toBe(false)
      expect(manager.getSubscriptionCount()).toBe(0)
    })

    it('should stop the push loop', () => {
      manager.subscribe('state', TORRENTS_HASH, 500)
      manager.clear()
      pushCallback.mockClear()

      vi.advanceTimersByTime(1000)
      expect(pushCallback).not.toHaveBeenCalled()
    })
  })

  describe('torrent removal cleanup', () => {
    it('should clean up subscriptions when torrent is removed', () => {
      const hash = 'a'.repeat(40)
      manager.subscribe('peers', hash, 500)

      // Emit torrent-removed event
      ;(engine as unknown as EventEmitter).emit('torrent-removed', torrent)

      expect(manager.hasSubscriptions()).toBe(false)
    })
  })

  describe('payload building', () => {
    it('should include torrents only when torrents type is subscribed', () => {
      manager.subscribe('torrents', TORRENTS_HASH, 500)

      const call = pushCallback.mock.calls[0][0]
      const payload = JSON.parse(call)

      expect(payload.torrents).toBeDefined()
      expect(payload.torrents.length).toBe(1)
    })

    it('should NOT include torrents when torrents type is not subscribed', () => {
      manager.subscribe('peers', 'a'.repeat(40), 500)

      const call = pushCallback.mock.calls[0][0]
      const payload = JSON.parse(call)

      expect(payload.torrents).toBeUndefined()
    })

    it('should include peers data when subscribed', () => {
      const hash = 'a'.repeat(40)
      manager.subscribe('peers', hash, 500)

      const call = pushCallback.mock.calls[0][0]
      const payload = JSON.parse(call)

      expect(payload.peers).toBeDefined()
      expect(payload.peers[hash]).toBeDefined()
      expect(payload.peers[hash][0].ip).toBe('1.2.3.4')
      expect(payload.peers[hash][1]).toMatchObject({
        kind: 'webseed',
        source: 'webseed',
        clientName: 'Web Seed',
        ip: 'cdn.example.com',
        downloadSpeed: 12345,
        downloaded: 65536,
        requestsPending: 1,
        webSeedUrl: 'https://cdn.example.com/file.bin',
      })
    })

    it('should include files data when subscribed', () => {
      const hash = 'a'.repeat(40)
      manager.subscribe('files', hash, 500)

      const call = pushCallback.mock.calls[0][0]
      const payload = JSON.parse(call)

      expect(payload.files).toBeDefined()
      expect(payload.files[hash]).toBeDefined()
      expect(payload.files[hash].files.length).toBe(2)
    })

    it('should include trackers data when subscribed', () => {
      const hash = 'a'.repeat(40)
      manager.subscribe('trackers', hash, 500)

      const call = pushCallback.mock.calls[0][0]
      const payload = JSON.parse(call)

      expect(payload.trackers).toBeDefined()
      expect(payload.trackers[hash]).toBeDefined()
      expect(payload.trackers[hash][0].url).toBe('http://tracker.example.com/announce')
    })

    it('should include pieces data when subscribed', () => {
      const hash = 'a'.repeat(40)
      manager.subscribe('pieces', hash, 500)

      const call = pushCallback.mock.calls[0][0]
      const payload = JSON.parse(call)

      expect(payload.pieces).toBeDefined()
      expect(payload.pieces[hash]).toBeDefined()
      expect(payload.pieces[hash].piecesTotal).toBe(100)
      expect(payload.pieces[hash].bitfield).toBeDefined()
    })

    it('should include details data when subscribed', () => {
      const hash = 'a'.repeat(40)
      manager.subscribe('details', hash, 500)

      const call = pushCallback.mock.calls[0][0]
      const payload = JSON.parse(call)

      expect(payload.details).toBeDefined()
      expect(payload.details[hash]).toBeDefined()
      expect(payload.details[hash].comment).toBe('Test comment')
    })

    it('should return empty object when no subscriptions', () => {
      // Create a new manager and don't subscribe to anything
      const emptyEngine = createMockEngine([])
      const emptyPush = vi.fn()
      const emptyManager = new SubscriptionManager(emptyEngine, emptyPush)

      // Manually trigger a push by subscribing and immediately unsubscribing
      emptyManager.subscribe('torrents', TORRENTS_HASH, 500)
      const payload = JSON.parse(emptyPush.mock.calls[0][0])

      // With no torrents, should still have torrents array (just empty)
      expect(payload.torrents).toEqual([])

      emptyManager.destroy()
    })

    it('should return null for non-existent torrent', () => {
      const nonExistentHash = 'b'.repeat(40)
      manager.subscribe('peers', nonExistentHash, 500)

      const call = pushCallback.mock.calls[0][0]
      const payload = JSON.parse(call)

      // Peers should not be set since torrent doesn't exist
      expect(payload.peers).toBeUndefined()
    })

    it('should include multiple subscription types in single payload', () => {
      const hash = 'a'.repeat(40)
      manager.subscribe('torrents', TORRENTS_HASH, 500)
      pushCallback.mockClear()
      manager.subscribe('peers', hash, 500)
      pushCallback.mockClear()
      manager.subscribe('files', hash, 500)

      const call = pushCallback.mock.calls[0][0]
      const payload = JSON.parse(call)

      expect(payload.torrents).toBeDefined()
      expect(payload.peers).toBeDefined()
      expect(payload.files).toBeDefined()
    })
  })

  describe('piece changes tracking', () => {
    it('should include piece changes in torrents payload', () => {
      manager.subscribe('torrents', TORRENTS_HASH, 500)
      pushCallback.mockClear()

      // Simulate piece completion
      torrent.emit('piece', 42)

      vi.advanceTimersByTime(500)

      const call = pushCallback.mock.calls[0][0]
      const payload = JSON.parse(call)

      expect(payload.pieceChanges).toBeDefined()
      const hash = 'a'.repeat(40)
      expect(payload.pieceChanges[hash]).toContain(42)
    })

    it('should include piece changes in pieces subscription payload', () => {
      const hash = 'a'.repeat(40)
      manager.subscribe('pieces', hash, 500)
      pushCallback.mockClear()

      // Simulate piece completion
      torrent.emit('piece', 42)

      vi.advanceTimersByTime(500)

      const call = pushCallback.mock.calls[0][0]
      const payload = JSON.parse(call)

      expect(payload.pieces).toBeDefined()
      expect(payload.pieces[hash].recentChanges).toContain(42)
    })

    it('should clear piece changes after push', () => {
      const hash = 'a'.repeat(40)
      manager.subscribe('pieces', hash, 500)
      torrent.emit('piece', 42)
      pushCallback.mockClear()

      vi.advanceTimersByTime(500)
      const call1 = pushCallback.mock.calls[0][0]
      const payload1 = JSON.parse(call1)
      expect(payload1.pieces[hash].recentChanges).toContain(42)

      pushCallback.mockClear()
      vi.advanceTimersByTime(500)
      const call2 = pushCallback.mock.calls[0][0]
      const payload2 = JSON.parse(call2)
      expect(payload2.pieces[hash].recentChanges).toEqual([])
    })
  })

  describe('active piece states', () => {
    it('should include active piece states in torrents payload', () => {
      manager.subscribe('torrents', TORRENTS_HASH, 500)

      const call = pushCallback.mock.calls[0][0]
      const payload = JSON.parse(call)

      expect(payload.activePieceStates).toBeDefined()
      const hash = 'a'.repeat(40)
      expect(payload.activePieceStates[hash]).toBeDefined()
    })

    it('should include active piece states in pieces subscription', () => {
      const hash = 'a'.repeat(40)
      manager.subscribe('pieces', hash, 500)

      const call = pushCallback.mock.calls[0][0]
      const payload = JSON.parse(call)

      expect(payload.pieces[hash].activePieceStates).toBeDefined()
    })
  })
})
