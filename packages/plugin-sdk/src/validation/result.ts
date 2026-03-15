import type { SearchResult } from '../types.js'

export function validateSearchResult(result: SearchResult): string[] {
  const errors: string[] = []

  if (typeof result.name !== 'string' || result.name.trim().length === 0) {
    errors.push('Result must have a non-empty `name`')
  }

  if (typeof result.source !== 'string' || result.source.trim().length === 0) {
    errors.push('Result must have a non-empty `source`')
  }

  const hasMagnet = typeof result.magnetUrl === 'string' && result.magnetUrl.length > 0
  const hasTorrent = typeof result.torrentUrl === 'string' && result.torrentUrl.length > 0
  const hasInfoHash = typeof result.infoHash === 'string' && result.infoHash.length > 0

  if (!hasMagnet && !hasTorrent && !hasInfoHash) {
    errors.push('Result must have at least one of `magnetUrl`, `torrentUrl`, or `infoHash`')
  }

  if (result.size !== undefined && (typeof result.size !== 'number' || result.size < 0)) {
    errors.push('Result `size` must be a non-negative number')
  }

  if (result.seeds !== undefined && (typeof result.seeds !== 'number' || result.seeds < 0)) {
    errors.push('Result `seeds` must be a non-negative number')
  }

  if (result.leeches !== undefined && (typeof result.leeches !== 'number' || result.leeches < 0)) {
    errors.push('Result `leeches` must be a non-negative number')
  }

  return errors
}
