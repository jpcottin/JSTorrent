import { describe, it, expect, vi } from 'vitest'
import { Cache } from '../src/cache.js'

describe('Cache', () => {
  it('returns fetched data', async () => {
    const cache = new Cache(() => Promise.resolve('data'), 1000)
    expect(await cache.get()).toBe('data')
  })

  it('returns cached data within TTL', async () => {
    let calls = 0
    const cache = new Cache(() => {
      calls++
      return Promise.resolve(`data-${calls}`)
    }, 1000)

    expect(await cache.get()).toBe('data-1')
    expect(await cache.get()).toBe('data-1')
    expect(calls).toBe(1)
  })

  it('re-fetches after TTL expires', async () => {
    let calls = 0
    const cache = new Cache(() => {
      calls++
      return Promise.resolve(`data-${calls}`)
    }, 50)

    expect(await cache.get()).toBe('data-1')
    await new Promise((r) => setTimeout(r, 60))
    expect(await cache.get()).toBe('data-2')
    expect(calls).toBe(2)
  })

  it('deduplicates concurrent requests', async () => {
    let calls = 0
    const cache = new Cache(async () => {
      calls++
      await new Promise((r) => setTimeout(r, 50))
      return `data-${calls}`
    }, 1000)

    const [a, b, c] = await Promise.all([cache.get(), cache.get(), cache.get()])
    expect(a).toBe('data-1')
    expect(b).toBe('data-1')
    expect(c).toBe('data-1')
    expect(calls).toBe(1)
  })

  it('returns stale data on fetch error', async () => {
    let calls = 0
    const cache = new Cache(async () => {
      calls++
      if (calls === 2) throw new Error('fail')
      return `data-${calls}`
    }, 50)

    // Suppress expected error log
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await cache.get()).toBe('data-1')
    await new Promise((r) => setTimeout(r, 60))
    expect(await cache.get()).toBe('data-1') // stale
    expect(calls).toBe(2)

    vi.restoreAllMocks()
  })

  it('returns null when first fetch fails', async () => {
    const cache = new Cache(async () => {
      throw new Error('fail')
    }, 1000)

    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await cache.get()).toBeNull()
    vi.restoreAllMocks()
  })

  it('re-fetches after invalidate', async () => {
    let calls = 0
    const cache = new Cache(() => {
      calls++
      return Promise.resolve(`data-${calls}`)
    }, 60_000)

    expect(await cache.get()).toBe('data-1')
    cache.invalidate()
    expect(await cache.get()).toBe('data-2')
  })
})
