import type { SearchPluginManifest } from '../types.js'

function trimOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function normalizeDeclaredHost(host: string): string {
  const trimmed = host.trim().toLowerCase()
  if (!trimmed) {
    throw new Error('Plugin manifest hosts must not be empty')
  }

  let hostname = trimmed
  if (hostname.includes('://')) {
    hostname = new URL(hostname).hostname.toLowerCase()
  }

  hostname = hostname.replace(/\.$/, '')

  if (!hostname || hostname.includes('/') || hostname.includes('*') || /\s/.test(hostname)) {
    throw new Error(`Invalid declared host: ${host}`)
  }

  return hostname
}

export function normalizeSearchPluginManifest(
  manifest: SearchPluginManifest,
  sourceUrl?: string,
): SearchPluginManifest {
  const name = trimOptionalString(manifest.name)
  if (!name) {
    throw new Error('Plugin manifest must include a non-empty `name`')
  }

  if (!Array.isArray(manifest.hosts) || manifest.hosts.length === 0) {
    throw new Error('Plugin manifest must include at least one declared host')
  }

  const normalizedHosts = Array.from(new Set(manifest.hosts.map(normalizeDeclaredHost))).sort()
  const categories = Array.isArray(manifest.categories)
    ? manifest.categories
        .map((entry) => trimOptionalString(entry))
        .filter((entry): entry is string => Boolean(entry))
    : undefined

  return {
    id: trimOptionalString(manifest.id),
    name,
    version: trimOptionalString(manifest.version),
    description: trimOptionalString(manifest.description),
    homepage: trimOptionalString(manifest.homepage),
    source: trimOptionalString(manifest.source) ?? sourceUrl,
    hosts: normalizedHosts,
    categories: categories && categories.length > 0 ? Array.from(new Set(categories)) : undefined,
  }
}
