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

  async function makeAuthenticatedRequest(
    requestPath: string,
    options: {
      method?: string
      authToken?: string
      extensionId?: string
      installId?: string
      headers?: Record<string, string>
      body?: string
    } = {},
  ): Promise<Response> {
    if (!harness) {
      throw new Error('Harness not started')
    }

    return await fetch(`http://127.0.0.1:${harness.port}${requestPath}`, {
      method: options.method ?? 'GET',
      headers: {
        Origin: `chrome-extension://${options.extensionId ?? 'test-extension'}`,
        'X-JST-Auth': options.authToken ?? harness.token,
        'X-JST-ExtensionId': options.extensionId ?? 'test-extension',
        'X-JST-InstallId': options.installId ?? harness.installId,
        ...options.headers,
      },
      body: options.body,
    })
  }

  async function connectAuthenticatedControlWebSocket(): Promise<WebSocket> {
    if (!harness) {
      throw new Error('Harness not started')
    }

    return await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${harness!.port}/control`)
      ws.binaryType = 'arraybuffer'
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('Timed out connecting control websocket'))
      }, 2000)

      ws.onopen = () => {
        ws.send(buildProtocolFrame(0x01, 1))
      }

      ws.onmessage = (event) => {
        const frame = new Uint8Array(event.data as ArrayBuffer)
        const opcode = frame[1]

        if (opcode === 0x02) {
          const tokenBytes = new TextEncoder().encode(harness!.token)
          const extensionIdBytes = new TextEncoder().encode('test-extension')
          const installIdBytes = new TextEncoder().encode(harness!.installId)
          const payload = new Uint8Array(
            1 + tokenBytes.length + 1 + extensionIdBytes.length + 1 + installIdBytes.length,
          )
          let offset = 0
          payload[offset++] = 0
          payload.set(tokenBytes, offset)
          offset += tokenBytes.length
          payload[offset++] = 0
          payload.set(extensionIdBytes, offset)
          offset += extensionIdBytes.length
          payload[offset++] = 0
          payload.set(installIdBytes, offset)
          ws.send(buildProtocolFrame(0x03, 2, payload))
          return
        }

        if (opcode === 0x04) {
          clearTimeout(timeout)
          if (frame[8] === 0) {
            resolve(ws)
          } else {
            reject(new Error('Control auth failed'))
          }
        }
      }

      ws.onerror = () => {
        clearTimeout(timeout)
        reject(new Error('Control websocket error'))
      }
    })
  }

  async function sendControlJsonRequest<TPayload extends unknown>(
    ws: WebSocket,
    opcode: number,
    requestId: number,
    payload: Record<string, unknown>,
  ): Promise<{ opcode: number; requestId: number; payload: TPayload }> {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out waiting for control response'))
      }, 2000)

      ws.onmessage = (event) => {
        const frame = new Uint8Array(event.data as ArrayBuffer)
        const responseRequestId = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(
          4,
          true,
        )
        if (responseRequestId !== requestId) {
          return
        }

        clearTimeout(timeout)
        const responsePayload = JSON.parse(new TextDecoder().decode(frame.slice(8))) as TPayload
        resolve({
          opcode: frame[1],
          requestId: responseRequestId,
          payload: responsePayload,
        })
      }

      ws.send(buildProtocolFrame(opcode, requestId, new TextEncoder().encode(JSON.stringify(payload))))
    })
  }

  function buildProtocolFrame(opcode: number, requestId: number, payload?: Uint8Array): Uint8Array {
    const frame = new Uint8Array(8 + (payload?.length ?? 0))
    const view = new DataView(frame.buffer)
    frame[0] = 1
    frame[1] = opcode
    view.setUint16(2, 0, true)
    view.setUint32(4, requestId, true)
    if (payload) {
      frame.set(payload, 8)
    }
    return frame
  }

  conformanceCase('rust', 'health.ok_is_reported', 'serves /health', async () => {
    harness = await startDaemon()

    const response = await makeAuthenticatedRequest('/health', {
      headers: {
        Accept: 'text/plain',
      },
    })

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('ok')
  })

  conformanceCase(
    'rust',
    'control.capabilities_are_reported',
    'answers control capability requests over /control',
    async () => {
      harness = await startDaemon()
      const ws = await connectAuthenticatedControlWebSocket()

      try {
        const response = await sendControlJsonRequest<{
          ok: boolean
          protocolVersion?: number
          behaviorVersion?: number
          capabilities: { roots_manageable: boolean; lan_share_urls: boolean }
        }>(ws, 0xed, 9, {})

        expect(response.opcode).toBe(0xed)
        expect(response.requestId).toBe(9)
        expect(response.payload).toEqual({
          ok: true,
          protocolVersion: 1,
          behaviorVersion: 1,
          capabilities: {
            roots_manageable: false,
            lan_share_urls: true,
          },
        })
      } finally {
        ws.close()
      }
    },
  )

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
