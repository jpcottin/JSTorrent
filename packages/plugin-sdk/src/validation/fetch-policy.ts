import type { SearchPluginFetchPolicy } from '../types.js'

export function ensurePluginFetchAllowed(url: string, policy?: SearchPluginFetchPolicy): void {
  const allowedHosts = policy?.allowedHosts
  if (!allowedHosts || allowedHosts.length === 0) {
    return
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Plugin fetch URL is invalid: ${url}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Plugin fetch protocol is not allowed: ${parsed.protocol}`)
  }

  const requestHost = parsed.hostname.toLowerCase().replace(/\.$/, '')
  const allowed = allowedHosts.some(
    (host) => requestHost === host || requestHost.endsWith(`.${host}`),
  )

  if (!allowed) {
    throw new Error(`Plugin fetch host is not declared in manifest: ${requestHost}`)
  }
}
