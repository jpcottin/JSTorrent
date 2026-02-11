import { config } from './config.js'

export interface LatestJson {
  version: string
  notes: string
  pub_date: string
  platforms: Record<string, { signature: string; url: string }>
}

export interface PlatformUpdate {
  version: string
  notes: string
  pub_date: string
  url: string
  signature: string
}

interface GitHubRelease {
  tag_name: string
  assets: Array<{ name: string; browser_download_url: string }>
}

export async function fetchLatestRelease(): Promise<LatestJson | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'jstorrent-update-server',
  }
  if (config.githubToken) {
    headers['Authorization'] = `Bearer ${config.githubToken}`
  }

  const res = await fetch(
    `https://api.github.com/repos/${config.githubRepo}/releases?per_page=10`,
    { headers },
  )
  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status}: ${res.statusText}`)
  }

  const releases = (await res.json()) as GitHubRelease[]
  const release = releases.find((r) => r.tag_name.startsWith(config.tagPrefix))
  if (!release) return null

  const asset = release.assets.find((a) => a.name === 'latest.json')
  if (!asset) return null

  const jsonRes = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': 'jstorrent-update-server' },
    redirect: 'follow',
  })
  if (!jsonRes.ok) {
    throw new Error(`Failed to fetch latest.json: ${jsonRes.status}`)
  }

  return (await jsonRes.json()) as LatestJson
}

export function findPlatformUpdate(
  latest: LatestJson,
  target: string,
  arch: string,
): PlatformUpdate | null {
  const key = `${target}-${arch}`
  const platform = latest.platforms[key]
  if (!platform) return null

  return {
    version: latest.version,
    notes: latest.notes,
    pub_date: latest.pub_date,
    url: platform.url,
    signature: platform.signature,
  }
}
