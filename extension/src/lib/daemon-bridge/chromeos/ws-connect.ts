import { buildControlFrame } from '../protocol/control-frame'

export interface WebSocketLike {
  binaryType: BinaryType
  readyState: number
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void
  close(code?: number, reason?: string): void
  onopen: ((this: WebSocket, ev: Event) => unknown) | null
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null
  onerror: ((this: WebSocket, ev: Event) => unknown) | null
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null
}

export interface ConnectChromeosControlWebSocketOptions {
  host: string
  port: number
  token: string
  extensionId: string
  telemetryId: string
  onRootsChanged: (frame: Uint8Array) => void
  onControlEvent: (frame: Uint8Array) => void
  onKvResponse: (frame: Uint8Array) => void
  onControlResponse: (frame: Uint8Array) => void
  onDisconnected: () => void
  timeoutMs?: number
  createWebSocket?: (url: string) => WebSocketLike
}

function createAuthPayload(token: string, extensionId: string, telemetryId: string): Uint8Array {
  const encoder = new TextEncoder()
  const tokenBytes = encoder.encode(token)
  const extensionIdBytes = encoder.encode(extensionId)
  const telemetryIdBytes = encoder.encode(telemetryId)

  const authPayload = new Uint8Array(
    1 + tokenBytes.length + 1 + extensionIdBytes.length + 1 + telemetryIdBytes.length,
  )
  authPayload[0] = 0
  authPayload.set(tokenBytes, 1)
  authPayload[1 + tokenBytes.length] = 0
  authPayload.set(extensionIdBytes, 1 + tokenBytes.length + 1)
  authPayload[1 + tokenBytes.length + 1 + extensionIdBytes.length] = 0
  authPayload.set(telemetryIdBytes, 1 + tokenBytes.length + 1 + extensionIdBytes.length + 1)

  return authPayload
}

export async function connectChromeosControlWebSocket(
  options: ConnectChromeosControlWebSocketOptions,
): Promise<WebSocketLike> {
  const {
    host,
    port,
    token,
    extensionId,
    telemetryId,
    onRootsChanged,
    onControlEvent,
    onKvResponse,
    onControlResponse,
    onDisconnected,
    timeoutMs = 10000,
    createWebSocket = (url: string) => new WebSocket(url),
  } = options

  return new Promise((resolve, reject) => {
    const ws = createWebSocket(`ws://${host}:${port}/control`)
    ws.binaryType = 'arraybuffer'

    let settled = false
    let authenticated = false

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      ws.close()
      reject(new Error('WebSocket timeout'))
    }, timeoutMs)

    const rejectOnce = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    }

    const resolveOnce = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(ws)
    }

    ws.onopen = () => {
      ws.send(buildControlFrame(0x01, 0, new Uint8Array(0)))
    }

    ws.onmessage = (event) => {
      const data = new Uint8Array(event.data as ArrayBuffer)
      const opcode = data[1]

      if (opcode === 0x02) {
        const authPayload = createAuthPayload(token, extensionId, telemetryId)
        ws.send(buildControlFrame(0x03, 0, authPayload))
        return
      }

      if (opcode === 0x04) {
        const status = data[8]
        if (status === 0) {
          authenticated = true
          resolveOnce()
        } else {
          ws.close()
          rejectOnce(new Error('Auth failed'))
        }
        return
      }

      if (opcode === 0xe0) {
        onRootsChanged(data)
      } else if (opcode === 0xe1) {
        onControlEvent(data)
      } else if (opcode >= 0xe3 && opcode <= 0xe8) {
        onKvResponse(data)
      } else if (
        opcode === 0x7f ||
        opcode === 0xe9 ||
        opcode === 0xea ||
        opcode === 0xec ||
        opcode === 0xed
      ) {
        onControlResponse(data)
      }
    }

    ws.onerror = () => {
      rejectOnce(new Error('WebSocket error'))
    }

    ws.onclose = () => {
      if (authenticated) {
        onDisconnected()
      }
    }
  })
}
