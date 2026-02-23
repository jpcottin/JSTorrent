import { vi } from 'vitest'

type MessageListener = (msg: unknown) => void
type DisconnectListener = () => void

export interface MockNativePort {
  name: string
  postMessage: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  onMessage: {
    addListener: ReturnType<typeof vi.fn>
    removeListener: ReturnType<typeof vi.fn>
    listeners: MessageListener[]
  }
  onDisconnect: {
    addListener: ReturnType<typeof vi.fn>
    removeListener: ReturnType<typeof vi.fn>
    listeners: DisconnectListener[]
  }
  emitMessage: (msg: unknown) => void
  emitDisconnect: () => void
}

export function createMockNativePort(name = 'com.jstorrent.native'): MockNativePort {
  const messageListeners: MessageListener[] = []
  const disconnectListeners: DisconnectListener[] = []
  let disconnected = false

  const emitMessage = (msg: unknown) => {
    for (const listener of [...messageListeners]) {
      listener(msg)
    }
  }

  const emitDisconnect = () => {
    if (disconnected) return
    disconnected = true
    for (const listener of [...disconnectListeners]) {
      listener()
    }
  }

  return {
    name,
    postMessage: vi.fn(),
    disconnect: vi.fn(() => {
      emitDisconnect()
    }),
    onMessage: {
      addListener: vi.fn((listener: MessageListener) => {
        messageListeners.push(listener)
      }),
      removeListener: vi.fn((listener: MessageListener) => {
        const idx = messageListeners.indexOf(listener)
        if (idx >= 0) messageListeners.splice(idx, 1)
      }),
      listeners: messageListeners,
    },
    onDisconnect: {
      addListener: vi.fn((listener: DisconnectListener) => {
        disconnectListeners.push(listener)
      }),
      removeListener: vi.fn((listener: DisconnectListener) => {
        const idx = disconnectListeners.indexOf(listener)
        if (idx >= 0) disconnectListeners.splice(idx, 1)
      }),
      listeners: disconnectListeners,
    },
    emitMessage,
    emitDisconnect,
  }
}
