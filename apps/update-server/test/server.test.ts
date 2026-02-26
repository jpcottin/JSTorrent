import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import * as http from 'node:http'
import type { FetchResult } from '../src/github.js'

const MOCK_FETCH_RESULT: FetchResult = {
  latest: {
    version: '0.1.21',
    notes: '- Remember window position across restarts',
    pub_date: '2026-02-11T07:33:31.665Z',
    platforms: {
      'darwin-aarch64': {
        signature: 'sig-darwin-aarch64',
        url: 'https://github.com/kzahel/JSTorrent/releases/download/tauri-app-v0.1.21/JSTorrent_aarch64.app.tar.gz',
      },
      'windows-x86_64': {
        signature: 'sig-windows-x86_64',
        url: 'https://github.com/kzahel/JSTorrent/releases/download/tauri-app-v0.1.21/JSTorrent_0.1.21_x64_en-US.msi',
      },
      'linux-x86_64': {
        signature: 'sig-linux-x86_64',
        url: 'https://github.com/kzahel/JSTorrent/releases/download/tauri-app-v0.1.21/JSTorrent_0.1.21_amd64.AppImage',
      },
    },
  },
  freshNotes: [
    { version: '0.1.21', notes: '- Remember window position across restarts' },
    {
      version: '0.1.20',
      notes: '- Add magnet/torrent routing\n- Launch desktop app from extension',
    },
    { version: '0.1.19', notes: '- Add profile picker UI' },
    { version: '0.1.18', notes: '- Add profile system' },
  ],
}

// Mock the github module before importing server
vi.mock('../src/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/github.js')>()
  return {
    ...actual,
    fetchReleases: vi.fn().mockResolvedValue(MOCK_FETCH_RESULT),
  }
})

const testDir = '/tmp/jstorrent-update-server-test-' + Date.now()

// Mock config to use random port and temp log dir
vi.mock('../src/config.js', () => ({
  config: {
    port: 0,
    githubRepo: 'kzahel/JSTorrent',
    tagPrefix: 'tauri-app-v',
    cacheTtlMs: 60_000,
    logDir: testDir,
    latestCacheFile: testDir + '/latest-cache.json',
    notesCacheFile: testDir + '/notes-cache.json',
    githubToken: '',
  },
}))

let server: http.Server
let baseUrl: string

beforeAll(async () => {
  const mod = await import('../src/server.js')
  server = mod.server
  await new Promise<void>((resolve) => {
    // Server may already be listening from import; get the port
    const addr = server.address()
    if (addr && typeof addr === 'object') {
      baseUrl = `http://localhost:${addr.port}`
      resolve()
    } else {
      server.once('listening', () => {
        const a = server.address()
        if (a && typeof a === 'object') {
          baseUrl = `http://localhost:${a.port}`
        }
        resolve()
      })
    }
  })
})

afterAll(async () => {
  const mod = await import('../src/server.js')
  mod.analytics.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(async () => {
  const mod = await import('../src/server.js')
  mod.cache.invalidate()
})

describe('GET /health', () => {
  it('returns 200 with ok: true', async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('GET /tauri/:target/:arch/:version', () => {
  it('returns 200 with update when newer version available', async () => {
    const res = await fetch(`${baseUrl}/tauri/darwin/aarch64/0.1.20`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.version).toBe('0.1.21')
    expect(body.url).toContain('aarch64.app.tar.gz')
    expect(body.signature).toBe('sig-darwin-aarch64')
    expect(body.notes).toBeTruthy()
    expect(body.pub_date).toBeTruthy()
  })

  it('returns 204 when already on latest', async () => {
    const res = await fetch(`${baseUrl}/tauri/darwin/aarch64/0.1.21`)
    expect(res.status).toBe(204)
  })

  it('returns 204 when client is ahead', async () => {
    const res = await fetch(`${baseUrl}/tauri/darwin/aarch64/0.2.0`)
    expect(res.status).toBe(204)
  })

  it('returns 204 for unknown platform', async () => {
    const res = await fetch(`${baseUrl}/tauri/freebsd/aarch64/0.1.0`)
    expect(res.status).toBe(204)
  })

  it('returns update for windows', async () => {
    const res = await fetch(`${baseUrl}/tauri/windows/x86_64/0.1.20`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.url).toContain('x64_en-US.msi')
  })

  it('returns update for linux', async () => {
    const res = await fetch(`${baseUrl}/tauri/linux/x86_64/0.1.20`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.url).toContain('amd64.AppImage')
  })

  it('returns only latest notes when upgrading from previous version', async () => {
    const res = await fetch(`${baseUrl}/tauri/darwin/aarch64/0.1.20`)
    expect(res.status).toBe(200)
    const body = await res.json()
    // Only one version newer — should return notes without version header
    expect(body.notes).toBe('- Remember window position across restarts')
  })

  it('returns aggregated notes when skipping multiple versions', async () => {
    const res = await fetch(`${baseUrl}/tauri/darwin/aarch64/0.1.18`)
    expect(res.status).toBe(200)
    const body = await res.json()
    // Should include notes for 0.1.21, 0.1.20, 0.1.19 (all > 0.1.18)
    expect(body.notes).toContain('## 0.1.21')
    expect(body.notes).toContain('## 0.1.20')
    expect(body.notes).toContain('## 0.1.19')
    expect(body.notes).not.toContain('## 0.1.18')
  })

  it('returns all notes when upgrading from very old version', async () => {
    const res = await fetch(`${baseUrl}/tauri/darwin/aarch64/0.1.0`)
    expect(res.status).toBe(200)
    const body = await res.json()
    // Should include all 4 versions
    expect(body.notes).toContain('## 0.1.21')
    expect(body.notes).toContain('## 0.1.18')
  })
})

describe('other routes', () => {
  it('returns 404 for unknown paths', async () => {
    const res = await fetch(`${baseUrl}/unknown`)
    expect(res.status).toBe(404)
  })

  it('returns 405 for POST', async () => {
    const res = await fetch(`${baseUrl}/health`, { method: 'POST' })
    expect(res.status).toBe(405)
  })

  it('returns 404 for incomplete tauri path', async () => {
    const res = await fetch(`${baseUrl}/tauri/darwin/aarch64`)
    expect(res.status).toBe(404)
  })

  it('strips query strings from version in update check', async () => {
    // With query string, version 0.1.21 should still be recognized as current
    const res = await fetch(`${baseUrl}/tauri/darwin/aarch64/0.1.21?foo=bar`)
    expect(res.status).toBe(204)
  })

  it('strips query strings and still detects updates', async () => {
    const res = await fetch(`${baseUrl}/tauri/darwin/aarch64/0.1.20?t=123`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.version).toBe('0.1.21')
  })
})
