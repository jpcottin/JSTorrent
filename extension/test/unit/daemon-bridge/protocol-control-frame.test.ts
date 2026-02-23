import { describe, expect, it } from 'vitest'
import {
  buildControlFrame,
  decodeControlFrameJsonPayload,
  readControlFrameHeader,
  readControlFramePayload,
  readControlFrameRequestId,
} from '../../../src/lib/daemon-bridge/protocol/control-frame'

describe('control-frame', () => {
  it('builds frame header with little-endian requestId and payload', () => {
    const payload = new Uint8Array([10, 20, 30])
    const frame = new Uint8Array(buildControlFrame(0xe9, 0x01020304, payload))

    expect(frame[0]).toBe(1)
    expect(frame[1]).toBe(0xe9)
    expect(frame[2]).toBe(0)
    expect(frame[3]).toBe(0)
    expect(frame[4]).toBe(0x04)
    expect(frame[5]).toBe(0x03)
    expect(frame[6]).toBe(0x02)
    expect(frame[7]).toBe(0x01)
    expect(Array.from(frame.slice(8))).toEqual([10, 20, 30])
  })

  it('reads header/requestId/payload from frame', () => {
    const payload = new TextEncoder().encode('{"ok":true}')
    const frame = new Uint8Array(buildControlFrame(0xea, 42, payload))

    expect(readControlFrameHeader(frame)).toEqual({
      version: 1,
      opcode: 0xea,
      requestId: 42,
    })
    expect(readControlFrameRequestId(frame)).toBe(42)
    expect(Array.from(readControlFramePayload(frame))).toEqual(Array.from(payload))
    expect(decodeControlFrameJsonPayload<{ ok: boolean }>(frame)).toEqual({ ok: true })
  })

  it('throws on short frames', () => {
    const short = new Uint8Array([1, 2, 3])

    expect(() => readControlFrameHeader(short)).toThrow('Control frame too short')
    expect(() => readControlFrameRequestId(short)).toThrow('Control frame too short')
    expect(() => readControlFramePayload(short)).toThrow('Control frame too short')
    expect(() => decodeControlFrameJsonPayload(short)).toThrow('Control frame too short')
  })
})
