import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as net from 'net'
import { startDaemon, DaemonHarness } from './helpers/daemon-harness'
import { DaemonConnection } from '../../src/adapters/daemon/daemon-connection'
import { DaemonSocketFactory } from '../../src/adapters/daemon/daemon-socket-factory'

describe('DaemonSocketFactory TCP', () => {
  let harness: DaemonHarness
  let connection: DaemonConnection
  let factory: DaemonSocketFactory
  let echoServer: net.Server
  let echoPort: number
  let drainInterval: ReturnType<typeof setInterval>

  beforeAll(async () => {
    // Start daemon
    harness = await startDaemon()
    connection = new DaemonConnection(harness.port, '127.0.0.1', undefined, harness.token)
    await connection.connectWebSocket()
    factory = new DaemonSocketFactory(connection)

    // DaemonSocketFactory enables frame queuing (for batched processing in engine tick).
    // Without an engine tick loop, queued frames are never drained and all socket
    // operations timeout. Drain periodically to simulate the engine tick.
    drainInterval = setInterval(() => factory.flushCallbacks(), 10)

    // Start a local echo server for testing
    echoServer = net.createServer((socket) => {
      socket.on('data', (data) => {
        socket.write(data) // Echo back
      })
    })

    await new Promise<void>((resolve) => {
      echoServer.listen(0, '127.0.0.1', () => {
        const addr = echoServer.address() as net.AddressInfo
        echoPort = addr.port
        resolve()
      })
    })
  })

  afterAll(async () => {
    clearInterval(drainInterval)
    echoServer?.close()
    connection.close?.()
    await harness.cleanup()
  })

  it('should create TCP socket', async () => {
    const socket = await factory.createTcpSocket()
    expect(socket).toBeDefined()
    expect(typeof socket.connect).toBe('function')
  })

  it('should connect to local server', async () => {
    const socket = await factory.createTcpSocket()
    await socket.connect!(echoPort, '127.0.0.1')
    socket.close()
  })

  it('should send and receive data', async () => {
    const socket = await factory.createTcpSocket()
    await socket.connect!(echoPort, '127.0.0.1')

    const received: Uint8Array[] = []
    socket.onData((data) => {
      received.push(data)
    })

    const testData = new TextEncoder().encode('Hello, daemon!')
    socket.send(testData)

    // Wait for echo
    await new Promise((r) => setTimeout(r, 100))

    expect(received.length).toBeGreaterThan(0)
    const combined = new Uint8Array(received.reduce((acc, arr) => acc + arr.length, 0))
    let offset = 0
    for (const arr of received) {
      combined.set(arr, offset)
      offset += arr.length
    }
    expect(new TextDecoder().decode(combined)).toBe('Hello, daemon!')

    socket.close()
  })

  it('should handle connection errors', async () => {
    const socket = await factory.createTcpSocket()

    // Try to connect to a port that's not listening
    await expect(socket.connect!(59999, '127.0.0.1')).rejects.toThrow()
  })

  it('should handle remote close', async () => {
    // Create a server that accepts a connection, reads one byte, then closes
    const closeServer = net.createServer((socket) => {
      socket.once('data', () => {
        socket.destroy()
      })
    })

    const closePort = await new Promise<number>((resolve) => {
      closeServer.listen(0, '127.0.0.1', () => {
        resolve((closeServer.address() as net.AddressInfo).port)
      })
    })

    const socket = await factory.createTcpSocket()

    const closedPromise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000)
      socket.onClose(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })

    await socket.connect!(closePort, '127.0.0.1')

    // Send a byte to activate the daemon's read task (the read task is only
    // spawned on the first OP_TCP_SEND — until then the stream is held in
    // pending_tcp for potential TLS upgrade).
    socket.send(new Uint8Array([0]))

    const closed = await closedPromise
    expect(closed).toBe(true)

    closeServer.close()
  })
})
