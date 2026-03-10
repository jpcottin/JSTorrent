import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, describe, expect } from 'vitest'
import { conformanceCase } from '../../test/helpers/conformance'
import { startDaemon, type DaemonHarness } from './helpers/daemon-harness'

describe('Rust daemon HTTP contract conformance', () => {
  let harness: DaemonHarness | null = null

  afterEach(async () => {
    await harness?.cleanup()
    harness = null
  })

  async function makeJsonRequest(
    requestPath: string,
    body: unknown,
    options: {
      method?: string
      authToken?: string
      extensionId?: string
      installId?: string
    } = {},
  ): Promise<Response> {
    if (!harness) {
      throw new Error('Harness not started')
    }

    return await fetch(`http://127.0.0.1:${harness.port}${requestPath}`, {
      method: options.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: `chrome-extension://${options.extensionId ?? 'test-extension'}`,
        'X-JST-Auth': options.authToken ?? harness.token,
        'X-JST-ExtensionId': options.extensionId ?? 'test-extension',
        'X-JST-InstallId': options.installId ?? harness.installId,
      },
      body: JSON.stringify(body),
    })
  }

  conformanceCase(
    'rust',
    'ops.delete.missing_returns_404',
    'returns 404 for a missing /ops/delete target',
    async () => {
      harness = await startDaemon()

      const response = await makeJsonRequest('/ops/delete', {
        root_key: 'default',
        path: 'missing-file.bin',
      })

      expect(response.status).toBe(404)
      await expect(response.text()).resolves.toContain('No such file')
    },
  )

  conformanceCase(
    'rust',
    'ops.batch_delete.ignores_missing_entries',
    'ignores missing entries during /ops/batch_delete and only reports real failures',
    async () => {
      harness = await startDaemon()
      await fs.mkdir(path.join(harness.dataDir, 'nested'), { recursive: true })
      await fs.writeFile(path.join(harness.dataDir, 'nested', 'present.txt'), 'hello')

      const response = await makeJsonRequest('/ops/batch_delete', {
        root_key: 'default',
        directory: 'nested',
        entries: ['present.txt', 'missing.txt', '../escape.txt'],
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual(['../escape.txt'])
      await expect(fs.access(path.join(harness.dataDir, 'nested', 'present.txt'))).rejects.toThrow()
    },
  )
})
