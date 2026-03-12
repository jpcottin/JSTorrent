import { describe, expect, it } from 'vitest'
import { HttpResponseParser } from '../../src/http/http-parser'
import { concat, fromString, toString } from '../../src/utils/buffer'
import type { HttpParserEvent } from '../../src/http/http-types'

function collectBody(events: HttpParserEvent[]): string {
  const chunks = events.filter(
    (event): event is Extract<HttpParserEvent, { type: 'body' }> => event.type === 'body',
  )
  return toString(concat(chunks.map((event) => event.chunk)))
}

describe('HttpResponseParser', () => {
  it('parses fragmented content-length responses', () => {
    const parser = new HttpResponseParser()

    const events1 = parser.push(
      fromString('HTTP/1.1 206 Partial Content\r\nContent-Length: 5\r\nX-Test: ok\r\n\r\nhe'),
    )
    expect(events1[0]).toMatchObject({
      type: 'head',
      head: {
        statusCode: 206,
        statusMessage: 'Partial Content',
        bodyMode: 'content-length',
        contentLength: 5,
      },
    })
    expect(collectBody(events1)).toBe('he')
    expect(parser.isComplete).toBe(false)

    const events2 = parser.push(fromString('llo'))
    expect(collectBody(events2)).toBe('llo')
    expect(events2.at(-1)).toEqual({ type: 'end' })
    expect(parser.isComplete).toBe(true)
  })

  it('parses chunked responses across multiple pushes', () => {
    const parser = new HttpResponseParser()

    const events1 = parser.push(
      fromString('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n5\r\npe'),
    )
    expect(events1[0]).toMatchObject({
      type: 'head',
      head: {
        statusCode: 200,
        bodyMode: 'chunked',
      },
    })
    expect(collectBody(events1)).toBe('Wiki')

    const events2 = parser.push(fromString('dia\r\n0\r\nX-Trailer: done\r\n\r\n'))
    expect(collectBody(events2)).toBe('pedia')
    expect(events2.at(-1)).toEqual({ type: 'end' })
    expect(parser.isComplete).toBe(true)
  })

  it('treats 204 as bodyless and ends immediately', () => {
    const parser = new HttpResponseParser()

    const events = parser.push(fromString('HTTP/1.1 204 No Content\r\nDate: today\r\n\r\n'))
    expect(events).toEqual([
      {
        type: 'head',
        head: {
          statusCode: 204,
          statusMessage: 'No Content',
          headers: { date: 'today' },
          bodyMode: 'none',
          contentLength: 0,
        },
      },
      { type: 'end' },
    ])
  })

  it('supports close-delimited bodies when the stream closes', () => {
    const parser = new HttpResponseParser()

    const events1 = parser.push(fromString('HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nhello'))
    expect(events1[0]).toMatchObject({
      type: 'head',
      head: {
        statusCode: 200,
        bodyMode: 'close-delimited',
      },
    })
    expect(collectBody(events1)).toBe('hello')
    expect(parser.isComplete).toBe(false)

    const events2 = parser.close()
    expect(events2).toEqual([{ type: 'end' }])
    expect(parser.isComplete).toBe(true)
  })

  it('rejects unsupported transfer encodings', () => {
    const parser = new HttpResponseParser()
    expect(() =>
      parser.push(fromString('HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n')),
    ).toThrow('Unsupported Transfer-Encoding')
  })

  it('rejects premature close for incomplete content-length bodies', () => {
    const parser = new HttpResponseParser()
    parser.push(fromString('HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nab'))
    expect(() => parser.close()).toThrow('HTTP stream closed before content-length body completed')
  })
})
