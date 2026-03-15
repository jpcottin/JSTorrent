import { describe, it, expect } from 'vitest'
import { ensurePluginFetchAllowed } from '../src/validation/fetch-policy'

describe('ensurePluginFetchAllowed', () => {
  it('allows exact host match', () => {
    expect(() =>
      ensurePluginFetchAllowed('https://example.com/path', {
        allowedHosts: ['example.com'],
      }),
    ).not.toThrow()
  })

  it('allows subdomain match', () => {
    expect(() =>
      ensurePluginFetchAllowed('https://api.example.com/path', {
        allowedHosts: ['example.com'],
      }),
    ).not.toThrow()
  })

  it('rejects undeclared host', () => {
    expect(() =>
      ensurePluginFetchAllowed('https://evil.com/path', {
        allowedHosts: ['example.com'],
      }),
    ).toThrow('not declared in manifest')
  })

  it('rejects non-HTTP protocol', () => {
    expect(() =>
      ensurePluginFetchAllowed('ftp://example.com/file', {
        allowedHosts: ['example.com'],
      }),
    ).toThrow('protocol is not allowed')
  })

  it('allows when no policy set', () => {
    expect(() => ensurePluginFetchAllowed('https://anything.com/')).not.toThrow()
  })

  it('rejects invalid URL', () => {
    expect(() => ensurePluginFetchAllowed('not-a-url', { allowedHosts: ['example.com'] })).toThrow(
      'invalid',
    )
  })
})
