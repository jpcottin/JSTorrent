import { describe, it, expect } from 'vitest'
import { normalizeSearchPluginManifest, normalizeDeclaredHost } from '../src/validation/manifest'

describe('normalizeDeclaredHost', () => {
  it('normalizes to lowercase', () => {
    expect(normalizeDeclaredHost('Example.COM')).toBe('example.com')
  })

  it('strips trailing dot', () => {
    expect(normalizeDeclaredHost('example.com.')).toBe('example.com')
  })

  it('extracts hostname from URL', () => {
    expect(normalizeDeclaredHost('https://Example.com/path')).toBe('example.com')
  })

  it('rejects empty string', () => {
    expect(() => normalizeDeclaredHost('')).toThrow()
  })

  it('rejects wildcards', () => {
    expect(() => normalizeDeclaredHost('*.example.com')).toThrow()
  })
})

describe('normalizeSearchPluginManifest', () => {
  it('normalizes a valid manifest', () => {
    const result = normalizeSearchPluginManifest({
      name: 'Test Plugin',
      hosts: ['example.com'],
    })
    expect(result.name).toBe('Test Plugin')
    expect(result.hosts).toEqual(['example.com'])
  })

  it('deduplicates and sorts hosts', () => {
    const result = normalizeSearchPluginManifest({
      name: 'Test',
      hosts: ['b.com', 'a.com', 'b.com'],
    })
    expect(result.hosts).toEqual(['a.com', 'b.com'])
  })

  it('rejects empty name', () => {
    expect(() => normalizeSearchPluginManifest({ name: '', hosts: ['example.com'] })).toThrow(
      'non-empty `name`',
    )
  })

  it('rejects empty hosts', () => {
    expect(() => normalizeSearchPluginManifest({ name: 'Test', hosts: [] })).toThrow(
      'at least one declared host',
    )
  })

  it('preserves optional fields', () => {
    const result = normalizeSearchPluginManifest({
      id: 'com.test',
      name: 'Test',
      version: '1.0.0',
      description: 'A test plugin',
      homepage: 'https://test.com',
      hosts: ['test.com'],
      categories: ['all', 'movies'],
    })
    expect(result.id).toBe('com.test')
    expect(result.version).toBe('1.0.0')
    expect(result.categories).toEqual(['all', 'movies'])
  })

  it('applies sourceUrl when source not in manifest', () => {
    const result = normalizeSearchPluginManifest(
      { name: 'Test', hosts: ['test.com'] },
      'https://raw.github.com/plugin.js',
    )
    expect(result.source).toBe('https://raw.github.com/plugin.js')
  })
})
