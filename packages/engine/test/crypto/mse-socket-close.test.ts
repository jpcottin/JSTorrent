import { describe, it, expect, vi } from 'vitest'
import { MseSocket } from '../../src/crypto/mse-socket'
import { ITcpSocket } from '../../src/interfaces/socket'

/**
 * Creates a mock ITcpSocket that supports buffered close events,
 * similar to DaemonTcpSocket behavior.
 */
function createMockSocket(): ITcpSocket & {
  fireClose: (hadError: boolean) => void
  fireData: (data: Uint8Array) => void
} {
  let onDataCb: ((data: Uint8Array) => void) | null = null
  let onCloseCb: ((hadError: boolean) => void) | null = null
  let onErrorCb: ((err: Error) => void) | null = null
  let closed = false
  let pendingClose: { hadError: boolean } | null = null

  const socket: ITcpSocket & {
    fireClose: (hadError: boolean) => void
    fireData: (data: Uint8Array) => void
  } = {
    remoteAddress: '1.2.3.4',
    remotePort: 6881,

    send: vi.fn(),

    onData(cb) {
      onDataCb = cb
    },

    onClose(cb) {
      onCloseCb = cb
      // Deliver buffered close (matches DaemonTcpSocket behavior)
      if (pendingClose) {
        cb(pendingClose.hadError)
        pendingClose = null
      }
    },

    onError(cb) {
      onErrorCb = cb
    },

    close() {
      if (closed) return
      closed = true
      if (onCloseCb) {
        onCloseCb(false)
      }
    },

    // Test helpers to simulate daemon-side events
    fireClose(hadError: boolean) {
      if (closed) return
      closed = true
      if (onCloseCb) {
        onCloseCb(hadError)
      } else {
        pendingClose = { hadError }
      }
    },

    fireData(data: Uint8Array) {
      onDataCb?.(data)
    },
  }

  return socket
}

async function sha1Batch(inputs: Uint8Array[]): Promise<Uint8Array[]> {
  return Promise.all(
    inputs.map(async (input) => {
      const hash = await crypto.subtle.digest('SHA-1', input as BufferSource)
      return new Uint8Array(hash)
    }),
  )
}

function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

describe('MseSocket close event propagation', () => {
  it('propagates close event that arrives after onClose is registered', () => {
    const rawSocket = createMockSocket()
    const mseSocket = new MseSocket(rawSocket, {
      policy: 'disabled',
      sha1Batch,
      getRandomBytes,
    })

    const closeCb = vi.fn()
    mseSocket.onClose(closeCb)

    // Simulate daemon closing the connection
    rawSocket.fireClose(false)

    expect(closeCb).toHaveBeenCalledWith(false)
  })

  it('BUG: loses close event that arrives before onClose is registered', () => {
    const rawSocket = createMockSocket()

    // Daemon fires close BEFORE MseSocket is constructed
    // (e.g., connection reset during MSE handshake setup)
    rawSocket.fireClose(true)

    // MseSocket constructor calls rawSocket.onClose(), consuming the buffered close.
    // But MseSocket.onCloseCb is null at this point, so the event is lost.
    const mseSocket = new MseSocket(rawSocket, {
      policy: 'disabled',
      sha1Batch,
      getRandomBytes,
    })

    const closeCb = vi.fn()
    mseSocket.onClose(closeCb)

    // The close event was consumed by MseSocket constructor and lost.
    // PeerConnection's close handler never fires → peer stuck in connectedKeys forever.
    expect(closeCb).toHaveBeenCalledWith(true)
  })

  it('BUG: close() is a no-op after daemon-side close was lost', () => {
    const rawSocket = createMockSocket()

    // Daemon fires close before MseSocket exists
    rawSocket.fireClose(false)

    const mseSocket = new MseSocket(rawSocket, {
      policy: 'disabled',
      sha1Batch,
      getRandomBytes,
    })

    const closeCb = vi.fn()
    mseSocket.onClose(closeCb)

    // Try to explicitly close - this calls rawSocket.close()
    // which hits `if (closed) return` → no callback fires
    mseSocket.close()

    // The peer can never be removed from the swarm
    expect(closeCb).toHaveBeenCalled()
  })
})
