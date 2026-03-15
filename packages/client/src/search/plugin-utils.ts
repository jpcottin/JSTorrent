import {
  normalizeSearchPluginManifest,
  normalizeDeclaredHost,
  ensurePluginFetchAllowed,
} from '@jstorrent/plugin-sdk'
import type { InstalledPluginRecord, SearchPluginManifest } from './types'

export { normalizeSearchPluginManifest, normalizeDeclaredHost, ensurePluginFetchAllowed }

export const SEARCH_PLUGIN_STORAGE_PREFIX = 'searchPlugin:'

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
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
