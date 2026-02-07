import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BtEngine } from '../../src/core/bt-engine'
import { InMemoryFileSystem } from '../../src/adapters/memory'
import { ISocketFactory } from '../../src/interfaces/socket'
import { MemoryConfigHub } from '../../src/config/memory-config-hub'
import type { Torrent } from '../../src/core/torrent'

const mockSocketFactory: ISocketFactory = {
  createTcpSocket: vi.fn(),
  createUdpSocket: vi.fn().mockResolvedValue({
    send: vi.fn(),
    onMessage: vi.fn(),
    close: vi.fn(),
  }),
  createTcpServer: vi.fn().mockReturnValue({
    on: vi.fn(),
    listen: vi.fn(),
    address: vi.fn().mockReturnValue({ port: 0 }),
  }),
  wrapTcpSocket: vi.fn(),
}

function makeMagnet(hash: string, name: string): string {
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}`
}

// Unique hash per test torrent (40 hex chars each)
const HASHES = [
  'a'.repeat(40),
  'b'.repeat(40),
  'c'.repeat(40),
  'd'.repeat(40),
  'e'.repeat(40),
  'f'.repeat(40),
  '1'.repeat(40),
  '2'.repeat(40),
]

describe('TorrentQueueManager', () => {
  let engine: BtEngine
  let config: MemoryConfigHub

  beforeEach(() => {
    config = new MemoryConfigHub({
      activeDownloads: 2,
      activeSeeds: 2,
    })
    engine = new BtEngine({
      downloadPath: '/downloads',
      socketFactory: mockSocketFactory,
      fileSystem: new InMemoryFileSystem(),
      config,
      _skipDHTBootstrap: true,
    })
  })

  async function addTorrent(hashIndex: number, name?: string): Promise<Torrent> {
    const n = name ?? `torrent-${hashIndex}`
    const { torrent } = await engine.addTorrent(makeMagnet(HASHES[hashIndex], n))
    if (!torrent) throw new Error('Failed to add torrent')
    return torrent
  }

  function recalc(): void {
    engine.queueManager!.recalculateImmediate()
  }

  describe('basic queue enforcement', () => {
    it('should keep torrents within activeDownloads limit active', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      recalc()

      expect(t1.userState).toBe('active')
      expect(t2.userState).toBe('active')
    })

    it('should queue torrents beyond activeDownloads limit', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)
      recalc()

      expect(t1.userState).toBe('active')
      expect(t2.userState).toBe('active')
      expect(t3.userState).toBe('queued')
    })

    it('should promote next queued torrent when active one is removed', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)
      recalc()

      expect(t3.userState).toBe('queued')

      await engine.removeTorrent(t1)
      recalc()

      expect(t2.userState).toBe('active')
      expect(t3.userState).toBe('active')
    })

    it('should promote next queued torrent when active one is stopped', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)
      recalc()

      expect(t3.userState).toBe('queued')

      t1.userStop()
      recalc()

      expect(t1.userState).toBe('stopped')
      expect(t2.userState).toBe('active')
      expect(t3.userState).toBe('active')
    })
  })

  describe('queue positions', () => {
    it('should assign sequential queue positions', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)

      expect(t1.queuePosition).toBe(0)
      expect(t2.queuePosition).toBe(1)
      expect(t3.queuePosition).toBe(2)
    })

    it('should close position gap on removal', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)

      await engine.removeTorrent(t2)

      expect(t1.queuePosition).toBe(0)
      expect(t3.queuePosition).toBe(1)
    })

    it('should stay contiguous after multiple removals', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)
      const t4 = await addTorrent(3)

      await engine.removeTorrent(t1)
      await engine.removeTorrent(t3)

      expect(t2.queuePosition).toBe(0)
      expect(t4.queuePosition).toBe(1)
    })
  })

  describe('moveToTop / moveToBottom', () => {
    it('should move torrent to top of queue', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)

      engine.queueMoveToTop(t3)

      expect(t3.queuePosition).toBe(0)
      expect(t1.queuePosition).toBe(1)
      expect(t2.queuePosition).toBe(2)
    })

    it('should move torrent to top and promote it if under limit', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)
      recalc()

      expect(t3.userState).toBe('queued')

      engine.queueMoveToTop(t3)
      recalc()

      // t3 now at position 0, should be active
      expect(t3.userState).toBe('active')
      expect(t1.userState).toBe('active')
      // t2 now at position 2, should be queued
      expect(t2.userState).toBe('queued')
    })

    it('should move torrent to bottom of queue', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)

      engine.queueMoveToBottom(t1)

      expect(t2.queuePosition).toBe(0)
      expect(t3.queuePosition).toBe(1)
      expect(t1.queuePosition).toBe(2)
    })
  })

  describe('user-stopped torrents', () => {
    it('should skip stopped torrents in queue evaluation', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)
      recalc()

      // Stop t1 — frees a slot
      t1.userStop()
      recalc()

      expect(t1.userState).toBe('stopped')
      expect(t2.userState).toBe('active')
      expect(t3.userState).toBe('active')
    })

    it('should not count stopped torrents against limits', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)
      const t4 = await addTorrent(3)
      recalc()

      // t1, t2 active; t3, t4 queued
      t1.userStop()
      recalc()

      // Now t2, t3 should be active (t1 stopped, t4 queued)
      expect(t2.userState).toBe('active')
      expect(t3.userState).toBe('active')
      expect(t4.userState).toBe('queued')
    })
  })

  describe('forceStart', () => {
    it('should bypass queue limits', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)
      recalc()

      expect(t3.userState).toBe('queued')

      engine.queueForceStart(t3)
      recalc()

      // t3 is force-started — always active, doesn't count against limits
      expect(t3.forceActive).toBe(true)
      expect(t3.userState).toBe('active')

      // t1 and t2 should still be active (force doesn't displace others)
      expect(t1.userState).toBe('active')
      expect(t2.userState).toBe('active')
    })

    it('should not count force-active torrents against limits', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)
      const t4 = await addTorrent(3)
      recalc()

      // t1, t2 active; t3, t4 queued
      engine.queueForceStart(t1)
      recalc()

      // t1 is force-active (not counted), so t2 and t3 fill the 2 slots
      expect(t1.forceActive).toBe(true)
      expect(t1.userState).toBe('active')
      expect(t2.userState).toBe('active')
      expect(t3.userState).toBe('active')
      expect(t4.userState).toBe('queued')
    })
  })

  describe('config changes', () => {
    it('should recalculate when activeDownloads changes', async () => {
      await addTorrent(0)
      await addTorrent(1)
      const t3 = await addTorrent(2)
      recalc()

      expect(t3.userState).toBe('queued')

      // Increase limit to 3
      config.set('activeDownloads', 3)
      recalc()

      expect(t3.userState).toBe('active')
    })

    it('should queue torrents when activeDownloads decreases', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      recalc()

      expect(t1.userState).toBe('active')
      expect(t2.userState).toBe('active')

      // Decrease limit to 1
      config.set('activeDownloads', 1)
      recalc()

      expect(t1.userState).toBe('active')
      expect(t2.userState).toBe('queued')
    })
  })

  describe('upgrade path', () => {
    it('should assign positions to torrents without queuePosition', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)

      // Simulate upgrade: clear positions
      t1.queuePosition = undefined
      t2.queuePosition = undefined

      // Set different addedAt for ordering
      t2.addedAt = Date.now() - 10000
      t1.addedAt = Date.now()

      recalc()

      // t2 is older, should get lower position
      expect(t2.queuePosition).toBe(0)
      expect(t1.queuePosition).toBe(1)
    })
  })

  describe('starting a stopped torrent', () => {
    it('should respect queue limits when starting a stopped torrent', async () => {
      await addTorrent(0)
      await addTorrent(1)
      const t3 = await addTorrent(2)
      recalc()

      expect(t3.userState).toBe('queued')

      // Stop t3 (was queued, now stopped)
      t3.userStop()
      recalc()

      // Start t3 again — limit is 2, t1 and t2 are active
      await t3.userStart()
      recalc()

      // t3 should be queued since slots are full
      expect(t3.userState).toBe('queued')
    })

    it('should start torrent if under limit', async () => {
      const t1 = await addTorrent(0)
      recalc()

      t1.userStop()
      recalc()

      await t1.userStart()
      recalc()

      expect(t1.userState).toBe('active')
    })
  })

  describe('periodic tick check', () => {
    it('should run recalculation at periodic interval', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)

      // Don't call recalc — let tick check handle it
      // Manually tick enough times for the auto-manage interval
      for (let i = 0; i < 50; i++) {
        engine.queueManager!.tickCheck()
      }

      // After 50 ticks, periodic recalculation should have run
      expect(t1.userState).toBe('active')
      expect(t2.userState).toBe('active')
      expect(t3.userState).toBe('queued')
    })

    it('should run recalculation when dirty flag is set', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)

      // Mark dirty (happens on onTorrentAdded)
      engine.queueManager!.recalculate()

      // Single tick should process if dirty
      engine.queueManager!.tickCheck()

      expect(t1.userState).toBe('active')
      expect(t2.userState).toBe('active')
      expect(t3.userState).toBe('queued')
    })
  })

  describe('torrent completion', () => {
    it('should free download slot when torrent completes', async () => {
      const t1 = await addTorrent(0)
      await addTorrent(1)
      const t3 = await addTorrent(2)
      recalc()

      expect(t3.userState).toBe('queued')

      // Simulate t1 completing (becomes a seeder)
      // We need to set progress to 1 to classify as seeding
      Object.defineProperty(t1, 'progress', { get: () => 1, configurable: true })
      engine.queueManager!.onTorrentCompleted(t1)
      recalc()

      // t1 moves to seed queue, freeing a download slot
      // t3 should now be promoted to active
      expect(t3.userState).toBe('active')
    })
  })

  describe('suspended engine', () => {
    it('should not recalculate when engine is suspended', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)
      recalc()

      engine.suspend()

      // All should retain their states (no recalculation during suspend)
      const statesBefore = [t1.userState, t2.userState, t3.userState]

      engine.queueManager!.recalculateImmediate()

      expect(t1.userState).toBe(statesBefore[0])
      expect(t2.userState).toBe(statesBefore[1])
      expect(t3.userState).toBe(statesBefore[2])
    })
  })

  describe('graceful stop', () => {
    it('should initiate graceful stop when deactivating a torrent', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      recalc()

      expect(t1.userState).toBe('active')
      expect(t2.userState).toBe('active')

      // Reduce limit to 1 — t2 should be gracefully stopped
      config.set('activeDownloads', 1)
      recalc()

      // t2 has no connected peers, so graceful stop completes immediately
      expect(t1.userState).toBe('active')
      expect(t2.userState).toBe('queued')
    })

    it('should cancel graceful stop if torrent falls within limit on recalculate', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)
      recalc()

      expect(t1.userState).toBe('active')
      expect(t2.userState).toBe('active')
      expect(t3.userState).toBe('queued')

      // Simulate t2 being gracefully stopped (has in-flight requests)
      // Use gracefulStop with a long timeout, but it completes immediately (no peers)
      // So we force the flag for testing
      Object.defineProperty(t2, '_gracefulStopping', { value: true, writable: true })

      // Recalc: t2 is at position 1 (within limit=2), so graceful stop is cancelled
      recalc()

      expect(t1.userState).toBe('active')
      expect(t2.userState).toBe('active')
      expect(t2.isGracefulStopping).toBe(false)
      expect(t3.userState).toBe('queued')
    })

    it('should cancel graceful stop when limit increases', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)
      recalc()

      // t3 is queued. Simulate t2 being gracefully stopped
      Object.defineProperty(t2, '_gracefulStopping', { value: true, writable: true })

      // Increase limit to 3 — all torrents should be active, t2's graceful stop cancelled
      config.set('activeDownloads', 3)
      recalc()

      expect(t1.userState).toBe('active')
      expect(t2.userState).toBe('active')
      expect(t2.isGracefulStopping).toBe(false)
      expect(t3.userState).toBe('active')
    })

    it('should complete graceful stop immediately when torrent has no peers', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)
      recalc()

      // t1 active, t2 active, t3 queued
      expect(t3.userState).toBe('queued')

      // Reduce limit to 1 — t2 over limit, graceful stop → immediate (no peers)
      config.set('activeDownloads', 1)
      recalc()

      expect(t1.userState).toBe('active')
      expect(t2.userState).toBe('queued')
      expect(t3.userState).toBe('queued')
    })
  })

  describe('errored torrents', () => {
    it('should skip errored torrents in queue evaluation', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)
      recalc()

      expect(t3.userState).toBe('queued')

      // Simulate error on t1
      t1.errorMessage = 'Write failed: disk full'
      recalc()

      // t1 errored — skipped by queue, frees a download slot
      // t3 should now be promoted
      expect(t2.userState).toBe('active')
      expect(t3.userState).toBe('active')
    })

    it('should not count errored torrents against limits', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)
      const t4 = await addTorrent(3)
      recalc()

      // t1, t2 active; t3, t4 queued
      t1.errorMessage = 'Connection failed'
      t2.errorMessage = 'Hash mismatch'
      recalc()

      // Both errored torrents skipped — t3 and t4 fill the 2 slots
      expect(t3.userState).toBe('active')
      expect(t4.userState).toBe('active')
    })
  })

  describe('session restore with queue', () => {
    it('should respect persisted queue positions after restore', async () => {
      // Add torrents and set queue positions manually (simulating restore)
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)

      // Simulate restore order different from queue position order
      t3.queuePosition = 0
      t1.queuePosition = 1
      t2.queuePosition = 2

      recalc()

      // t3 is at position 0, t1 at position 1 — they should be active
      // t2 at position 2 — should be queued
      expect(t3.userState).toBe('active')
      expect(t1.userState).toBe('active')
      expect(t2.userState).toBe('queued')
    })

    it('should assign positions to unpositioned torrents on first recalculate', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)

      // Clear positions (simulating upgrade from pre-queue version)
      t1.queuePosition = undefined
      t2.queuePosition = undefined
      t3.queuePosition = undefined

      // Set addedAt to control ordering
      t1.addedAt = 1000
      t2.addedAt = 2000
      t3.addedAt = 3000

      recalc()

      // Should be assigned by addedAt (oldest first)
      expect(t1.queuePosition).toBe(0)
      expect(t2.queuePosition).toBe(1)
      expect(t3.queuePosition).toBe(2)

      // With limit=2, t3 should be queued
      expect(t1.userState).toBe('active')
      expect(t2.userState).toBe('active')
      expect(t3.userState).toBe('queued')
    })

    it('should handle mixed positioned and unpositioned torrents', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)

      // t1 has position (existing), t2 and t3 don't (upgrading)
      t1.queuePosition = 0
      t2.queuePosition = undefined
      t3.queuePosition = undefined

      t2.addedAt = 1000
      t3.addedAt = 2000

      recalc()

      // t2 and t3 assigned after t1's position
      expect(t1.queuePosition).toBe(0)
      expect(t2.queuePosition).toBe(1)
      expect(t3.queuePosition).toBe(2)
    })
  })

  describe('user override semantics', () => {
    it('user stop on queued torrent removes from queue', async () => {
      await addTorrent(0)
      await addTorrent(1)
      const t3 = await addTorrent(2)
      recalc()

      expect(t3.userState).toBe('queued')

      // User stops the queued torrent
      t3.userStop()

      expect(t3.userState).toBe('stopped')
    })

    it('user start on stopped torrent re-enters queue', async () => {
      await addTorrent(0)
      await addTorrent(1)
      const t3 = await addTorrent(2)
      recalc()

      // Stop and restart t3
      t3.userStop()
      await t3.userStart()
      recalc()

      // Slots still full — t3 should be queued
      expect(t3.userState).toBe('queued')
      expect(t3.forceActive).toBe(false)
    })

    it('force start bypasses limits without displacing others', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)
      recalc()

      expect(t3.userState).toBe('queued')

      engine.queueForceStart(t3)
      recalc()

      // All three active — force doesn't displace
      expect(t1.userState).toBe('active')
      expect(t2.userState).toBe('active')
      expect(t3.userState).toBe('active')
      expect(t3.forceActive).toBe(true)
    })

    it('user stop frees slot and promotes next queued', async () => {
      const t1 = await addTorrent(0)
      await addTorrent(1)
      const t3 = await addTorrent(2)
      recalc()

      expect(t3.userState).toBe('queued')

      t1.userStop()
      recalc()

      expect(t1.userState).toBe('stopped')
      expect(t3.userState).toBe('active')
    })
  })

  describe('done activity state', () => {
    it('completed queued torrents should have activityState "done"', async () => {
      config.set('activeSeeds', 1)
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)

      // Mark both as complete (progress=1) and having metadata
      for (const t of [t1, t2]) {
        Object.defineProperty(t, 'progress', { get: () => 1, configurable: true })
        Object.defineProperty(t, 'hasMetadata', { get: () => true, configurable: true })
      }
      recalc()

      // One active (seeding), one queued (done)
      const activeT = [t1, t2].find((t) => t.userState === 'active')!
      const queuedT = [t1, t2].find((t) => t.userState === 'queued')!

      expect(activeT.activityState).toBe('seeding')
      expect(queuedT.activityState).toBe('done')
    })

    it('incomplete queued torrents should still have activityState "queued"', async () => {
      await addTorrent(0)
      await addTorrent(1)
      const t3 = await addTorrent(2)
      recalc()

      expect(t3.userState).toBe('queued')
      expect(t3.activityState).toBe('queued')
    })
  })

  describe('checking queue', () => {
    /**
     * Helper: simulate a torrent that needs data check by calling requestCheck
     * directly. We mock performDataCheck to control when the check "completes".
     *
     * Returns a resolve function that completes the check.
     */
    function simulateCheckRequest(torrent: Torrent): () => void {
      let resolve!: () => void
      const promise = new Promise<void>((r) => {
        resolve = r
      })
      vi.spyOn(torrent, 'performDataCheck').mockReturnValue(promise)

      // Set _isChecking to true (as start() would)
      Object.defineProperty(torrent, '_isChecking', { value: true, writable: true })

      engine.queueManager!.requestCheck(torrent)
      return resolve
    }

    it('should only check one torrent at a time by default', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)

      const resolve1 = simulateCheckRequest(t1)
      simulateCheckRequest(t2)
      simulateCheckRequest(t3)

      // Only t1 should have performDataCheck called (activeChecking=1)
      expect(t1.performDataCheck).toHaveBeenCalledTimes(1)
      expect(t2.performDataCheck).toHaveBeenCalledTimes(0)
      expect(t3.performDataCheck).toHaveBeenCalledTimes(0)

      // Complete t1's check
      resolve1()
      await vi.waitFor(() => {
        expect(t2.performDataCheck).toHaveBeenCalledTimes(1)
      })
    })

    it('should process queued checks in queue position order', async () => {
      const t1 = await addTorrent(0) // position 0
      const t2 = await addTorrent(1) // position 1
      const t3 = await addTorrent(2) // position 2

      // Start t1's check first (it blocks the queue)
      const resolve1 = simulateCheckRequest(t1)

      // While t1 is checking, enqueue t3 and t2 (out of position order)
      const checkOrder: string[] = []
      for (const t of [t3, t2]) {
        vi.spyOn(t, 'performDataCheck').mockImplementation(async () => {
          checkOrder.push(t.name!)
        })
        Object.defineProperty(t, '_isChecking', { value: true, writable: true })
        engine.queueManager!.requestCheck(t)
      }

      // Neither t2 nor t3 should have started (t1 is blocking)
      expect(t2.performDataCheck).toHaveBeenCalledTimes(0)
      expect(t3.performDataCheck).toHaveBeenCalledTimes(0)

      // Complete t1 — queue should process t2 (position 1) before t3 (position 2)
      resolve1()

      await vi.waitFor(() => {
        expect(checkOrder).toEqual(['torrent-1', 'torrent-2'])
      })
    })

    it('should not count checking torrents against download limits', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)
      recalc()

      // t1, t2 active, t3 queued
      expect(t3.userState).toBe('queued')

      // Put t1 in checking queue
      simulateCheckRequest(t1)

      recalc()

      // t1 is checking (skipped in partition), so t2 and t3 fill the 2 download slots
      expect(t2.userState).toBe('active')
      expect(t3.userState).toBe('active')
    })

    it('should start networking after check completes', async () => {
      const t1 = await addTorrent(0)
      recalc()

      const resolve1 = simulateCheckRequest(t1)

      // Complete the check
      resolve1()

      await vi.waitFor(() => {
        // After check, start() should have been called
        // t1.userState should still be active
        expect(t1.userState).toBe('active')
      })
    })

    it('should handle requestCheckImmediate (manual recheck)', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)

      // t1 is already checking
      const resolve1 = simulateCheckRequest(t1)

      // t2 requests immediate check (simulating recheckData)
      let immediateResolved = false
      vi.spyOn(t2, 'performDataCheck').mockResolvedValue()
      Object.defineProperty(t2, '_isChecking', { value: true, writable: true })

      const immediatePromise = engine.queueManager!.requestCheckImmediate(t2)
      immediatePromise.then(() => {
        immediateResolved = true
      })

      // t2 should not have started yet (t1 is checking)
      expect(t2.performDataCheck).toHaveBeenCalledTimes(0)
      expect(immediateResolved).toBe(false)

      // Complete t1
      resolve1()

      await immediatePromise
      expect(immediateResolved).toBe(true)
      expect(t2.performDataCheck).toHaveBeenCalledTimes(1)
    })

    it('should clean up checking state on torrent removal', async () => {
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)

      simulateCheckRequest(t1)
      vi.spyOn(t2, 'performDataCheck').mockResolvedValue()
      Object.defineProperty(t2, '_isChecking', { value: true, writable: true })
      engine.queueManager!.requestCheck(t2)

      // t2 is queued for check
      expect(engine.queueManager!.isCheckingOrQueued(t2)).toBe(true)

      // Remove t2
      await engine.removeTorrent(t2)

      expect(engine.queueManager!.isCheckingOrQueued(t2)).toBe(false)
    })

    it('should respect activeChecking config changes', async () => {
      config.set('activeChecking', 2)

      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)

      simulateCheckRequest(t1)
      simulateCheckRequest(t2)
      simulateCheckRequest(t3)

      // With activeChecking=2, both t1 and t2 should be checking
      expect(t1.performDataCheck).toHaveBeenCalledTimes(1)
      expect(t2.performDataCheck).toHaveBeenCalledTimes(1)
      expect(t3.performDataCheck).toHaveBeenCalledTimes(0)
    })

    it('should not double-enqueue a torrent', async () => {
      const t1 = await addTorrent(0)

      simulateCheckRequest(t1)

      // Try to enqueue again
      engine.queueManager!.requestCheck(t1)

      expect(t1.performDataCheck).toHaveBeenCalledTimes(1)
    })
  })

  describe('seed rotation', () => {
    it('should activate seeds up to the limit', async () => {
      config.set('activeSeeds', 2)
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)
      const t3 = await addTorrent(2)

      Object.defineProperty(t1, 'progress', { get: () => 1, configurable: true })
      Object.defineProperty(t2, 'progress', { get: () => 1, configurable: true })
      Object.defineProperty(t3, 'progress', { get: () => 1, configurable: true })
      recalc()

      const activeCount = [t1, t2, t3].filter((t) => t.userState === 'active').length
      expect(activeCount).toBe(2)
    })

    it('should not rotate a seed within anti-oscillation window', async () => {
      config.set('activeSeeds', 1)
      const t1 = await addTorrent(0)
      const t2 = await addTorrent(1)

      Object.defineProperty(t1, 'progress', { get: () => 1, configurable: true })
      Object.defineProperty(t2, 'progress', { get: () => 1, configurable: true })
      recalc()

      const firstActive = [t1, t2].find((t) => t.userState === 'active')!

      // Immediate recalc should NOT rotate the protected seed
      recalc()
      expect(firstActive.userState).toBe('active')
    })

    it('should rotate seeds after anti-oscillation window expires', async () => {
      vi.useFakeTimers()
      try {
        config.set('activeSeeds', 1)
        const t1 = await addTorrent(0)
        const t2 = await addTorrent(1)

        Object.defineProperty(t1, 'progress', { get: () => 1, configurable: true })
        Object.defineProperty(t2, 'progress', { get: () => 1, configurable: true })
        recalc()

        const firstActive = [t1, t2].find((t) => t.userState === 'active')!
        const firstIdle = [t1, t2].find((t) => t.userState === 'queued')!

        // Advance past the 5-minute anti-oscillation window
        vi.advanceTimersByTime(5 * 60 * 1000 + 1)
        recalc()

        // The previously idle seed should now be active (it has activatedAt=0, lower than the first)
        expect(firstIdle.userState).toBe('active')
        expect(firstActive.userState).toBe('queued')
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
