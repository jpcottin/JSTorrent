import type { ParsedHttpUrl } from './http-types'

/**
 * Parse HTTP/HTTPS URLs without decoding percent-escaped sequences.
 * This is important for torrent paths, tracker query strings, and future
 * plugin HTTP where callers may need raw path preservation.
 */
export function parseHttpUrl(url: string): ParsedHttpUrl {
  const match = url.match(/^(https?):\/\/([^/:]+)(?::(\d+))?(\/[^?]*)?(\?.*)?$/)
  if (!match) {
    throw new Error(`Invalid URL: ${url}`)
  }

  const [, protocolPart, hostname, portStr, pathname = '/', search = ''] = match
  const protocol = `${protocolPart}:` as ParsedHttpUrl['protocol']
  const isHttps = protocol === 'https:'
  const port = portStr ? parseInt(portStr, 10) : isHttps ? 443 : 80

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid URL port: ${url}`)
  }

  return {
    protocol,
    hostname,
    port,
    pathname,
    search,
    path: pathname + search,
    isHttps,
  }
}

