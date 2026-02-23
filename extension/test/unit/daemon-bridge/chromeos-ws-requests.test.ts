import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildControlFrame } from '../../../src/lib/daemon-bridge/protocol/control-frame'
import {
  handleControlResponseFrame,
  handleKvResponseFrame,
  sendControlRequestOverWebSocket,
  sendKvRequestOverWebSocket,
} from '../../../src/lib/daemon-bridge/chromeos/ws-requests'

describe('chromeos ws-requests', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('sendKvRequestOverWebSocket throws when websocket is not connected', async () => {
    await expect(
      sendKvRequestOverWebSocket({
        ws: null,
        pendingKvRequests: new Map(),
        opcode: 0xe3,
        payload: { key: 'a' },
      }),
    ).rejects.toThrow('WebSocket not connected')
  })

  it('sendControlRequestOverWebSocket returns error when websocket is not connected', async () => {
    await expect(
      sendControlRequestOverWebSocket({
        ws: null,
        pendingControlRequests: new Map(),
        opcode: 0xe9,
        payload: { rootKey: 'r', path: 'p' },
      }),
    ).resolves.toEqual({ ok: false, error: 'WebSocket not connected' })
  })

  it('correlates KV request/response by requestId', async () => {
    const ws = {
      readyState: 1,
      send: vi.fn(),
    } as unknown as WebSocket

    const pendingKvRequests = new Map()

    const promise = sendKvRequestOverWebSocket({
      ws,
      pendingKvRequests,
      opcode: 0xe3,
      payload: { key: 'abc' },
      requestIdFactory: () => 99,
      timeoutMs: 100,
    })

    const payload = new TextEncoder().encode(JSON.stringify({ ok: true, value: 'v1' }))
    const frame = new Uint8Array(buildControlFrame(0xe3, 99, payload))
    const result = handleKvResponseFrame(frame, pendingKvRequests)

    expect(result).toEqual({ kind: 'resolved', requestId: 99 })
    await expect(promise).resolves.toEqual({ ok: true, value: 'v1' })
  })

  it('correlates control request/response and handles parse errors', async () => {
    const ws = {
      readyState: 1,
      send: vi.fn(),
    } as unknown as WebSocket

    const pendingControlRequests = new Map()

    const promise = sendControlRequestOverWebSocket({
      ws,
      pendingControlRequests,
      opcode: 0xe9,
      payload: { rootKey: 'r', path: 'f' },
      requestIdFactory: () => 42,
      timeoutMs: 100,
    })

    const invalid = new TextEncoder().encode('{invalid')
    const frame = new Uint8Array(buildControlFrame(0xe9, 42, invalid))
    const result = handleControlResponseFrame(frame, pendingControlRequests)

    expect(result).toEqual({ kind: 'resolved', requestId: 42 })
    await expect(promise).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('Failed to parse response:'),
    })
  })

  it('returns missing for unknown request ids', () => {
    const pendingControlRequests = new Map()
    const pendingKvRequests = new Map()

    const payload = new TextEncoder().encode(JSON.stringify({ ok: true }))
    const controlFrame = new Uint8Array(buildControlFrame(0xe9, 1001, payload))
    const kvFrame = new Uint8Array(buildControlFrame(0xe3, 1002, payload))

    expect(handleControlResponseFrame(controlFrame, pendingControlRequests)).toEqual({
      kind: 'missing',
      requestId: 1001,
    })
    expect(handleKvResponseFrame(kvFrame, pendingKvRequests)).toEqual({
      kind: 'missing',
      requestId: 1002,
    })
  })

  it('times out requests and returns invalid for short frames', async () => {
    vi.useFakeTimers()

    const ws = {
      readyState: 1,
      send: vi.fn(),
    } as unknown as WebSocket

    const pendingKvRequests = new Map()
    const kvPromise = sendKvRequestOverWebSocket({
      ws,
      pendingKvRequests,
      opcode: 0xe3,
      payload: { key: 'timeout' },
      requestIdFactory: () => 7,
      timeoutMs: 25,
    })

    const pendingControlRequests = new Map()
    const controlPromise = sendControlRequestOverWebSocket({
      ws,
      pendingControlRequests,
      opcode: 0xe9,
      payload: { rootKey: 'r', path: 'x' },
      requestIdFactory: () => 8,
      timeoutMs: 25,
    })

    const kvRejected = expect(kvPromise).rejects.toThrow('KV request timeout')
    const controlResolved = expect(controlPromise).resolves.toEqual({
      ok: false,
      error: 'Request timed out',
    })

    await vi.advanceTimersByTimeAsync(25)

    await kvRejected
    await controlResolved

    const shortFrame = new Uint8Array([1, 2, 3])
    expect(handleControlResponseFrame(shortFrame, pendingControlRequests)).toEqual({ kind: 'invalid' })
    expect(handleKvResponseFrame(shortFrame, pendingKvRequests)).toEqual({ kind: 'invalid' })
  })
})
