import type { SearchPluginFetchInput } from '../types.js'

export interface MockFetchRoute {
  url: string | RegExp
  method?: 'GET' | 'POST'
  response: {
    bodyText: string
    statusCode?: number
  }
}

export interface MockFetchInstance {
  handler: (input: SearchPluginFetchInput) => { bodyText: string; statusCode: number }
  calls: SearchPluginFetchInput[]
}

export function mockFetch(routes: MockFetchRoute[]): MockFetchInstance {
  const calls: SearchPluginFetchInput[] = []

  function handler(input: SearchPluginFetchInput): { bodyText: string; statusCode: number } {
    calls.push(input)

    const method = input.method ?? 'GET'
    const match = routes.find((route) => {
      if (route.method && route.method !== method) return false
      if (typeof route.url === 'string')
        return input.url === route.url || input.url.startsWith(route.url)
      return route.url.test(input.url)
    })

    if (!match) {
      return { bodyText: `No mock route matched: ${method} ${input.url}`, statusCode: 404 }
    }

    return {
      bodyText: match.response.bodyText,
      statusCode: match.response.statusCode ?? 200,
    }
  }

  return { handler, calls }
}
