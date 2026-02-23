import { vi, type Mock } from 'vitest'

type MessageListener = (msg: unknown) => void
type DisconnectListener = () => void

export interface MockNativePort {
  name: string
  postMessage: Mock<(msg: unknown) => void>
  disconnect: Mock<() => void>
  onMessage: {
    addListener: Mock<(listener: MessageListener) => void>
    removeListener: Mock<(listener: MessageListener) => void>
    listeners: MessageListener[]
  }
  onDisconnect: {
    addListener: Mock<(listener: DisconnectListener) => void>
    removeListener: Mock<(listener: DisconnectListener) => void>
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
    postMessage: vi.fn((_msg: unknown) => {}),
    disconnect: vi.fn((): void => {
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
