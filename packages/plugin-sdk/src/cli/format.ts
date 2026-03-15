import type { SearchPluginManifest, SearchPluginRunTrace, SearchResult } from '../types.js'

export function formatManifest(manifest: SearchPluginManifest): string {
  const lines: string[] = []
  lines.push(`Name:        ${manifest.name}`)
  if (manifest.id) lines.push(`ID:          ${manifest.id}`)
  if (manifest.version) lines.push(`Version:     ${manifest.version}`)
  if (manifest.description) lines.push(`Description: ${manifest.description}`)
  if (manifest.homepage) lines.push(`Homepage:    ${manifest.homepage}`)
  lines.push(`Hosts:       ${manifest.hosts.join(', ')}`)
  if (manifest.categories) lines.push(`Categories:  ${manifest.categories.join(', ')}`)
  return lines.join('\n')
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '\u2026' : str
}

export function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No results.'

  const lines: string[] = []
  for (const r of results) {
    const parts = [truncate(r.name, 60)]
    if (r.size !== undefined) parts.push(`size=${formatSize(r.size)}`)
    if (r.seeds !== undefined) parts.push(`seeds=${r.seeds}`)
    if (r.leeches !== undefined) parts.push(`leeches=${r.leeches}`)
    if (r.torrentUrl) parts.push(`torrent=${truncate(r.torrentUrl, 60)}`)
    else if (r.magnetUrl) parts.push(`magnet=${truncate(r.magnetUrl, 60)}`)
    else if (r.infoHash) parts.push(`hash=${r.infoHash}`)
    lines.push(`  ${parts.join(' | ')}`)
  }
  return lines.join('\n')
}

export function formatTrace(trace: SearchPluginRunTrace): string {
  const lines: string[] = []
  lines.push(`Status:   ${trace.ok ? 'OK' : 'FAILED'}`)
  lines.push(`Duration: ${trace.durationMs}ms`)
  lines.push(`Results:  ${trace.results.length}`)
  lines.push(`Requests: ${trace.requests.length}`)

  for (const req of trace.requests) {
    lines.push(
      `  ${req.status ?? '?'} ${req.method} ${req.url} (${req.bytes ?? 0} bytes, ${req.durationMs ?? 0}ms)`,
    )
  }

  if (trace.logs.length > 0) {
    lines.push('Logs:')
    for (const log of trace.logs) {
      lines.push(`  [${log.level}] ${log.message}`)
    }
  }

  if (trace.error) {
    lines.push(`Error [${trace.error.phase}]: ${trace.error.message}`)
  }

  return lines.join('\n')
}
