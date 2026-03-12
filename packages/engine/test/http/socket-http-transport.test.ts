import { describe, expect, it } from 'vitest'
import type {
  ISocketFactory,
  ITcpServer,
  ITcpSocket,
  IUdpSocket,
  TcpSocketOptions,
} from '../../src/interfaces/socket'
import { SocketHttpTransport } from '../../src/http/socket-http-transport'
import { fromString, toString } from '../../src/utils/buffer'

async function flushMicrotasks(rounds = 3): Promise<void> {
  for (let index = 0; index < rounds; index++) {
    await Promise.resolve()
  }
}

class MockTcpSocket implements ITcpSocket {
  sent: Uint8Array[] = []
  remoteAddress?: string = '203.0.113.10'
  remotePort?: number = 443
  secure = async () => {}

  private onDataCb: ((data: Uint8Array) => void) | null = null
  private onCloseCb: ((hadError: boolean) => void) | null = null
  private onErrorCb: ((err: Error) => void) | null = null
  closed = false

  send(data: Uint8Array): void {
    this.sent.push(new Uint8Array(data))
  }

  onData(cb: (data: Uint8Array) => void): void {
    this.onDataCb = cb
  }

  onClose(cb: (hadError: boolean) => void): void {
    this.onCloseCb = cb
  }

  onError(cb: (err: Error) => void): void {
    this.onErrorCb = cb
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.onCloseCb?.(false)
  }

  emitData(data: string): void {
    this.onDataCb?.(fromString(data))
  }

  emitError(message: string): void {
    this.onErrorCb?.(new Error(message))
  }
}

class MockSocketFactory implements ISocketFactory {
  sockets: MockTcpSocket[] = []
  requests: TcpSocketOptions[] = []

  async createTcpSocket(options?: TcpSocketOptions): Promise<ITcpSocket> {
    this.requests.push(options ?? {})
    const socket = new MockTcpSocket()
    this.sockets.push(socket)
    return socket
  }

  async createUdpSocket(): Promise<IUdpSocket> {
    throw new Error('not implemented')
  }

  createTcpServer(): ITcpServer {
    throw new Error('not implemented')
  }

  wrapTcpSocket(socket: unknown): ITcpSocket {
    return socket as ITcpSocket
  }
}

describe('SocketHttpTransport', () => {
  it('streams content-length responses', async () => {
    const factory = new MockSocketFactory()
    const transport = new SocketHttpTransport(factory)

    const responsePromise = transport.request({
      method: 'GET',
      url: 'http://example.com/file.bin?x=1',
    })
    await flushMicrotasks()

    factory.sockets[0].emitData('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhe')
    const response = await responsePromise
    expect(response.head.statusCode).toBe(200)
    expect(response.remoteAddress).toBe('203.0.113.10')
    expect(toString(factory.sockets[0].sent[0])).toContain('GET /file.bin?x=1 HTTP/1.1')

    factory.sockets[0].emitData('llo')
    expect(toString((await response.body.read())!)).toBe('he')
    expect(toString((await response.body.read())!)).toBe('llo')
    expect(await response.body.read()).toBeNull()
  })

  it('streams chunked responses', async () => {
    const factory = new MockSocketFactory()
    const transport = new SocketHttpTransport(factory)

    const responsePromise = transport.request({
      method: 'GET',
      url: 'http://example.com/chunked',
    })
    await flushMicrotasks()

    factory.sockets[0].emitData(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n',
    )
    const response = await responsePromise

    factory.sockets[0].emitData('6\r\n world\r\n0\r\n\r\n')
    expect(toString((await response.body.read())!)).toBe('hello')
    expect(toString((await response.body.read())!)).toBe(' world')
    expect(await response.body.read()).toBeNull()
  })

  it('supports canceling the body reader', async () => {
    const factory = new MockSocketFactory()
    const transport = new SocketHttpTransport(factory)

    const responsePromise = transport.request({
      method: 'GET',
      url: 'http://example.com/file.bin',
    })
    await flushMicrotasks()

    factory.sockets[0].emitData('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nhello')
    const response = await responsePromise
    response.body.cancel('stop')

    await expect(response.body.read()).rejects.toThrow('stop')
    expect(factory.sockets[0].closed).toBe(true)
  })

  it('reuses a keep-alive socket for sequential requests to the same origin', async () => {
    const factory = new MockSocketFactory()
    const transport = new SocketHttpTransport(factory)

    const firstResponsePromise = transport.request({
      method: 'GET',
      url: 'http://example.com/first.bin',
      keepAlive: true,
    })
    await flushMicrotasks()

    expect(toString(factory.sockets[0].sent[0])).toContain('Connection: keep-alive')
    factory.sockets[0].emitData('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello')
    const firstResponse = await firstResponsePromise
    expect(toString((await firstResponse.body.read())!)).toBe('hello')
    expect(await firstResponse.body.read()).toBeNull()

    const secondResponsePromise = transport.request({
      method: 'GET',
      url: 'http://example.com/second.bin',
      keepAlive: true,
    })
    await flushMicrotasks()

    expect(factory.sockets).toHaveLength(1)
    expect(factory.sockets[0].sent).toHaveLength(2)
    expect(toString(factory.sockets[0].sent[1])).toContain('GET /second.bin HTTP/1.1')
    factory.sockets[0].emitData('HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nsecond')
    const secondResponse = await secondResponsePromise
    expect(toString((await secondResponse.body.read())!)).toBe('second')
    expect(await secondResponse.body.read()).toBeNull()
  })

  it('falls back to a new socket when the server responds with Connection: close', async () => {
    const factory = new MockSocketFactory()
    const transport = new SocketHttpTransport(factory)

    const firstResponsePromise = transport.request({
      method: 'GET',
      url: 'http://example.com/first.bin',
      keepAlive: true,
    })
    await flushMicrotasks()

    factory.sockets[0].emitData(
      'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello',
    )
    const firstResponse = await firstResponsePromise
    expect(toString((await firstResponse.body.read())!)).toBe('hello')
    expect(await firstResponse.body.read()).toBeNull()

    const secondResponsePromise = transport.request({
      method: 'GET',
      url: 'http://example.com/second.bin',
      keepAlive: true,
    })
    await flushMicrotasks()

    expect(factory.sockets).toHaveLength(2)
    factory.sockets[1].emitData('HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nsecond')
    const secondResponse = await secondResponsePromise
    expect(toString((await secondResponse.body.read())!)).toBe('second')
    expect(await secondResponse.body.read()).toBeNull()
  })
})
