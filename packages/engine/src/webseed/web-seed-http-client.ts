import type { HttpBodyReader, HttpTransport } from '../http/http-transport'
import { SocketHttpTransport } from '../http/socket-http-transport'
import type { ISocketFactory } from '../interfaces/socket'
import type { Logger } from '../logging/logger'

export type WebSeedRequestErrorKind =
  | 'not-found'
  | 'range-not-satisfiable'
  | 'transient'
  | 'protocol'
  | 'redirect'

export interface WebSeedRangeRequest {
  url: string
  start: number
  endInclusive: number
  signal?: AbortSignal
}

export interface WebSeedRangeResponse {
  statusCode: number
  headers: Record<string, string>
  finalUrl: string
  remoteAddress?: string
  body: HttpBodyReader
  start: number
  endInclusive: number
}

export class WebSeedRequestError extends Error {
  constructor(
    message: string,
    readonly kind: WebSeedRequestErrorKind,
    readonly options: {
      statusCode?: number
      retryAfterMs?: number
    } = {},
  ) {
    super(message)
    this.name = 'WebSeedRequestError'
  }
}

export class WebSeedHttpClient {
  private readonly transport: HttpTransport

  constructor(transport: HttpTransport)
  constructor(socketFactory: ISocketFactory, logger?: Logger)
  constructor(transportOrSocketFactory: HttpTransport | ISocketFactory, logger?: Logger) {
    if (isSocketFactory(transportOrSocketFactory)) {
      this.transport = new SocketHttpTransport(transportOrSocketFactory, logger, 'web-seed')
    } else {
      this.transport = transportOrSocketFactory
    }
  }

  async requestRange(request: WebSeedRangeRequest): Promise<WebSeedRangeResponse> {
    const { url, start, endInclusive, signal } = request

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(endInclusive) ||
      start < 0 ||
      endInclusive < start
    ) {
      throw new Error(`Invalid web-seed range: ${start}-${endInclusive}`)
    }

    const expectedLength = endInclusive - start + 1
    let currentUrl = url
    const visitedUrls = new Set<string>([currentUrl])

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
      const response = await this.transport.request({
        method: 'GET',
        url: currentUrl,
        signal,
        keepAlive: true,
        headers: {
          Range: `bytes=${start}-${endInclusive}`,
        },
      })

      if (isRedirectStatus(response.head.statusCode)) {
        if (redirectCount === MAX_REDIRECTS) {
          response.body.cancel('web-seed redirect limit exceeded')
          throw new WebSeedRequestError('Web seed exceeded redirect limit', 'redirect', {
            statusCode: response.head.statusCode,
          })
        }

        const nextUrl = resolveRedirectTarget(currentUrl, response.head.statusCode, response.head.headers)
        await discardResponseBody(response.body)

        if (visitedUrls.has(nextUrl)) {
          throw new WebSeedRequestError('Web seed redirect loop detected', 'redirect', {
            statusCode: response.head.statusCode,
          })
        }

        visitedUrls.add(nextUrl)
        currentUrl = nextUrl
        continue
      }

      validateWebSeedResponse(response.head.statusCode, response.head.headers, {
        start,
        endInclusive,
        expectedLength,
      })

      return {
        statusCode: response.head.statusCode,
        headers: response.head.headers,
        finalUrl: currentUrl,
        remoteAddress: response.remoteAddress,
        body: response.body,
        start,
        endInclusive,
      }
    }

    throw new WebSeedRequestError('Web seed redirect resolution failed', 'redirect')
  }

  close(): void {
    this.transport.close?.()
  }
}

function isSocketFactory(value: HttpTransport | ISocketFactory): value is ISocketFactory {
  return 'createTcpSocket' in value
}

const MAX_REDIRECTS = 5

function validateWebSeedResponse(
  statusCode: number,
  headers: Record<string, string>,
  range: { start: number; endInclusive: number; expectedLength: number },
): void {
  if (statusCode === 404 || statusCode === 410) {
    throw new WebSeedRequestError(`Web seed returned HTTP ${statusCode}`, 'not-found', {
      statusCode,
    })
  }

  if (statusCode === 416) {
    throw new WebSeedRequestError('Web seed returned HTTP 416', 'range-not-satisfiable', {
      statusCode,
    })
  }

  if (statusCode === 429 || statusCode === 503 || statusCode === 500 || statusCode === 502 || statusCode === 504) {
    throw new WebSeedRequestError(`Web seed returned HTTP ${statusCode}`, 'transient', {
      statusCode,
      retryAfterMs: parseRetryAfter(headers['retry-after']),
    })
  }

  if (statusCode === 206) {
    const contentRange = headers['content-range']
    if (!contentRange) {
      throw new WebSeedRequestError('Web seed 206 response missing Content-Range', 'protocol', {
        statusCode,
      })
    }

    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange.trim())
    if (!match) {
      throw new WebSeedRequestError(`Invalid Content-Range: ${contentRange}`, 'protocol', {
        statusCode,
      })
    }

    const actualStart = parseInt(match[1], 10)
    const actualEnd = parseInt(match[2], 10)
    if (actualStart !== range.start || actualEnd !== range.endInclusive) {
      throw new WebSeedRequestError(
        `Web seed returned unexpected range: ${actualStart}-${actualEnd} (expected ${range.start}-${range.endInclusive})`,
        'protocol',
        { statusCode },
      )
    }

    const contentLength = parseOptionalContentLength(headers)
    if (contentLength !== null && contentLength !== range.expectedLength) {
      throw new WebSeedRequestError(
        `Web seed Content-Length mismatch: ${contentLength} (expected ${range.expectedLength})`,
        'protocol',
        { statusCode },
      )
    }
    return
  }

  if (statusCode === 200) {
    if (range.start !== 0) {
      throw new WebSeedRequestError('Web seed ignored Range request with 200 response', 'protocol', {
        statusCode,
      })
    }

    const contentLength = parseOptionalContentLength(headers)
    if (contentLength !== null && contentLength !== range.expectedLength) {
      throw new WebSeedRequestError(
        `Web seed 200 response length mismatch: ${contentLength} (expected ${range.expectedLength})`,
        'protocol',
        { statusCode },
      )
    }
    return
  }

  throw new WebSeedRequestError(`Unexpected web-seed status code: ${statusCode}`, 'protocol', {
    statusCode,
  })
}

function isRedirectStatus(statusCode: number): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308
}

function resolveRedirectTarget(
  currentUrl: string,
  statusCode: number,
  headers: Record<string, string>,
): string {
  const location = headers.location
  if (!location) {
    throw new WebSeedRequestError(`Web seed redirect ${statusCode} missing Location header`, 'redirect', {
      statusCode,
    })
  }

  let resolved: URL
  try {
    resolved = new URL(location, currentUrl)
  } catch {
    throw new WebSeedRequestError(`Invalid redirect target: ${location}`, 'redirect', {
      statusCode,
    })
  }

  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new WebSeedRequestError(`Unsupported redirect protocol: ${resolved.protocol}`, 'redirect', {
      statusCode,
    })
  }

  const current = new URL(currentUrl)
  if (current.protocol === 'https:' && resolved.protocol !== 'https:') {
    throw new WebSeedRequestError('Web seed redirect attempted HTTPS downgrade', 'redirect', {
      statusCode,
    })
  }

  return resolved.toString()
}

function parseOptionalContentLength(headers: Record<string, string>): number | null {
  const value = headers['content-length']
  if (value === undefined) return null
  const parsed = parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid Content-Length: ${value}`)
  }
  return parsed
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined

  const seconds = parseInt(value, 10)
  if (Number.isInteger(seconds) && seconds >= 0) {
    return seconds * 1000
  }

  const timestamp = Date.parse(value)
  if (!Number.isNaN(timestamp)) {
    return Math.max(0, timestamp - Date.now())
  }

  return undefined
}

async function discardResponseBody(body: HttpBodyReader): Promise<void> {
  try {
    for (;;) {
      const chunk = await body.read()
      if (chunk === null) return
    }
  } catch {
    body.cancel('web-seed redirect body discard failed')
  }
}
