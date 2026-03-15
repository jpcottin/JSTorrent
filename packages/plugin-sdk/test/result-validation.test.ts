import { describe, it, expect } from 'vitest'
import { validateSearchResult } from '../src/validation/result'

describe('validateSearchResult', () => {
  it('passes for valid result with torrentUrl', () => {
    const errors = validateSearchResult({
      name: 'Test',
      source: 'Test Source',
      torrentUrl: 'https://example.com/file.torrent',
    })
    expect(errors).toEqual([])
  })

  it('passes for valid result with magnetUrl', () => {
    const errors = validateSearchResult({
      name: 'Test',
      source: 'Test Source',
      magnetUrl: 'magnet:?xt=urn:btih:abc123',
    })
    expect(errors).toEqual([])
  })

  it('passes for valid result with infoHash', () => {
    const errors = validateSearchResult({
      name: 'Test',
      source: 'Test Source',
      infoHash: 'abc123def456',
    })
    expect(errors).toEqual([])
  })

  it('fails for missing name', () => {
    const errors = validateSearchResult({
      name: '',
      source: 'Test',
      torrentUrl: 'https://example.com/file.torrent',
    })
    expect(errors).toContainEqual(expect.stringContaining('name'))
  })

  it('fails for missing source', () => {
    const errors = validateSearchResult({
      name: 'Test',
      source: '',
      torrentUrl: 'https://example.com/file.torrent',
    })
    expect(errors).toContainEqual(expect.stringContaining('source'))
  })

  it('fails when no download method provided', () => {
    const errors = validateSearchResult({
      name: 'Test',
      source: 'Test',
    })
    expect(errors).toContainEqual(expect.stringContaining('magnetUrl'))
  })

  it('reports negative size', () => {
    const errors = validateSearchResult({
      name: 'Test',
      source: 'Test',
      torrentUrl: 'https://example.com/file.torrent',
      size: -1,
    })
    expect(errors).toContainEqual(expect.stringContaining('size'))
  })
})
