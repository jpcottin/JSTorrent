import { describe, expect, it, vi } from 'vitest'
import { buildControlFrame } from '../../../src/lib/daemon-bridge/protocol/control-frame'
import { connectChromeosControlWebSocket } from '../../../src/lib/daemon-bridge/chromeos/ws-connect'

class StubWebSocket {
  binaryType: BinaryType = 'blob'
  readyState = 0
  onopen: ((ev: Event) => unknown) | null = null
  onmessage: ((ev: MessageEvent) => unknown) | null = null
  onerror: ((ev: Event) => unknown) | null = null
  onclose: ((ev: CloseEvent) => unknown) | null = null

  sent: ArrayBuffer[] = []
  close = vi.fn(() => {
    this.readyState = 3
    this.onclose?.({} as CloseEvent)
  })

  send = vi.fn((data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
    if (typeof data === 'string') {
      this.sent.push(new TextEncoder().encode(data).buffer)
    } else if (data instanceof ArrayBuffer) {
      this.sent.push(data)
    } else if (ArrayBuffer.isView(data)) {
      this.sent.push(
        (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength),
      )
    } else {
      this.sent.push(new Uint8Array(0).buffer)
    }
  })

  emitOpen(): void {
    this.readyState = 1
    this.onopen?.({} as Event)
  }

  emitMessage(frame: Uint8Array): void {
    const payload = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength)
    this.onmessage?.({ data: payload } as MessageEvent)
  }

  emitError(): void {
    this.onerror?.({} as Event)
  }

  emitClose(): void {
    this.readyState = 3
    this.onclose?.({} as CloseEvent)
  }
}

function decodeAuthPayload(frame: ArrayBuffer): string[] {
  const bytes = new Uint8Array(frame)
  const payload = bytes.slice(8)
  const pieces: string[] = []
  let current: number[] = []

  for (let i = 1; i < payload.length; i++) {
    if (payload[i] === 0) {
      pieces.push(new TextDecoder().decode(new Uint8Array(current)))
      current = []
    } else {
      current.push(payload[i])
    }
  }
  if (current.length > 0) {
    pieces.push(new TextDecoder().decode(new Uint8Array(current)))
  }

  return pieces
}

describe('chromeos ws-connect', () => {
  it('performs hello/auth handshake and resolves on successful auth', async () => {
    const ws = new StubWebSocket()

    const promise = connectChromeosControlWebSocket({
      host: 'h',
      port: 12,
      token: 'tok-1',
      extensionId: 'ext-1',
      telemetryId: 'tel-1',
      onRootsChanged: vi.fn(),
      onControlEvent: vi.fn(),
      onKvResponse: vi.fn(),
      onControlResponse: vi.fn(),
      onDisconnected: vi.fn(),
      createWebSocket: () => ws,
      timeoutMs: 100,
    })

    ws.emitOpen()
    expect(new Uint8Array(ws.sent[0])[1]).toBe(0x01)

    ws.emitMessage(new Uint8Array(buildControlFrame(0x02, 0, new Uint8Array(0))))
    expect(new Uint8Array(ws.sent[1])[1]).toBe(0x03)
    expect(decodeAuthPayload(ws.sent[1])).toEqual(['tok-1', 'ext-1', 'tel-1'])

    ws.emitMessage(new Uint8Array(buildControlFrame(0x04, 0, new Uint8Array([0]))))
    await expect(promise).resolves.toBe(ws)
  })

  it('rejects on auth failure', async () => {
    const ws = new StubWebSocket()

    const promise = connectChromeosControlWebSocket({
      host: 'h',
      port: 12,
      token: 'tok',
      extensionId: 'ext',
      telemetryId: 'tel',
      onRootsChanged: vi.fn(),
      onControlEvent: vi.fn(),
      onKvResponse: vi.fn(),
      onControlResponse: vi.fn(),
      onDisconnected: vi.fn(),
      createWebSocket: () => ws,
      timeoutMs: 100,
    })

    ws.emitOpen()
    ws.emitMessage(new Uint8Array(buildControlFrame(0x04, 0, new Uint8Array([1]))))

    await expect(promise).rejects.toThrow('Auth failed')
    expect(ws.close).toHaveBeenCalledTimes(1)
  })

  it('dispatches opcodes and triggers disconnect callback only after auth', async () => {
    const ws = new StubWebSocket()
    const onRootsChanged = vi.fn()
    const onControlEvent = vi.fn()
    const onKvResponse = vi.fn()
    const onControlResponse = vi.fn()
    const onDisconnected = vi.fn()

    const promise = connectChromeosControlWebSocket({
      host: 'h',
      port: 12,
      token: 'tok',
      extensionId: 'ext',
      telemetryId: 'tel',
      onRootsChanged,
      onControlEvent,
      onKvResponse,
      onControlResponse,
      onDisconnected,
      createWebSocket: () => ws,
      timeoutMs: 100,
    })

    ws.emitOpen()
    ws.emitMessage(new Uint8Array(buildControlFrame(0x02, 0, new Uint8Array(0))))
    ws.emitClose()
    expect(onDisconnected).not.toHaveBeenCalled()

    ws.emitMessage(new Uint8Array(buildControlFrame(0x04, 0, new Uint8Array([0]))))
    await promise

    const roots = new Uint8Array(buildControlFrame(0xe0, 1, new TextEncoder().encode('[]')))
    const event = new Uint8Array(buildControlFrame(0xe1, 2, new TextEncoder().encode('{}')))
    const kv = new Uint8Array(buildControlFrame(0xe3, 3, new TextEncoder().encode('{}')))
    const control = new Uint8Array(buildControlFrame(0xe9, 4, new TextEncoder().encode('{}')))
    const capabilities = new Uint8Array(
      buildControlFrame(0xed, 5, new TextEncoder().encode('{}')),
    )
    const error = new Uint8Array(
      buildControlFrame(0x7f, 6, new TextEncoder().encode('Unknown opcode')),
    )

    ws.emitMessage(roots)
    ws.emitMessage(event)
    ws.emitMessage(kv)
    ws.emitMessage(control)
    ws.emitMessage(capabilities)
    ws.emitMessage(error)

    expect(onRootsChanged).toHaveBeenCalledWith(roots)
    expect(onControlEvent).toHaveBeenCalledWith(event)
    expect(onKvResponse).toHaveBeenCalledWith(kv)
    expect(onControlResponse).toHaveBeenCalledWith(control)
    expect(onControlResponse).toHaveBeenCalledWith(capabilities)
    expect(onControlResponse).toHaveBeenCalledWith(error)

    ws.emitClose()
    expect(onDisconnected).toHaveBeenCalledTimes(1)
  })
})
