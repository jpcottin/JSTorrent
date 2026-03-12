import { describe, expect, it } from 'vitest'
import { parseHttpUrl } from '../../src/http/url-utils'

describe('parseHttpUrl', () => {
  it('parses http URLs with default port', () => {
    expect(parseHttpUrl('http://example.com/abc?x=1')).toEqual({
      protocol: 'http:',
      hostname: 'example.com',
      port: 80,
      pathname: '/abc',
      search: '?x=1',
      path: '/abc?x=1',
      isHttps: false,
    })
  })

  it('parses https URLs with explicit port and preserves escapes', () => {
    expect(parseHttpUrl('https://cdn.example.com:8443/foo%20bar/baz?raw=%2Fdata')).toEqual({
      protocol: 'https:',
      hostname: 'cdn.example.com',
      port: 8443,
      pathname: '/foo%20bar/baz',
      search: '?raw=%2Fdata',
      path: '/foo%20bar/baz?raw=%2Fdata',
      isHttps: true,
    })
  })

  it('rejects invalid URLs', () => {
    expect(() => parseHttpUrl('ftp://example.com/file')).toThrow('Invalid URL')
    expect(() => parseHttpUrl('https://example.com:99999/file')).toThrow('Invalid URL port')
  })
})

