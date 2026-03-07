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
import { ALL_FORMATS, EncodedPacketSink, Input, StreamSource, type EncodedPacket } from 'mediabunny'
import { parseMkvCues } from '../../src/streaming/mkv-cue-parser'

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

  it('parseMkvCues reads <5% of file and matches mediabunny keyframes', async () => {
    // Track reads for the cue parser
    const cueReads: ReadRecord[] = []
    const trackingRead = (start: number, end: number) => {
      cueReads.push({ start, end })
      return buffer.subarray(start, end)
    }

    const cuePoints = await parseMkvCues(trackingRead, fileSize)

    // Should find cue points (1 per cluster, ~30 clusters in 30s video)
    expect(cuePoints.length).toBeGreaterThanOrEqual(20)

    // Timestamps should span ~0 to ~29 seconds
    expect(cuePoints[0].timestampMs).toBeLessThanOrEqual(1000)
    expect(cuePoints[cuePoints.length - 1].timestampMs).toBeGreaterThanOrEqual(25000)

    // All timestamps should be monotonically increasing
    for (let i = 1; i < cuePoints.length; i++) {
      expect(cuePoints[i].timestampMs).toBeGreaterThan(cuePoints[i - 1].timestampMs)
    }

    // Verify all clusterByteOffset values point to valid Cluster elements
    // (Cluster element ID = 0x1F43B675, big-endian 4 bytes)
    for (const cue of cuePoints) {
      expect(cue.clusterByteOffset).toBeGreaterThan(0)
      expect(cue.clusterByteOffset).toBeLessThan(fileSize)
      const clusterHeader = buffer.subarray(cue.clusterByteOffset, cue.clusterByteOffset + 4)
      const clusterId =
        (clusterHeader[0] << 24) |
        (clusterHeader[1] << 16) |
        (clusterHeader[2] << 8) |
        clusterHeader[3]
      expect(clusterId).toBe(0x1f43b675)
    }

    // Total bytes read by cue parser should be <5% of file size
    const cueBytesRead = cueReads.reduce((sum, r) => sum + (r.end - r.start), 0)
    expect(cueBytesRead).toBeLessThan(fileSize * 0.05)

    // Compare against mediabunny's keyframe iteration
    const { source } = createTrackingSource(buffer)
    using input = new Input({ formats: ALL_FORMATS, source })
    const videoTrack = await input.getPrimaryVideoTrack()
    expect(videoTrack).not.toBeNull()
    const sink = new EncodedPacketSink(videoTrack!)

    const mbTimestamps: number[] = []
    let packet: EncodedPacket | null = await sink.getKeyPacket(0, {
      metadataOnly: true,
    })
    while (packet) {
      mbTimestamps.push(packet.timestamp)
      const next = await sink.getNextKeyPacket(packet, { metadataOnly: true })
      if (!next || next.sequenceNumber === packet.sequenceNumber) break
      packet = next
    }

    // Cue points are per-cluster, mediabunny keyframes are per-frame.
    // Each cue timestamp should be close to at least one mediabunny timestamp.
    for (const cue of cuePoints) {
      const cueTimeSec = cue.timestampMs / 1000
      const closest = mbTimestamps.reduce((best, t) =>
        Math.abs(t - cueTimeSec) < Math.abs(best - cueTimeSec) ? t : best,
      )
      // Should be within 2 seconds (cues point to cluster starts)
      expect(Math.abs(closest - cueTimeSec)).toBeLessThan(2)
    }
  })

  it('parseMkvCues timestamps and offsets match ffprobe keyframes', async () => {
    // Cross-validate against ffprobe as ground truth.
    // ffprobe reports packet positions (data inside cluster), our parser reports
    // cluster element starts — so byte offsets differ by cluster header overhead,
    // but timestamps must match exactly.
    const ffprobeOutput = execFileSync(
      'ffprobe',
      [
        '-v',
        'quiet',
        '-select_streams',
        'v:0',
        '-show_entries',
        'packet=pts_time,pos,flags',
        '-of',
        'csv=p=0',
        MKV_FIXTURE,
      ],
      { encoding: 'utf-8' },
    )

    const ffprobeKeyframes = ffprobeOutput
      .trim()
      .split('\n')
      .filter((line) => line.endsWith(',K__'))
      .map((line) => {
        const [pts, pos] = line.split(',')
        return { timestampSec: parseFloat(pts), bytePos: parseInt(pos, 10) }
      })

    const cuePoints = await parseMkvCues((s, e) => buffer.subarray(s, e), fileSize)

    // Same number of entries (1 keyframe per cluster, 1 cue per cluster)
    expect(cuePoints).toHaveLength(ffprobeKeyframes.length)

    for (let i = 0; i < cuePoints.length; i++) {
      const cue = cuePoints[i]
      const ff = ffprobeKeyframes[i]

      // Timestamps must match exactly (both derived from MKV Cues)
      expect(cue.timestampMs / 1000).toBeCloseTo(ff.timestampSec, 3)

      // Our cluster offset must be before ffprobe's packet position
      // (cluster header + timestamp + possible audio packets precede video data)
      expect(cue.clusterByteOffset).toBeLessThan(ff.bytePos)

      // Gap should be small — cluster overhead is typically <500 bytes
      const gap = ff.bytePos - cue.clusterByteOffset
      expect(gap).toBeGreaterThan(0)
      expect(gap).toBeLessThan(500)
    }
  })
})
