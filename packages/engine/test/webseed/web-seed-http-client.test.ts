import { describe, expect, it } from 'vitest'
import type {
  HttpBodyReader,
  HttpTransport,
  HttpTransportResponse,
} from '../../src/http/http-transport'
import { WebSeedHttpClient, WebSeedRequestError } from '../../src/webseed/web-seed-http-client'

class StaticBodyReader implements HttpBodyReader {
  constructor(private chunks: Array<Uint8Array | null>) {}

  async read(): Promise<Uint8Array | null> {
    return this.chunks.shift() ?? null
  }

  cancel(): void {}
}

class MockHttpTransport implements HttpTransport {
  public requests: Parameters<HttpTransport['request']>[0][] = []

  constructor(private responseFactory: () => Promise<HttpTransportResponse>) {}

  async request(request: Parameters<HttpTransport['request']>[0]): Promise<HttpTransportResponse> {
    this.requests.push(request)
    return this.responseFactory()
  }
}

describe('WebSeedHttpClient', () => {
  it('issues a Range request and accepts a matching 206 response', async () => {
    const transport = new MockHttpTransport(async () => ({
      head: {
        statusCode: 206,
        statusMessage: 'Partial Content',
        headers: {
          'content-range': 'bytes 100-199/1000',
          'content-length': '100',
        },
        bodyMode: 'content-length',
        contentLength: 100,
      },
      body: new StaticBodyReader([null]),
      finalUrl: 'https://cdn.example.com/file.bin',
      remoteAddress: '198.51.100.2',
    }))

    const client = new WebSeedHttpClient(transport)
    const response = await client.requestRange({
      url: 'https://cdn.example.com/file.bin',
      start: 100,
      endInclusive: 199,
    })

    expect(transport.requests).toHaveLength(1)
    expect(transport.requests[0].headers).toMatchObject({
      Range: 'bytes=100-199',
    })
    expect(response.statusCode).toBe(206)
    expect(response.remoteAddress).toBe('198.51.100.2')
  })

  it('rejects a 206 response with a mismatched Content-Range', async () => {
    const transport = new MockHttpTransport(async () => ({
      head: {
        statusCode: 206,
        statusMessage: 'Partial Content',
        headers: {
          'content-range': 'bytes 0-99/1000',
          'content-length': '100',
        },
        bodyMode: 'content-length',
        contentLength: 100,
      },
      body: new StaticBodyReader([null]),
      finalUrl: 'https://cdn.example.com/file.bin',
    }))

    const client = new WebSeedHttpClient(transport)
    await expect(
      client.requestRange({
        url: 'https://cdn.example.com/file.bin',
        start: 100,
        endInclusive: 199,
      }),
    ).rejects.toThrow('unexpected range')
  })

  it('rejects a 200 response for non-zero ranges', async () => {
    const transport = new MockHttpTransport(async () => ({
      head: {
        statusCode: 200,
        statusMessage: 'OK',
        headers: {
          'content-length': '100',
        },
        bodyMode: 'content-length',
        contentLength: 100,
      },
      body: new StaticBodyReader([null]),
      finalUrl: 'https://cdn.example.com/file.bin',
    }))

    const client = new WebSeedHttpClient(transport)
    await expect(
      client.requestRange({
        url: 'https://cdn.example.com/file.bin',
        start: 10,
        endInclusive: 109,
      }),
    ).rejects.toThrow('ignored Range request')
  })

  it('accepts a 200 response for a zero-based exact-length request', async () => {
    const transport = new MockHttpTransport(async () => ({
      head: {
        statusCode: 200,
        statusMessage: 'OK',
        headers: {
          'content-length': '64',
        },
        bodyMode: 'content-length',
        contentLength: 64,
      },
      body: new StaticBodyReader([null]),
      finalUrl: 'https://cdn.example.com/file.bin',
    }))

    const client = new WebSeedHttpClient(transport)
    const response = await client.requestRange({
      url: 'https://cdn.example.com/file.bin',
      start: 0,
      endInclusive: 63,
    })

    expect(response.statusCode).toBe(200)
  })

  it('classifies 404 responses as not-found failures', async () => {
    const transport = new MockHttpTransport(async () => ({
      head: {
        statusCode: 404,
        statusMessage: 'Not Found',
        headers: {},
        bodyMode: 'none',
        contentLength: 0,
      },
      body: new StaticBodyReader([null]),
      finalUrl: 'https://cdn.example.com/file.bin',
    }))

    const client = new WebSeedHttpClient(transport)
    await expect(
      client.requestRange({
        url: 'https://cdn.example.com/file.bin',
        start: 0,
        endInclusive: 63,
      }),
    ).rejects.toMatchObject({
      name: 'WebSeedRequestError',
      kind: 'not-found',
      options: { statusCode: 404 },
    } satisfies Partial<WebSeedRequestError>)
  })

  it('parses Retry-After on transient HTTP failures', async () => {
    const transport = new MockHttpTransport(async () => ({
      head: {
        statusCode: 503,
        statusMessage: 'Service Unavailable',
        headers: {
          'retry-after': '7',
        },
        bodyMode: 'none',
        contentLength: 0,
      },
      body: new StaticBodyReader([null]),
      finalUrl: 'https://cdn.example.com/file.bin',
    }))

    const client = new WebSeedHttpClient(transport)
    await expect(
      client.requestRange({
        url: 'https://cdn.example.com/file.bin',
        start: 0,
        endInclusive: 63,
      }),
    ).rejects.toMatchObject({
      name: 'WebSeedRequestError',
      kind: 'transient',
      options: {
        statusCode: 503,
        retryAfterMs: 7000,
      },
    } satisfies Partial<WebSeedRequestError>)
  })

  it('follows redirects and returns the final URL', async () => {
    let requestCount = 0
    const transport = new MockHttpTransport(async () => {
      requestCount += 1
      if (requestCount === 1) {
        return {
          head: {
            statusCode: 302,
            statusMessage: 'Found',
            headers: {
              location: '/content/file.bin',
            },
            bodyMode: 'none',
            contentLength: 0,
          },
          body: new StaticBodyReader([null]),
          finalUrl: 'https://seed.example/redirect',
        }
      }

      return {
        head: {
          statusCode: 206,
          statusMessage: 'Partial Content',
          headers: {
            'content-range': 'bytes 0-63/64',
            'content-length': '64',
          },
          bodyMode: 'content-length',
          contentLength: 64,
        },
        body: new StaticBodyReader([null]),
        finalUrl: 'https://cdn.example.com/content/file.bin',
      }
    })

    const client = new WebSeedHttpClient(transport)
    const response = await client.requestRange({
      url: 'https://seed.example/redirect',
      start: 0,
      endInclusive: 63,
    })

    expect(transport.requests.map((request) => request.url)).toEqual([
      'https://seed.example/redirect',
      'https://seed.example/content/file.bin',
    ])
    expect(response.finalUrl).toBe('https://seed.example/content/file.bin')
  })

  it('rejects redirect loops', async () => {
    const transport = new MockHttpTransport(async () => ({
      head: {
        statusCode: 302,
        statusMessage: 'Found',
        headers: {
          location: 'https://seed.example/file.bin',
        },
        bodyMode: 'none',
        contentLength: 0,
      },
      body: new StaticBodyReader([null]),
      finalUrl: 'https://seed.example/file.bin',
    }))

    const client = new WebSeedHttpClient(transport)
    await expect(
      client.requestRange({
        url: 'https://seed.example/file.bin',
        start: 0,
        endInclusive: 63,
      }),
    ).rejects.toMatchObject({
      name: 'WebSeedRequestError',
      kind: 'redirect',
    } satisfies Partial<WebSeedRequestError>)
  })
})
