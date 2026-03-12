import type { HttpBodyReader, HttpTransport } from '../http/http-transport'
import { SocketHttpTransport } from '../http/socket-http-transport'
import type { ISocketFactory } from '../interfaces/socket'
import type { Logger } from '../logging/logger'

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
  if (statusCode === 206) {
    const contentRange = headers['content-range']
    if (!contentRange) {
      throw new Error('Web seed 206 response missing Content-Range')
    }

    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange.trim())
    if (!match) {
      throw new Error(`Invalid Content-Range: ${contentRange}`)
    }

    const actualStart = parseInt(match[1], 10)
    const actualEnd = parseInt(match[2], 10)
    if (actualStart !== range.start || actualEnd !== range.endInclusive) {
      throw new Error(
        `Web seed returned unexpected range: ${actualStart}-${actualEnd} (expected ${range.start}-${range.endInclusive})`,
      )
    }

    const contentLength = parseOptionalContentLength(headers)
    if (contentLength !== null && contentLength !== range.expectedLength) {
      throw new Error(
        `Web seed Content-Length mismatch: ${contentLength} (expected ${range.expectedLength})`,
      )
    }
    return
  }

  if (statusCode === 200) {
    if (range.start !== 0) {
      throw new Error('Web seed ignored Range request with 200 response')
    }

    const contentLength = parseOptionalContentLength(headers)
    if (contentLength !== null && contentLength !== range.expectedLength) {
      throw new Error(
        `Web seed 200 response length mismatch: ${contentLength} (expected ${range.expectedLength})`,
      )
    }
    return
  }

  throw new Error(`Unexpected web-seed status code: ${statusCode}`)
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
