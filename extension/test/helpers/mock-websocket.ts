import { vi } from 'vitest'

export class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  static instances: MockWebSocket[] = []

  binaryType: BinaryType = 'blob'
  readyState = MockWebSocket.CONNECTING

  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  readonly sent: unknown[] = []

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this)
  }

  send = vi.fn((data: unknown) => {
    this.sent.push(data)
  })

  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({} as CloseEvent)
  })

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.({} as Event)
  }

  emitMessage(data: ArrayBuffer): void {
    this.onmessage?.({ data } as MessageEvent)
  }

  emitError(): void {
    this.onerror?.({} as Event)
  }

  emitClose(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({} as CloseEvent)
  }

  static install(): void {
    Object.defineProperty(globalThis, 'WebSocket', {
      value: MockWebSocket,
      configurable: true,
      writable: true,
    })
  }

  static reset(): void {
    MockWebSocket.instances = []
  }
}
