import type { AddressFamilyPreference, ISocketFactory, ITcpSocket, SocketPurpose } from '../interfaces/socket'
import { PREFERRED_ADDRESS_FAMILY } from '../interfaces/socket'
import { Logger } from '../logging/logger'
import { fromString } from '../utils/buffer'
import { HttpResponseParser } from './http-parser'
import type { HttpBodyReader, HttpRequest, HttpTransport, HttpTransportResponse } from './http-transport'
import { parseHttpUrl } from './url-utils'
import type { HttpParserEvent } from './http-types'

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

export class SocketHttpTransport implements HttpTransport {
  constructor(
    private socketFactory: ISocketFactory,
    private logger?: Logger,
    private purpose?: SocketPurpose,
    private addressFamily: AddressFamilyPreference = PREFERRED_ADDRESS_FAMILY,
  ) {}

  async request(request: HttpRequest): Promise<HttpTransportResponse> {
    const parsedUrl = parseHttpUrl(request.url)
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

    return new Promise<HttpTransportResponse>((resolve, reject) => {
      const parser = new HttpResponseParser()
      const body = new AsyncChunkQueue()
      let settled = false
      let responseResolved = false
      let cleanedUp = false

      const cleanup = () => {
        if (cleanedUp) return
        cleanedUp = true
      }

      const fail = (error: Error) => {
        if (!settled) {
          settled = true
          cleanup()
          body.fail(error)
          socket.close()
          reject(error)
          return
        }

        if (!cleanedUp) cleanup()
        body.fail(error)
        socket.close()
      }

      const processEvents = (events: HttpParserEvent[]) => {
        for (const event of events) {
          if (event.type === 'head') {
            if (responseResolved) {
              fail(new Error('Received duplicate HTTP response head'))
              return
            }
            responseResolved = true
            settled = true
            resolve({
              head: event.head,
              body: {
                read: () => body.read(),
                cancel: (reason?: string) => {
                  body.cancel(reason)
                  socket.close()
                },
              },
              remoteAddress: socket.remoteAddress,
              finalUrl: request.url,
            })
          } else if (event.type === 'body') {
            body.push(event.chunk)
          } else if (event.type === 'end') {
            cleanup()
            body.finish()
          }
        }
      }

      socket.onData((data) => {
        try {
          processEvents(parser.push(data))
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)))
        }
      })

      socket.onError((error) => {
        fail(error)
      })

      socket.onClose(() => {
        try {
          if (!parser.isComplete) {
            processEvents(parser.close())
          }
          if (!parser.isComplete) {
            fail(new Error('HTTP socket closed before response completed'))
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)))
        }
      })

      try {
        socket.send(
          fromString(
            buildHttpRequestText({
              method: request.method,
              host: parsedUrl.hostname,
              path: parsedUrl.path,
              headers: request.headers,
            }),
          ),
        )
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }

      request.signal?.addEventListener(
        'abort',
        () => {
          fail(new Error('HTTP request aborted'))
        },
        { once: true },
      )
    })
  }
}

function buildHttpRequestText(options: {
  method: string
  host: string
  path: string
  headers?: Record<string, string>
}): string {
  const requestLines = [
    `${options.method} ${options.path} HTTP/1.1`,
    `Host: ${options.host}`,
    'Connection: close',
    'User-Agent: JSTorrent/0.0.1',
    'Accept-Encoding: identity',
  ]

  for (const [key, value] of Object.entries(options.headers ?? {})) {
    requestLines.push(`${key}: ${value}`)
  }

  requestLines.push('', '')
  return requestLines.join('\r\n')
}

