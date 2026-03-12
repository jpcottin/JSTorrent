import type { AddressFamilyPreference, ISocketFactory, ITcpSocket, SocketPurpose } from '../interfaces/socket'
import { PREFERRED_ADDRESS_FAMILY } from '../interfaces/socket'
import { Logger } from '../logging/logger'
import { fromString } from '../utils/buffer'
import { HttpResponseParser } from './http-parser'
import type { HttpBodyReader, HttpRequest, HttpTransport, HttpTransportResponse } from './http-transport'
import type { HttpParserEvent, HttpResponseHead, ParsedHttpUrl } from './http-types'
import { parseHttpUrl } from './url-utils'

class AsyncChunkQueue implements HttpBodyReader {
  private chunks: Array<Uint8Array | null> = []
  private waiters: Array<{
    resolve: (value: Uint8Array | null) => void
    reject: (reason?: unknown) => void
  }> = []
  private ended = false
  private failure: Error | null = null

  push(chunk: Uint8Array): void {
    if (this.ended || this.failure) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve(chunk)
    } else {
      this.chunks.push(chunk)
    }
  }

  finish(): void {
    if (this.ended || this.failure) return
    this.ended = true
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve(null)
    } else {
      this.chunks.push(null)
    }
  }

  fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    while (this.waiters.length > 0) {
      this.waiters.shift()!.reject(error)
    }
  }

  read(): Promise<Uint8Array | null> {
    if (this.failure) {
      return Promise.reject(this.failure)
    }
    if (this.chunks.length > 0) {
      return Promise.resolve(this.chunks.shift() ?? null)
    }
    return new Promise<Uint8Array | null>((resolve, reject) => {
      this.waiters.push({ resolve, reject })
    })
  }

  cancel(reason?: string): void {
    this.fail(new Error(reason ?? 'HTTP body reader canceled'))
  }
}

interface SocketEntry {
  key: string
  socket: ITcpSocket
  closed: boolean
  inUse: boolean
}

function getPoolKey(parsedUrl: ParsedHttpUrl): string {
  return `${parsedUrl.protocol}//${parsedUrl.hostname}:${parsedUrl.port}`
}

function shouldKeepConnectionOpen(
  request: HttpRequest,
  head: HttpResponseHead,
  socketClosed: boolean,
): boolean {
  if (!request.keepAlive) return false
  if (socketClosed) return false
  if (head.bodyMode === 'close-delimited') return false

  const connection = head.headers.connection?.toLowerCase()
  if (connection === 'close') return false
  return true
}

export class SocketHttpTransport implements HttpTransport {
  private readonly idleEntries = new Map<string, SocketEntry[]>()
  private readonly allEntries = new Set<SocketEntry>()

  constructor(
    private socketFactory: ISocketFactory,
    _logger?: Logger,
    private purpose?: SocketPurpose,
    private addressFamily: AddressFamilyPreference = PREFERRED_ADDRESS_FAMILY,
  ) {}

  async request(request: HttpRequest): Promise<HttpTransportResponse> {
    const parsedUrl = parseHttpUrl(request.url)
    const entry = await this.reserveEntry(parsedUrl, request.keepAlive === true)
    return this.performRequest(entry, request, parsedUrl)
  }

  close(): void {
    for (const entry of this.allEntries) {
      this.destroyEntry(entry)
    }
    this.idleEntries.clear()
    this.allEntries.clear()
  }

  private async reserveEntry(parsedUrl: ParsedHttpUrl, allowReuse: boolean): Promise<SocketEntry> {
    const key = getPoolKey(parsedUrl)

    if (allowReuse) {
      const pooled = this.idleEntries.get(key)
      while (pooled && pooled.length > 0) {
        const entry = pooled.pop()!
        if (!entry.closed) {
          this.armIdleListeners(entry)
          return entry
        }
      }
      if (pooled && pooled.length === 0) {
        this.idleEntries.delete(key)
      }
    }

    const socket = await this.socketFactory.createTcpSocket({
      host: parsedUrl.hostname,
      port: parsedUrl.port,
      purpose: this.purpose,
      addressFamily: this.addressFamily,
    })

    if (parsedUrl.isHttps) {
      if (!socket.secure) {
        socket.close()
        throw new Error('HTTPS not supported: socket factory does not support TLS')
      }
      await socket.secure(parsedUrl.hostname)
    }

    const entry: SocketEntry = {
      key,
      socket,
      closed: false,
      inUse: false,
    }
    this.allEntries.add(entry)
    this.armIdleListeners(entry)
    return entry
  }

  private performRequest(
    entry: SocketEntry,
    request: HttpRequest,
    parsedUrl: ParsedHttpUrl,
  ): Promise<HttpTransportResponse> {
    if (entry.closed) {
      throw new Error('HTTP socket is closed')
    }

    this.removeIdleEntry(entry)
    entry.inUse = true

    return new Promise<HttpTransportResponse>((resolve, reject) => {
      const parser = new HttpResponseParser()
      const body = new AsyncChunkQueue()
      let responseResolved = false
      let socketClosed = false
      let head: HttpResponseHead | null = null
      let abortCleanup: (() => void) | null = null

      const bodyReader: HttpBodyReader = {
        read: async () => {
          const chunk = await body.read()
          if (chunk === null) {
            if (head && shouldKeepConnectionOpen(request, head, socketClosed) && !entry.closed) {
              this.releaseEntry(entry)
            }
          }
          return chunk
        },
        cancel: (reason?: string) => {
          body.cancel(reason)
          this.destroyEntry(entry)
        },
      }

      const cleanup = () => {
        abortCleanup?.()
        abortCleanup = null
        entry.inUse = false
      }

      const fail = (error: Error) => {
        cleanup()
        body.fail(error)
        this.destroyEntry(entry)
        if (!responseResolved) {
          reject(error)
        }
      }

      const finalizeResponse = () => {
        cleanup()
        body.finish()
        if (!head || !shouldKeepConnectionOpen(request, head, socketClosed)) {
          this.destroyEntry(entry)
        }
      }

      const processEvents = (events: HttpParserEvent[]) => {
        for (const event of events) {
          if (event.type === 'head') {
            if (responseResolved) {
              fail(new Error('Received duplicate HTTP response head'))
              return
            }

            head = event.head
            responseResolved = true
            resolve({
              head: event.head,
              body: bodyReader,
              remoteAddress: entry.socket.remoteAddress,
              finalUrl: request.url,
            })
          } else if (event.type === 'body') {
            body.push(event.chunk)
          } else if (event.type === 'end') {
            finalizeResponse()
          }
        }
      }

      entry.socket.onData((data) => {
        try {
          processEvents(parser.push(data))
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)))
        }
      })

      entry.socket.onError((error) => {
        fail(error)
      })

      entry.socket.onClose(() => {
        socketClosed = true

        try {
          if (!parser.isComplete) {
            processEvents(parser.close())
          }
          if (!parser.isComplete) {
            fail(new Error('HTTP socket closed before response completed'))
            return
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)))
          return
        }

        entry.closed = true
        this.removeIdleEntry(entry)
        this.allEntries.delete(entry)
      })

      try {
        entry.socket.send(
          fromString(
            buildHttpRequestText({
              method: request.method,
              host: parsedUrl.hostname,
              path: parsedUrl.path,
              headers: request.headers,
              keepAlive: request.keepAlive === true,
            }),
          ),
        )
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
        return
      }

      if (request.signal) {
        const onAbort = () => {
          fail(new Error('HTTP request aborted'))
        }
        request.signal.addEventListener('abort', onAbort, { once: true })
        abortCleanup = () => {
          request.signal?.removeEventListener('abort', onAbort)
        }
      }
    })
  }

  private releaseEntry(entry: SocketEntry): void {
    if (entry.closed || entry.inUse) return
    this.armIdleListeners(entry)
    const pooled = this.idleEntries.get(entry.key) ?? []
    if (!pooled.includes(entry)) {
      pooled.push(entry)
      this.idleEntries.set(entry.key, pooled)
    }
  }

  private destroyEntry(entry: SocketEntry): void {
    this.removeIdleEntry(entry)
    this.allEntries.delete(entry)
    entry.inUse = false
    if (entry.closed) return
    entry.closed = true
    entry.socket.close()
  }

  private removeIdleEntry(entry: SocketEntry): void {
    const pooled = this.idleEntries.get(entry.key)
    if (!pooled) return
    const index = pooled.indexOf(entry)
    if (index !== -1) {
      pooled.splice(index, 1)
    }
    if (pooled.length === 0) {
      this.idleEntries.delete(entry.key)
    }
  }

  private armIdleListeners(entry: SocketEntry): void {
    entry.socket.onData(() => {})
    entry.socket.onError(() => {
      entry.closed = true
      this.removeIdleEntry(entry)
      this.allEntries.delete(entry)
    })
    entry.socket.onClose(() => {
      entry.closed = true
      this.removeIdleEntry(entry)
      this.allEntries.delete(entry)
    })
  }
}

function buildHttpRequestText(options: {
  method: string
  host: string
  path: string
  headers?: Record<string, string>
  keepAlive?: boolean
}): string {
  const requestLines = [
    `${options.method} ${options.path} HTTP/1.1`,
    `Host: ${options.host}`,
    options.keepAlive ? 'Connection: keep-alive' : 'Connection: close',
    'User-Agent: JSTorrent/0.0.1',
    'Accept-Encoding: identity',
  ]

  for (const [key, value] of Object.entries(options.headers ?? {})) {
    requestLines.push(`${key}: ${value}`)
  }

  requestLines.push('', '')
  return requestLines.join('\r\n')
}
