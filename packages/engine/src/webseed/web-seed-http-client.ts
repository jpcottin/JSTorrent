import type { HttpBodyReader, HttpTransport } from '../http/http-transport'
import { SocketHttpTransport } from '../http/socket-http-transport'
import type { ISocketFactory } from '../interfaces/socket'
import type { Logger } from '../logging/logger'

export type WebSeedRequestErrorKind =
  | 'not-found'
  | 'range-not-satisfiable'
  | 'transient'
  | 'protocol'

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
    const response = await this.transport.request({
      method: 'GET',
      url,
      signal,
      keepAlive: true,
      headers: {
        Range: `bytes=${start}-${endInclusive}`,
      },
    })

    validateWebSeedResponse(response.head.statusCode, response.head.headers, {
      start,
      endInclusive,
      expectedLength,
    })

    return {
      statusCode: response.head.statusCode,
      headers: response.head.headers,
      finalUrl: response.finalUrl,
      remoteAddress: response.remoteAddress,
      body: response.body,
      start,
      endInclusive,
    }
  }

  close(): void {
    this.transport.close?.()
  }
}

function isSocketFactory(value: HttpTransport | ISocketFactory): value is ISocketFactory {
  return 'createTcpSocket' in value
}

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
