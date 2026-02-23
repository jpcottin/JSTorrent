import { describe, expect, it, vi } from 'vitest'
import { buildControlFrame } from '../../../src/lib/daemon-bridge/protocol/control-frame'
import {
  parseControlEventFrame,
  parseRootsChangedFrame,
} from '../../../src/lib/daemon-bridge/chromeos/ws-events'

function buildJsonFrame(opcode: number, requestId: number, value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value))
  return new Uint8Array(buildControlFrame(opcode, requestId, payload))
}

describe('chromeos ws-events', () => {
  it('parses ROOTS_CHANGED frame and maps root aliases', () => {
    vi.spyOn(Date, 'now').mockReturnValue(444)

    const frame = buildJsonFrame(0xe0, 7, [
      {
        key: 'downloads',
        uri: 'content://downloads',
        displayName: 'Downloads',
        removable: true,
        lastStatOk: false,
        diskId: 'disk-1',
      },
      {
        key: 'media',
        path: '/media',
        display_name: 'Media',
        removable: false,
      },
    ])

    expect(parseRootsChangedFrame(frame)).toEqual([
      {
        key: 'downloads',
        path: 'content://downloads',
        display_name: 'Downloads',
        removable: true,
        last_stat_ok: false,
        last_checked: 444,
        disk_id: 'disk-1',
      },
      {
        key: 'media',
        path: '/media',
        display_name: 'Media',
        removable: false,
        last_stat_ok: true,
        last_checked: 444,
        disk_id: '',
      },
    ])
  })

  it('parses EVENT frame payload as native event', () => {
    const frame = buildJsonFrame(0xe1, 2, {
      event: 'TorrentAdded',
      payload: { infoHash: 'abc' },
    })

    expect(parseControlEventFrame(frame)).toEqual({
      event: 'TorrentAdded',
      payload: { infoHash: 'abc' },
    })
  })

  it('throws on invalid JSON payload', () => {
    const invalidPayload = new TextEncoder().encode('{invalid')
    const frame = new Uint8Array(buildControlFrame(0xe1, 1, invalidPayload))

    expect(() => parseControlEventFrame(frame)).toThrow()
    expect(() => parseRootsChangedFrame(frame)).toThrow()
  })
})
