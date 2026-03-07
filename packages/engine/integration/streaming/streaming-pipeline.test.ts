/**
 * Phase 1 E2E Integration Test: Video Streaming Pipeline
 *
 * Proves the full pipeline without a browser:
 *   Python seeder → torrent download → TorrentSource → mediabunny → keyframe index + segment packets
 *
 * Prerequisites:
 *   - Python with libtorrent (uv sync in integration/python/)
 *   - test-h264-aac.mp4 fixture in integration/streaming/fixtures/
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ALL_FORMATS,
  EncodedPacketSink,
  Input,
  Source,
  type EncodedPacket,
  type InputVideoTrack,
} from 'mediabunny'

import { BtEngine } from '../../src/core/bt-engine'
import type { Torrent } from '../../src/core/torrent'
import { InMemoryFileSystem, MemorySessionStore } from '../../src/adapters/memory'
import { NodeSocketFactory, NodeHasher } from '../../src/adapters/node'
import { StorageRootManager } from '../../src/storage/storage-root-manager'
import { createTorrentSource } from '../../src/streaming/torrent-source'

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures')
const PYTHON_DIR = join(import.meta.dirname, '..', 'python')
const MP4_FIXTURE = join(FIXTURES_DIR, 'test-h264-aac.mp4')

/**
 * Start the Python seeder for the MP4 fixture file.
 * Uses port 0 (auto-assign) to avoid conflicts.
 * Returns the child process and parsed seeder output.
 */
function startSeeder(): Promise<{ proc: ChildProcess; magnet: string; infoHash: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'uv',
      [
        'run',
        'python',
        '-u', // Unbuffered stdout
        'seed_for_test.py',
        '--file',
        MP4_FIXTURE,
        '--port',
        '0',
        '--host',
        '127.0.0.1',
        '--bind',
        '127.0.0.1',
        '--quiet',
      ],
      {
        cwd: PYTHON_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    let stdout = ''
    let stderr = ''

    proc.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString()

      // Parse machine-readable output once we have MAGNET_LOCALHOST
      const magnetMatch = stdout.match(/^MAGNET_LOCALHOST=(.+)$/m)
      const hashMatch = stdout.match(/^INFOHASH=(.+)$/m)
      if (magnetMatch && hashMatch) {
        resolve({
          proc,
          magnet: magnetMatch[1],
          infoHash: hashMatch[1],
        })
      }
    })

    proc.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to start seeder: ${err.message}`))
    })

    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Seeder exited with code ${code}: ${stderr}`))
      }
    })

    // Timeout if seeder doesn't start
    setTimeout(() => {
      reject(new Error(`Seeder startup timeout. stdout: ${stdout}, stderr: ${stderr}`))
    }, 30000)
  })
}

describe('Streaming Pipeline E2E', () => {
  let seederProc: ChildProcess
  let engine: BtEngine
  let torrent: Torrent
  let magnetLink: string

  beforeAll(async () => {
    // 1. Start the Python seeder
    const seeder = await startSeeder()
    seederProc = seeder.proc
    magnetLink = seeder.magnet

    // 2. Create in-process Node engine with in-memory storage
    const storageRootManager = new StorageRootManager(() => new InMemoryFileSystem())
    storageRootManager.addRoot({ key: 'memory', label: 'Memory', path: '/memory' })
    storageRootManager.setDefaultRoot('memory')

    engine = new BtEngine({
      socketFactory: new NodeSocketFactory(),
      storageRootManager,
      sessionStore: new MemorySessionStore(),
      hasher: new NodeHasher(),
      port: 0, // Auto-assign
    })

    // 3. Add torrent and wait for download to complete
    const { torrent: t } = await engine.addTorrent(magnetLink)
    if (!t) throw new Error('Failed to add torrent')
    torrent = t

    // Wait for complete download (small file — should be fast)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error(
              `Download timeout. Progress: ${torrent.completedPiecesCount}/${torrent.piecesCount}`,
            ),
          ),
        30000,
      )
      torrent.on('complete', () => {
        clearTimeout(timeout)
        resolve()
      })
      // Handle case where torrent is already complete
      if (torrent.isComplete) {
        clearTimeout(timeout)
        resolve()
      }
    })
  }, 45000) // beforeAll timeout

  afterAll(async () => {
    // Kill the seeder
    if (seederProc && !seederProc.killed) {
      seederProc.kill('SIGTERM')
    }
    // Destroy engine
    if (engine) {
      await engine.destroy()
    }
  })

  it('downloads the MP4 fixture completely', () => {
    expect(torrent.isComplete).toBe(true)
    expect(torrent.piecesCount).toBeGreaterThan(0)
    expect(torrent.completedPiecesCount).toBe(torrent.piecesCount)
    expect(torrent.files.length).toBe(1)
    expect(torrent.files[0].length).toBe(readFileSync(MP4_FIXTURE).length)
  })

  it('creates TorrentSource and parses MP4 tracks', async () => {
    // 3. Create TorrentSource backed by the downloaded torrent
    const source = createTorrentSource(Source, torrent, 0)
    expect(source._retrieveSize()).toBe(torrent.files[0].length)

    // 4. Create mediabunny Input and parse container
    const input = new Input({ formats: ALL_FORMATS, source })

    const videoTrack = await input.getPrimaryVideoTrack()
    expect(videoTrack).toBeTruthy()
    expect(videoTrack!.codec).toBe('avc')

    let audioTrack = null
    try {
      audioTrack = await input.getPrimaryAudioTrack()
    } catch {
      // No audio track — fine for test
    }
    expect(audioTrack).toBeTruthy()
    expect(audioTrack!.codec).toBe('aac')

    const duration = Number(await videoTrack!.computeDuration())
    expect(duration).toBeGreaterThan(2)
    expect(duration).toBeLessThan(10)

    input.dispose()
  })

  it('builds keyframe index from TorrentSource', async () => {
    const source = createTorrentSource(Source, torrent, 0)
    const input = new Input({ formats: ALL_FORMATS, source })

    const videoTrack = (await input.getPrimaryVideoTrack())!
    const videoSink = new EncodedPacketSink(videoTrack)
    const duration = Number(await videoTrack.computeDuration())

    // 5. Build keyframe index (MP4: in-memory from moov, zero additional reads)
    const keyframes: { timestamp: number; sequenceNumber: number }[] = []
    let packet = await videoSink.getKeyPacket(0, { metadataOnly: true })

    while (packet) {
      const ts = packet.timestamp
      if (Number.isFinite(ts) && ts >= 0) {
        keyframes.push({ timestamp: ts, sequenceNumber: packet.sequenceNumber })
      }
      const next = await videoSink.getNextKeyPacket(packet, { metadataOnly: true })
      if (!next || next.sequenceNumber === packet.sequenceNumber) break
      packet = next
    }

    // 7. Assert keyframe index
    expect(keyframes.length).toBeGreaterThan(0)
    expect(keyframes[0].timestamp).toBeCloseTo(0, 1)

    input.dispose()
  })

  it('collects segment packets from TorrentSource', async () => {
    const source = createTorrentSource(Source, torrent, 0)
    const input = new Input({ formats: ALL_FORMATS, source })

    const videoTrack = (await input.getPrimaryVideoTrack())!
    const videoSink = new EncodedPacketSink(videoTrack)
    const duration = Number(await videoTrack.computeDuration())

    // 6. Request first segment's packets (first 2 seconds)
    const segmentEnd = Math.min(2, duration)
    const packets: EncodedPacket[] = []
    let pkt = await videoSink.getKeyPacket(0)
    if (!pkt) pkt = await videoSink.getFirstPacket()

    while (pkt) {
      if (pkt.timestamp >= segmentEnd) break
      if (!pkt.isMetadataOnly && pkt.timestamp >= 0) {
        packets.push(pkt)
      }
      const next = await videoSink.getNextPacket(pkt)
      if (!next || next.sequenceNumber === pkt.sequenceNumber) break
      pkt = next
    }

    // 7. Assert segment packets
    expect(packets.length).toBeGreaterThan(0)
    for (const p of packets) {
      expect(p.data.byteLength).toBeGreaterThan(0)
    }

    input.dispose()
  })
})
