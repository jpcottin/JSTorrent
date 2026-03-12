import type { InstalledPluginRecord, SearchPluginFetchPolicy, SearchPluginManifest } from './types'

export const SEARCH_PLUGIN_STORAGE_PREFIX = 'searchPlugin:'

function trimOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
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

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

export async function createInstalledPluginRecord(input: {
  code: string
  manifest: SearchPluginManifest
  sourceUrl?: string
}): Promise<InstalledPluginRecord> {
  const manifest = normalizeSearchPluginManifest(input.manifest, input.sourceUrl)
  const sourceHash = await sha256Hex(input.code)
  const pluginId = manifest.id ?? `${slugify(manifest.name) || 'plugin'}-${sourceHash.slice(0, 8)}`
  const now = Date.now()

  return {
    pluginId,
    manifest,
    sourceUrl: input.sourceUrl,
    sourceHash,
    installedAt: now,
    updatedAt: now,
    enabled: true,
    code: input.code,
  }
}
