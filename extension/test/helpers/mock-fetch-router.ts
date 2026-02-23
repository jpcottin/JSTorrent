import { vi } from 'vitest'

export interface MockFetchResponse {
  status?: number
  ok?: boolean
  jsonBody?: unknown
  textBody?: string
}

export interface MockFetchRoute {
  match: (url: string, init?: RequestInit) => boolean
  handle: (url: string, init?: RequestInit) => MockFetchResponse | Promise<MockFetchResponse>
}

function toResponseShape(input: MockFetchResponse): Response {
  const status = input.status ?? (input.ok === false ? 500 : 200)
  const ok = input.ok ?? (status >= 200 && status < 300)
  const textBody =
    input.textBody ?? (input.jsonBody === undefined ? '' : JSON.stringify(input.jsonBody))

  return {
    ok,
    status,
    json: async () => input.jsonBody,
    text: async () => textBody,
  } as Response
}

export function installMockFetchRouter(routes: MockFetchRoute[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

    for (const route of routes) {
      if (route.match(url, init)) {
        return toResponseShape(await route.handle(url, init))
      }
    }

    throw new Error(`No mock fetch route for ${url}`)
  })

  vi.stubGlobal('fetch', fetchMock as typeof fetch)
  return fetchMock
}
