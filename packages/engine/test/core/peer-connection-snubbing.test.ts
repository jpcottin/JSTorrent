import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PeerConnection } from '../../src/core/peer-connection'
import { ILoggingEngine } from '../../src/logging/logger'
import { ITcpSocket } from '../../src/interfaces/socket'

describe('PeerConnection Snubbing & RTT', () => {
  let peer: PeerConnection
  let mockSocket: ITcpSocket
  let mockEngine: ILoggingEngine

  beforeEach(() => {
    mockSocket = {
      onData: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
      connect: vi.fn(),
    } as unknown as ITcpSocket

    mockEngine = {
      log: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      autoDrainBuffers: true,
    } as unknown as ILoggingEngine

    peer = new PeerConnection(mockEngine, mockSocket)
    vi.useFakeTimers()
  })

  describe('RTT tracking', () => {
    it('should return 60s timeout with no RTT samples', () => {
      expect(peer.requestTimeout()).toBe(60_000)
    })

    it('should return 60s timeout with only 1 RTT sample', () => {
      peer.recordRttSample(100)
      expect(peer.requestTimeout()).toBe(60_000)
    })

    it('should compute adaptive timeout from RTT samples', () => {
      // Add several consistent 100ms RTT samples
      for (let i = 0; i < 10; i++) {
        peer.recordRttSample(100)
      }
      const timeout = peer.requestTimeout()
      // With consistent 100ms RTT, deviation should be small
      // timeout = mean + 4*deviation, minimum 2000ms
      expect(timeout).toBeGreaterThanOrEqual(2_000)
      expect(timeout).toBeLessThan(60_000)
    })

    it('should clamp timeout to minimum 2s', () => {
      // Very fast RTT (LAN)
      for (let i = 0; i < 20; i++) {
        peer.recordRttSample(5)
      }
      expect(peer.requestTimeout()).toBe(2_000)
    })

    it('should clamp timeout to maximum 60s', () => {
      // Very high RTT with high variance
      for (let i = 0; i < 20; i++) {
        peer.recordRttSample(i * 5000)
      }
      expect(peer.requestTimeout()).toBeLessThanOrEqual(60_000)
    })

    it('should not record negative or zero RTT samples', () => {
      peer.recordRttSample(0)
      peer.recordRttSample(-100)
      expect(peer.requestTimeout()).toBe(60_000) // Still no valid samples
    })
  })

  describe('snubbing', () => {
    it('should not be snubbed initially', () => {
      expect(peer.snubbed).toBe(false)
    })

    it('should cap pipeline to 1 when snubbed', () => {
      peer.pipelineDepth = 200
      peer.snub()
      expect(peer.snubbed).toBe(true)
      expect(peer.pipelineDepth).toBe(1)
    })

    it('should not double-snub', () => {
      peer.snub()
      peer.pipelineDepth = 5 // manually change
      peer.snub() // should be no-op
      expect(peer.pipelineDepth).toBe(5) // unchanged
    })

    it('should recover from snub when block received', () => {
      peer.snub()
      expect(peer.snubbed).toBe(true)
      expect(peer.pipelineDepth).toBe(1)

      peer.recordBlockReceived()
      expect(peer.snubbed).toBe(false)
      // Should recover to MIN_PIPELINE_DEPTH (2) and re-enter slow-start
      expect(peer.pipelineDepth).toBe(2)
      expect(peer.inSlowStart).toBe(true)
    })

    it('should reset rate counters on snub recovery', () => {
      peer.snub()
      // Advance time to ensure clean rate tracking after recovery
      vi.advanceTimersByTime(2000)
      peer.recordBlockReceived()

      // Pipeline should start at MIN (2) in slow-start and ramp up from there
      expect(peer.pipelineDepth).toBe(2)
      expect(peer.inSlowStart).toBe(true)
    })
  })

  describe('slow-start queue sizing', () => {
    it('should start in slow-start mode', () => {
      expect(peer.inSlowStart).toBe(true)
      expect(peer.pipelineDepth).toBe(2) // MIN_PIPELINE_DEPTH
    })

    it('should increase pipeline by 1 per block in slow-start', () => {
      vi.setSystemTime(1000)
      expect(peer.pipelineDepth).toBe(2)

      peer.recordBlockReceived()
      expect(peer.pipelineDepth).toBe(3)

      peer.recordBlockReceived()
      expect(peer.pipelineDepth).toBe(4)

      peer.recordBlockReceived()
      expect(peer.pipelineDepth).toBe(5)

      expect(peer.inSlowStart).toBe(true)
    })

    it('should exit slow-start when rate plateaus', () => {
      vi.setSystemTime(0)

      // First second: 10 blocks → 10 * 16384 = 163840 bytes/sec
      for (let i = 0; i < 10; i++) {
        peer.recordBlockReceived()
      }
      vi.advanceTimersByTime(1000)
      // Trigger rate check — sets _lastSlowStartRate, doesn't exit yet
      peer.recordBlockReceived()
      expect(peer.inSlowStart).toBe(true)

      // Second second: same 10 blocks → same rate → delta < 5KB/s → exit
      for (let i = 0; i < 9; i++) {
        peer.recordBlockReceived()
      }
      vi.advanceTimersByTime(1000)
      peer.recordBlockReceived()
      expect(peer.inSlowStart).toBe(false)
    })

    it('should stay in slow-start when rate is still increasing', () => {
      vi.setSystemTime(0)

      // First second: 5 blocks
      for (let i = 0; i < 5; i++) {
        peer.recordBlockReceived()
      }
      vi.advanceTimersByTime(1000)
      peer.recordBlockReceived() // triggers rate check + 1 block for next interval
      expect(peer.inSlowStart).toBe(true)

      // Second second: 20 blocks (much higher rate, increase > 5KB/s)
      for (let i = 0; i < 19; i++) {
        peer.recordBlockReceived()
      }
      vi.advanceTimersByTime(1000)
      peer.recordBlockReceived()
      expect(peer.inSlowStart).toBe(true) // rate increased significantly
    })

    it('should size pipeline to queueTime * rate / blockSize in normal mode', () => {
      vi.setSystemTime(0)

      // Exit slow-start first by triggering plateau
      // First second: establish rate
      for (let i = 0; i < 10; i++) {
        peer.recordBlockReceived()
      }
      vi.advanceTimersByTime(1000)
      peer.recordBlockReceived()

      // Second second: same rate → plateau → exit slow-start
      for (let i = 0; i < 9; i++) {
        peer.recordBlockReceived()
      }
      vi.advanceTimersByTime(1000)
      peer.recordBlockReceived()
      expect(peer.inSlowStart).toBe(false)

      // Now in normal mode. Third second: 100 blocks/sec
      for (let i = 0; i < 100; i++) {
        peer.recordBlockReceived()
      }
      vi.advanceTimersByTime(1000)
      peer.recordBlockReceived() // triggers normal mode rate check

      // Expected: ceil(3 * 101 * 16384 / 1000 / 16384) ≈ ceil(3 * 101) = 303
      // (101 blocks in ~1000ms: blockCount=101 after the trigger block)
      // Actually: bytesPerSec = 101 * 16384 * 1000 / 1000 = 101 * 16384
      // targetDepth = ceil(3 * 101 * 16384 / 16384) = ceil(303) = 303
      expect(peer.pipelineDepth).toBe(303)
    })

    it('should clamp normal mode pipeline to MIN', () => {
      vi.setSystemTime(0)

      // Force out of slow-start
      peer['_slowStart'] = false

      // Very slow: 1 block in 1 second
      peer.recordBlockReceived()
      vi.advanceTimersByTime(1000)
      peer.recordBlockReceived()

      // targetDepth = ceil(3 * 2 * 16384 / 1000 / 16384) — wait let me recalc
      // blockCount=2, elapsed=1000: bytesPerSec = 2 * 16384 * 1000 / 1000 = 32768
      // targetDepth = ceil(3 * 32768 / 16384) = ceil(6) = 6
      // That's above MIN (2), so pipeline = 6
      // To hit MIN, we need 0 blocks in the interval
      // Let's test with zero blocks by just advancing time
      vi.advanceTimersByTime(1000)
      // No recordBlockReceived calls, so blockCount stays at 0 from last reset
      // Need to trigger the check - but it only runs inside recordBlockReceived
      // So in practice, normal mode pipeline only updates when blocks arrive.
      // With 1 block after a long gap:
      vi.advanceTimersByTime(5000)
      peer.recordBlockReceived()
      // blockCount=1, elapsed=6000: bytesPerSec = 1 * 16384 * 1000 / 6000 = 2730
      // targetDepth = ceil(3 * 2730 / 16384) = ceil(0.5) = 1 → clamped to MIN=2
      expect(peer.pipelineDepth).toBe(2)
    })

    it('should clamp normal mode pipeline to MAX', () => {
      vi.setSystemTime(0)
      peer['_slowStart'] = false

      // Very fast: 1000 blocks in 1 second
      for (let i = 0; i < 1000; i++) {
        peer.recordBlockReceived()
      }
      vi.advanceTimersByTime(1000)
      peer.recordBlockReceived()

      // targetDepth = ceil(3 * 1001) = 3003 → clamped to MAX=500
      expect(peer.pipelineDepth).toBe(500)
    })

    it('snub → 1 → unsnub → slow-start cycle', () => {
      vi.setSystemTime(0)

      // Ramp up pipeline in slow-start
      for (let i = 0; i < 20; i++) {
        peer.recordBlockReceived()
      }
      expect(peer.pipelineDepth).toBe(22) // 2 + 20
      expect(peer.inSlowStart).toBe(true)

      // Snub: pipeline=1, exits slow-start
      peer.snub()
      expect(peer.pipelineDepth).toBe(1)
      expect(peer.snubbed).toBe(true)
      expect(peer.inSlowStart).toBe(false)

      // Unsnub via block: re-enters slow-start at MIN_PIPELINE_DEPTH
      vi.advanceTimersByTime(2000)
      peer.recordBlockReceived()
      expect(peer.snubbed).toBe(false)
      expect(peer.inSlowStart).toBe(true)
      expect(peer.pipelineDepth).toBe(2)

      // Should ramp up again from slow-start
      peer.recordBlockReceived()
      expect(peer.pipelineDepth).toBe(3)
    })

    it('should exit slow-start when snubbed directly', () => {
      expect(peer.inSlowStart).toBe(true)
      peer.snub()
      expect(peer.inSlowStart).toBe(false)
    })

    it('reduceDepth halves pipeline and clamps to MIN', () => {
      peer.pipelineDepth = 100
      peer.reduceDepth()
      expect(peer.pipelineDepth).toBe(50)

      peer.pipelineDepth = 3
      peer.reduceDepth()
      expect(peer.pipelineDepth).toBe(2) // MIN_PIPELINE_DEPTH
    })
  })

  describe('lastReceiveTime', () => {
    it('should be 0 initially', () => {
      expect(peer.lastReceiveTime).toBe(0)
    })

    it('should be set when first request is sent', () => {
      vi.setSystemTime(1000)
      peer.sendRequest(0, 0, 16384)
      expect(peer.lastReceiveTime).toBe(1000)
    })

    it('should update when block is received', () => {
      vi.setSystemTime(1000)
      peer.sendRequest(0, 0, 16384)
      expect(peer.lastReceiveTime).toBe(1000)

      vi.setSystemTime(1500)
      peer.recordBlockReceived()
      expect(peer.lastReceiveTime).toBe(1500)
    })
  })
})
