/**
 * Playwright fixtures for testing the extension against the Android companion server.
 *
 * Spoofs the platform to ChromeOS and redirects companion traffic to localhost
 * (where the emulator's companion server is accessible via adb forward).
 *
 * Prerequisites:
 *   - Android emulator running with companion mode active
 *   - adb forward for ports 7800, 7801, 7802
 *   - adb reverse tcp:6881 tcp:6881 (for seeder access from emulator)
 *   - Seeder running: pnpm seed-for-test
 */

/* eslint-disable react-hooks/rules-of-hooks */
import { test as base, chromium, type BrowserContext } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const EXTENSION_PATH = path.resolve(__dirname, '../dist')

// ChromeOS user agent — just needs "CrOS" to trigger platform detection
const CHROMEOS_USER_AGENT =
  'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

const COMPANION_HOST = process.env.COMPANION_HOST || '127.0.0.1'
const COMPANION_PORT = parseInt(process.env.COMPANION_PORT || '7800', 10)

export const test = base.extend<{
  context: BrowserContext
  extensionId: string
}>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jstorrent-companion-e2e-'))

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--headless=new',
        '--no-sandbox',
        `--user-agent=${CHROMEOS_USER_AGENT}`,
      ],
    })

    await use(context)
    await context.close()
  },

  extensionId: async ({ context }, use) => {
    let extensionId = ''

    // Wait for service worker to find the extension ID
    let worker = context.serviceWorkers()[0]
    if (!worker) {
      try {
        worker = await context.waitForEvent('serviceworker', { timeout: 10000 })
      } catch {
        throw new Error('Extension service worker did not start')
      }
    }

    const match = worker.url().match(/chrome-extension:\/\/([^/]+)\//)
    if (match) {
      extensionId = match[1]
    } else {
      throw new Error('Could not detect extension ID from service worker URL')
    }

    // Pre-seed chrome.storage.local with companion config BEFORE opening UI page.
    // The bootstrap only starts when the UI port connects, so we have time.
    const testToken = `e2e-companion-${Date.now()}`
    const testInstallId = `e2e-install-${Date.now()}`

    await worker.evaluate(
      async ({ token, installId, host, port }) => {
        await chrome.storage.local.set({
          'debug:companionHost': host,
          'android:authToken': token,
          'android:daemonPort': port,
          telemetryId: installId,
        })
      },
      {
        token: testToken,
        installId: testInstallId,
        host: COMPANION_HOST,
        port: COMPANION_PORT,
      },
    )

    // Pre-seed Android TokenStore with matching credentials via adb broadcast
    try {
      execSync(
        `adb shell am broadcast -a com.jstorrent.DEBUG ` +
          `--es cmd pair ` +
          `--es token "${testToken}" ` +
          `--es extension_id "${extensionId}" ` +
          `--es install_id "${testInstallId}" ` +
          `-p com.jstorrent.app`,
        { stdio: 'pipe', timeout: 10000 },
      )
    } catch (e) {
      throw new Error(
        `Failed to pre-seed pairing via adb. Is the emulator running?\n${e instanceof Error ? e.message : e}`,
      )
    }

    await use(extensionId)
  },
})

export { expect } from '@playwright/test'
