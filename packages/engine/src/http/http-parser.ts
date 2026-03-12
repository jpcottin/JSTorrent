import { concat, fromString, toString } from '../utils/buffer'
import type { HttpParserEvent, HttpResponseBodyMode, HttpResponseHead } from './http-types'

const CRLF = fromString('\r\n')
const CRLF_CRLF = fromString('\r\n\r\n')

function findSequence(buffer: Uint8Array, sequence: Uint8Array): number {
  outer: for (let i = 0; i <= buffer.length - sequence.length; i++) {
    for (let j = 0; j < sequence.length; j++) {
      if (buffer[i + j] !== sequence[j]) continue outer
    }
    return i
  }
  return -1
}

function parseStatusLine(line: string): { statusCode: number; statusMessage: string } {
  const match = /^HTTP\/1\.[01]\s+(\d{3})(?:\s+(.*))?$/.exec(line)
  if (!match) {
    throw new Error(`Invalid HTTP status line: ${line}`)
  }

  const statusCode = parseInt(match[1], 10)
  if (!Number.isInteger(statusCode)) {
    throw new Error(`Invalid HTTP status code: ${line}`)
  }

  return {
    statusCode,
    statusMessage: match[2] ?? '',
  }
}

function parseHeaders(lines: string[]): Record<string, string> {
  const headers: Record<string, string> = {}

  for (const line of lines) {
    const separator = line.indexOf(':')
    if (separator <= 0) {
      throw new Error(`Invalid HTTP header line: ${line}`)
    }

    const key = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    headers[key] = value
  }

  return headers
}

function determineBodyMode(
  statusCode: number,
  headers: Record<string, string>,
): { bodyMode: HttpResponseBodyMode; contentLength: number | null } {
  if ((statusCode >= 100 && statusCode < 200) || statusCode === 204 || statusCode === 304) {
    return { bodyMode: 'none', contentLength: 0 }
  }

  const transferEncoding = headers['transfer-encoding']?.toLowerCase()
  if (transferEncoding) {
    const codings = transferEncoding
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
    if (codings[codings.length - 1] !== 'chunked') {
      throw new Error(`Unsupported Transfer-Encoding: ${headers['transfer-encoding']}`)
    }
    return { bodyMode: 'chunked', contentLength: null }
  }

  const contentLengthHeader = headers['content-length']
  if (contentLengthHeader !== undefined) {
    const contentLength = parseInt(contentLengthHeader, 10)
    if (!Number.isInteger(contentLength) || contentLength < 0) {
      throw new Error(`Invalid Content-Length: ${contentLengthHeader}`)
    }
    return { bodyMode: 'content-length', contentLength }
  }

  return { bodyMode: 'close-delimited', contentLength: null }
}

export class HttpResponseParser {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  private head: HttpResponseHead | null = null
  private complete = false
  private contentLengthRemaining = 0
  private chunkBytesRemaining: number | null = null
  private readingChunkTrailers = false

  get responseHead(): HttpResponseHead | null {
    return this.head
  }

  get isComplete(): boolean {
    return this.complete
  }

  push(data: Uint8Array): HttpParserEvent[] {
    if (this.complete) {
      throw new Error('HTTP parser received data after completion')
    }
    if (data.length === 0) return []

    this.buffer =
      this.buffer.length === 0 ? new Uint8Array(Array.from(data)) : concat([this.buffer, data])
    return this.drain()
  }

  close(): HttpParserEvent[] {
    if (this.complete) return []

    if (!this.head) {
      if (this.buffer.length > 0) {
        throw new Error('HTTP stream closed before headers completed')
      }
      throw new Error('HTTP stream closed before response started')
    }

    if (this.head.bodyMode === 'close-delimited') {
      const events: HttpParserEvent[] = []
      if (this.buffer.length > 0) {
        events.push({ type: 'body', chunk: this.buffer })
        this.buffer = new Uint8Array(0)
      }
      this.complete = true
      events.push({ type: 'end' })
      return events
    }

    if (this.head.bodyMode === 'content-length' && this.contentLengthRemaining === 0) {
      this.complete = true
      return [{ type: 'end' }]
    }

    throw new Error(`HTTP stream closed before ${this.head.bodyMode} body completed`)
  }

  private drain(): HttpParserEvent[] {
    const events: HttpParserEvent[] = []

    if (!this.head) {
      const separatorIndex = findSequence(this.buffer, CRLF_CRLF)
      if (separatorIndex === -1) return events

      const headerText = toString(this.buffer.subarray(0, separatorIndex))
      const lines = headerText.split('\r\n')
      const status = parseStatusLine(lines[0] ?? '')
      const headers = parseHeaders(lines.slice(1))
      const { bodyMode, contentLength } = determineBodyMode(status.statusCode, headers)

      this.head = {
        statusCode: status.statusCode,
        statusMessage: status.statusMessage,
        headers,
        bodyMode,
        contentLength,
      }
      this.contentLengthRemaining = contentLength ?? 0
      this.buffer = this.buffer.subarray(separatorIndex + CRLF_CRLF.length)
      events.push({ type: 'head', head: this.head })
    }

    if (!this.head || this.complete) return events

    if (this.head.bodyMode === 'none') {
      if (this.buffer.length > 0) {
        throw new Error('Received unexpected bytes for response without a body')
      }
      this.complete = true
      events.push({ type: 'end' })
      return events
    }

    if (this.head.bodyMode === 'content-length') {
      while (this.contentLengthRemaining > 0 && this.buffer.length > 0) {
        const emitLength = Math.min(this.contentLengthRemaining, this.buffer.length)
        events.push({ type: 'body', chunk: this.buffer.subarray(0, emitLength) })
        this.buffer = this.buffer.subarray(emitLength)
        this.contentLengthRemaining -= emitLength
      }

      if (this.contentLengthRemaining === 0) {
        this.complete = true
        events.push({ type: 'end' })
      }

      return events
    }

    if (this.head.bodyMode === 'close-delimited') {
      if (this.buffer.length > 0) {
        events.push({ type: 'body', chunk: this.buffer })
        this.buffer = new Uint8Array(0)
      }
      return events
    }

    while (!this.complete) {
      if (this.readingChunkTrailers) {
        const trailersEnd = findSequence(this.buffer, CRLF_CRLF)
        if (trailersEnd === -1) {
          if (this.buffer.length === 0) return events
          if (this.buffer.length === CRLF.length && findSequence(this.buffer, CRLF) === 0) {
            this.buffer = new Uint8Array(0)
            this.complete = true
            events.push({ type: 'end' })
          }
          return events
        }

        this.buffer = this.buffer.subarray(trailersEnd + CRLF_CRLF.length)
        this.complete = true
        events.push({ type: 'end' })
        return events
      }

      if (this.chunkBytesRemaining === null) {
        const lineEnd = findSequence(this.buffer, CRLF)
        if (lineEnd === -1) return events

        const line = toString(this.buffer.subarray(0, lineEnd))
        const sizeHex = line.split(';', 1)[0].trim()
        const chunkSize = parseInt(sizeHex, 16)
        if (!Number.isInteger(chunkSize) || chunkSize < 0) {
          throw new Error(`Invalid chunk size: ${line}`)
        }

        this.buffer = this.buffer.subarray(lineEnd + CRLF.length)

        if (chunkSize === 0) {
          this.readingChunkTrailers = true
          continue
        }

        this.chunkBytesRemaining = chunkSize
      }

      const chunkSize = this.chunkBytesRemaining
      if (chunkSize === null) continue

      if (this.buffer.length < chunkSize + CRLF.length) return events
      if (
        this.buffer[chunkSize] !== CRLF[0] ||
        this.buffer[chunkSize + 1] !== CRLF[1]
      ) {
        throw new Error('Invalid chunk framing')
      }

      events.push({ type: 'body', chunk: this.buffer.subarray(0, chunkSize) })
      this.buffer = this.buffer.subarray(chunkSize + CRLF.length)
      this.chunkBytesRemaining = null
    }

    return events
  }
}
