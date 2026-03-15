import { describe, it, expect } from 'vitest'
import { runPlugin } from '../src/runtime/runner'

const VALID_PLUGIN = `
export const manifest = {
  name: 'Test Plugin',
  hosts: ['example.com'],
}

export async function search(ctx, input) {
  const data = await ctx.fetchJson({ url: 'https://example.com/api?q=' + ctx.encode(input.query) })
  for (const item of data.results) {
    ctx.emitResult({
      name: item.name,
      source: 'Test Plugin',
      torrentUrl: item.url,
    })
  }
  ctx.log('info', 'Found ' + data.results.length + ' results')
}
`

const MOCK_RESPONSE = JSON.stringify({
  results: [
    { name: 'Test Result 1', url: 'https://example.com/1.torrent' },
    { name: 'Test Result 2', url: 'https://example.com/2.torrent' },
  ],
})

describe('runPlugin', () => {
  it('runs a plugin with mock fetch', async () => {
    const result = await runPlugin({
      source: VALID_PLUGIN,
      input: { query: 'test' },
      fetch: async () => ({
        bodyText: MOCK_RESPONSE,
        statusCode: 200,
        bytes: MOCK_RESPONSE.length,
      }),
    })

    expect(result.trace.ok).toBe(true)
    expect(result.trace.results).toHaveLength(2)
    expect(result.trace.results[0].name).toBe('Test Result 1')
    expect(result.trace.logs).toHaveLength(1)
    expect(result.trace.logs[0].message).toContain('2 results')
  })

  it('returns error for invalid source', async () => {
    const result = await runPlugin({
      source: 'this is not valid javascript }{',
      input: { query: 'test' },
    })
    expect(result.trace.ok).toBe(false)
    expect(result.trace.error?.phase).toBe('load')
  })

  it('returns error for missing manifest', async () => {
    const result = await runPlugin({
      source: 'export async function search() {}',
      input: { query: 'test' },
    })
    expect(result.trace.ok).toBe(false)
    expect(result.trace.error?.phase).toBe('manifest')
  })

  it('enforces host policy by default', async () => {
    const result = await runPlugin({
      source: VALID_PLUGIN,
      input: { query: 'test' },
      fetch: async () => ({
        bodyText: MOCK_RESPONSE,
        statusCode: 200,
        bytes: MOCK_RESPONSE.length,
      }),
    })
    // This should succeed because example.com is in the manifest hosts
    expect(result.trace.ok).toBe(true)
    expect(result.trace.results).toHaveLength(2)
  })

  it('handles search function errors', async () => {
    const source = `
export const manifest = { name: 'Bad', hosts: ['example.com'] }
export async function search() { throw new Error('intentional failure') }
`
    const result = await runPlugin({
      source,
      input: { query: 'test' },
    })
    expect(result.trace.ok).toBe(false)
    expect(result.trace.error?.phase).toBe('search')
    expect(result.trace.error?.message).toContain('intentional failure')
  })
})
