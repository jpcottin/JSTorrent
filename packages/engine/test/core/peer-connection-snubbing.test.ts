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
      // Should recover to MIN_PIPELINE_DEPTH (5)
      expect(peer.pipelineDepth).toBe(5)
    })

    it('should reset rate counters on snub recovery', () => {
      peer.snub()
      // Advance time to ensure clean rate tracking after recovery
      vi.advanceTimersByTime(2000)
      peer.recordBlockReceived()

      // Pipeline should start at MIN (5) and ramp up normally from there
      expect(peer.pipelineDepth).toBe(5)
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
