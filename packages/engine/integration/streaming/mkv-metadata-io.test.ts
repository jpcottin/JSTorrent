/**
 * MKV metadata I/O behavior test.
 *
 * Verifies that mediabunny's MKV init (Input + getPrimaryVideoTrack) only reads
 * header/metadata bytes, not cluster data. And that getKeyPacket(timestamp) for
 * a single seek reads only ~1 cluster rather than the whole file.
 *
 * This informs whether we can use mediabunny for MKV streaming without it
 * eagerly downloading the entire file during initialization.
 *
 * No torrent/seeder needed — uses StreamSource with I/O tracking directly.
 *
 * Prerequisites: run fixtures/generate-fixtures.sh to create test-video-long.mkv
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  ALL_FORMATS,
  EncodedPacketSink,
  Input,
  StreamSource,
  type EncodedPacket,
} from 'mediabunny'

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures')
const MKV_FIXTURE = join(FIXTURES_DIR, 'test-video-long.mkv')

interface ReadRecord {
  start: number
  end: number
}

function createTrackingSource(buffer: Uint8Array) {
  const reads: ReadRecord[] = []

  const source = new StreamSource({
    getSize: () => buffer.byteLength,
    read: (start, end) => {
      reads.push({ start, end })
      return buffer.subarray(start, end)
    },
  })

  return {
    source,
    reads,
    clearReads: () => {
      reads.length = 0
    },
    totalBytesRead: () => reads.reduce((sum, r) => sum + (r.end - r.start), 0),
  }
}

describe('MKV metadata I/O behavior', () => {
  let buffer: Uint8Array
  let fileSize: number

  beforeAll(() => {
    if (!existsSync(MKV_FIXTURE)) {
      const script = join(FIXTURES_DIR, 'generate-fixtures.sh')
      execFileSync('bash', [script], { stdio: 'pipe' })
    }
    buffer = readFileSync(MKV_FIXTURE)
    fileSize = buffer.byteLength
  })

  it('init + getPrimaryVideoTrack reads only metadata, not cluster data', async () => {
    const { source, totalBytesRead } = createTrackingSource(buffer)

    using input = new Input({ formats: ALL_FORMATS, source })
    const videoTrack = await input.getPrimaryVideoTrack()
    expect(videoTrack).not.toBeNull()

    // Init should read EBML header, SeekHead, Tracks, Cues, Info — not clusters.
    // The file is ~2.6MB mostly cluster data; metadata should be a tiny fraction.
    const initBytes = totalBytesRead()
    expect(initBytes).toBeLessThan(fileSize * 0.1)
  })

  it('getKeyPacket(timestamp) for a single seek reads ~1 cluster', async () => {
    const { source, clearReads, totalBytesRead } = createTrackingSource(buffer)

    using input = new Input({ formats: ALL_FORMATS, source })
    const videoTrack = await input.getPrimaryVideoTrack()
    expect(videoTrack).not.toBeNull()
    const sink = new EncodedPacketSink(videoTrack!)

    clearReads()

    // Seek to ~15 seconds (middle of 30s file) — should use cues to jump
    // directly to the right cluster, not scan from the start
    const packet = await sink.getKeyPacket(15)
    expect(packet).not.toBeNull()
    expect(packet!.timestamp).toBeGreaterThanOrEqual(10)
    expect(packet!.timestamp).toBeLessThanOrEqual(16)

    // With 30 clusters in 2.6MB (~87KB each), reading 1-2 clusters should be
    // well under 10% of the file
    const seekBytes = totalBytesRead()
    expect(seekBytes).toBeLessThan(fileSize * 0.15)
  })

  it('metadataOnly keyframe iteration reads the whole file (current behavior)', async () => {
    const { source, clearReads, totalBytesRead } = createTrackingSource(buffer)

    using input = new Input({ formats: ALL_FORMATS, source })
    const videoTrack = await input.getPrimaryVideoTrack()
    expect(videoTrack).not.toBeNull()
    const sink = new EncodedPacketSink(videoTrack!)

    clearReads()

    // Walk all keyframes with metadataOnly — this is the expensive path
    const timestamps: number[] = []
    let packet: EncodedPacket | null = await sink.getKeyPacket(0, {
      metadataOnly: true,
    })
    while (packet) {
      timestamps.push(packet.timestamp)
      const next = await sink.getNextKeyPacket(packet, { metadataOnly: true })
      if (!next || next.sequenceNumber === packet.sequenceNumber) break
      packet = next
    }

    // 30s video with keyframe every 1s — should find ~30 keyframes
    expect(timestamps.length).toBeGreaterThanOrEqual(20)

    // This documents the current behavior: metadataOnly iteration still reads
    // cluster data for MKV. Once mediabunny exposes cues directly (or we add
    // our own cue parser), this test should be updated to assert minimal I/O.
    const iterationBytes = totalBytesRead()
    expect(iterationBytes).toBeGreaterThan(fileSize * 0.5)
  })
})
