/**
 * E2E test: Extension + Android Companion download via emulator.
 *
 * Tests the full ChromeOS extension path: platform detection → ChromeOS bootstrap →
 * companion discovery → pairing → WebSocket auth → engine init → torrent download.
 *
 * Prerequisites (handled by scripts/e2e-companion-smoke.sh):
 *   - Android emulator running with app in companion mode
 *   - adb forward tcp:7800-7802 tcp:7800-7802
 *   - adb reverse tcp:6881 tcp:6881
 *   - Seeder running: pnpm seed-for-test
 *
 * Usage:
 *   pnpm --filter extension exec playwright test e2e/companion-download.spec.ts
 *   FULL_DOWNLOAD=1 pnpm --filter extension exec playwright test e2e/companion-download.spec.ts
 */

import { test, expect } from './companion-fixtures'
import * as net from 'net'

// Known test values from seed_for_test.py (100MB size)
const TEST_INFO_HASH = '67d01ece1b99c49c257baada0f760b770a7530b9'
// Peer hint uses 127.0.0.1 because adb reverse maps emulator localhost → host localhost
const TEST_MAGNET = `magnet:?xt=urn:btih:${TEST_INFO_HASH}&dn=testdata_100mb.bin&x.pe=127.0.0.1:6881`
const SEEDER_PORT = 6881
const COMPANION_PORT = parseInt(process.env.COMPANION_PORT || '7800', 10)

const FULL_DOWNLOAD = process.env.FULL_DOWNLOAD === '1'
const DOWNLOAD_TIMEOUT_MS = (() => {
  const override = parseInt(process.env.DOWNLOAD_TIMEOUT_MS || '', 10)
  if (Number.isFinite(override) && override > 0) {
    return override
  }
  return FULL_DOWNLOAD ? 1_800_000 : 480_000
})()

test.describe('Companion Download E2E', () => {
  test.beforeAll(async () => {
    // Verify companion server is reachable
    const companionHost = process.env.COMPANION_HOST || '127.0.0.1'
    try {
      const response = await fetch(`http://${companionHost}:${COMPANION_PORT}/health`, {
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) {
        throw new Error(`Companion /health returned ${response.status}`)
      }
    } catch (e) {
      throw new Error(
        `Companion server not reachable at ${companionHost}:${COMPANION_PORT}. ` +
          `Start emulator and companion mode first.\n` +
          `  emu start && emu install\n` +
          `  adb shell am start -n com.jstorrent.app/.MainActivity -e force_companion true\n` +
          `Error: ${e instanceof Error ? e.message : e}`,
      )
    }

    // Verify seeder is running
    const seederRunning = await new Promise<boolean>((resolve) => {
      const client = new net.Socket()
      client.setTimeout(2000)
      client.connect(SEEDER_PORT, '127.0.0.1', () => {
        client.destroy()
        resolve(true)
      })
      client.on('error', () => {
        client.destroy()
        resolve(false)
      })
      client.on('timeout', () => {
        client.destroy()
        resolve(false)
      })
    })
    if (!seederRunning) {
      throw new Error(
        `Seeder not running on port ${SEEDER_PORT}. Start it with: pnpm seed-for-test`,
      )
    }
    console.log(`Companion: ${companionHost}:${COMPANION_PORT}, Seeder: localhost:${SEEDER_PORT}`)
  })

  test('downloads torrent via Android companion', async ({ context, extensionId }) => {
    test.setTimeout(DOWNLOAD_TIMEOUT_MS + 60_000)

    // Wait for service worker
    if (!context.serviceWorkers()[0]) {
      await context.waitForEvent('serviceworker', { timeout: 10000 })
    }

    // Open extension UI page — this triggers ChromeOS bootstrap
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/src/ui/app.html`)

    // Wait for engine to initialize via companion
    // The bootstrap needs to: probe /health → check /status → connect WebSocket → init engine
    const engineReady = await page.evaluate(
      async ({ timeoutMs }) => {
        type EngineManager = {
          engine: {
            port: number
            storageRootManager: {
              getRoots: () => { key: string }[]
              setDefaultRoot: (key: string) => void
            }
          } | null
          daemonConnection: unknown | null
        }

        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const em = (window as unknown as { engineManager?: EngineManager }).engineManager
          if (em?.engine && em.daemonConnection) {
            const roots = em.engine.storageRootManager.getRoots()
            return {
              ready: true,
              enginePort: em.engine.port,
              rootCount: roots.length,
              roots: roots.map((r) => r.key),
            }
          }
          await new Promise((r) => setTimeout(r, 500))
        }
        return { ready: false, enginePort: 0, rootCount: 0, roots: [] as string[] }
      },
      { timeoutMs: 30000 },
    )

    console.log('Engine init result:', engineReady)
    expect(engineReady.ready).toBe(true)
    expect(engineReady.rootCount).toBeGreaterThan(0)

    // Set the first available root as default (companion provides storage roots)
    await page.evaluate(
      ({ rootKey }) => {
        type EngineManager = {
          engine: {
            storageRootManager: {
              setDefaultRoot: (key: string) => void
            }
          } | null
        }
        const em = (window as unknown as { engineManager: EngineManager }).engineManager
        em.engine!.storageRootManager.setDefaultRoot(rootKey)
      },
      { rootKey: engineReady.roots[0] },
    )

    // Add torrent and wait for download
    const result = await page.evaluate(
      async ({ magnet, timeoutMs }) => {
        type Torrent = {
          progress: number
          isComplete: boolean
          peers: unknown[]
          downloadSpeed: number
          hasMetadata: boolean
          userState: string
          name: string
          infoHash: string
          errorMessage?: string
        }
        type EngineManager = {
          engine: {
            addTorrent: (magnetOrBuffer: string) => Promise<{ torrent: Torrent | null }>
            removeTorrent: (infoHash: string, deleteFiles: boolean) => void
          } | null
        }

        const em = (window as unknown as { engineManager: EngineManager }).engineManager
        if (!em.engine) {
          return { success: false, error: 'Engine not available' }
        }

        const { torrent } = await em.engine.addTorrent(magnet)
        if (!torrent) {
          return { success: false, error: 'Failed to add torrent' }
        }

        console.log(
          `Torrent added: name=${torrent.name}, hasMetadata=${torrent.hasMetadata}, ` +
            `userState=${torrent.userState}, error=${torrent.errorMessage}`,
        )

        // Poll for completion
        const deadline = Date.now() + timeoutMs
        let lastProgress = -1

        while (Date.now() < deadline) {
          const progress = torrent.progress
          const isComplete = torrent.isComplete

          const shouldLog =
            Math.floor(progress * 20) !== Math.floor(lastProgress * 20) || lastProgress === -1
          if (shouldLog) {
            console.log(
              `Download: ${(progress * 100).toFixed(1)}% | ` +
                `peers: ${torrent.peers.length} | ` +
                `speed: ${(torrent.downloadSpeed / 1024).toFixed(0)} KB/s | ` +
                `meta: ${torrent.hasMetadata} | ` +
                `state: ${torrent.userState}`,
            )
            lastProgress = progress
          }

          if (isComplete) {
            // Clean up
            em.engine!.removeTorrent(torrent.infoHash, true)
            return { success: true, progress, isComplete: true }
          }

          await new Promise((r) => setTimeout(r, 500))
        }

        // Timeout
        const finalState = {
          success: false,
          error: 'Download timeout',
          progress: torrent.progress,
          isComplete: torrent.isComplete,
          peerCount: torrent.peers.length,
          hasMetadata: torrent.hasMetadata,
          userState: torrent.userState,
          torrentError: torrent.errorMessage,
        }

        // Clean up even on failure
        em.engine!.removeTorrent(torrent.infoHash, true)
        return finalState
      },
      { magnet: TEST_MAGNET, timeoutMs: DOWNLOAD_TIMEOUT_MS },
    )

    console.log('Download result:', result)

    expect(result.success).toBe(true)
    expect(result.isComplete).toBe(true)
    expect(result.progress).toBeGreaterThanOrEqual(1.0)
  })
})
