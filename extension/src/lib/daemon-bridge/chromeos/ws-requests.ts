import {
  buildControlFrame,
  readControlFramePayload,
  readControlFrameRequestId,
} from '../protocol/control-frame'

export interface PendingKvRequest {
  resolve: (response: unknown) => void
  reject: (error: Error) => void
}

export interface PendingControlRequest {
  resolve: (response: ControlResponse) => void
}

export interface ControlResponse {
  ok: boolean
  error?: string
  [key: string]: unknown
}

export type ControlResponseHandleResult =
  | { kind: 'resolved'; requestId: number }
  | { kind: 'missing'; requestId: number }
  | { kind: 'invalid' }

export type KvResponseHandleResult =
  | { kind: 'resolved'; requestId: number }
  | { kind: 'missing'; requestId: number }
  | { kind: 'invalid' }

const WS_OPEN = 1

function defaultRequestIdFactory(): number {
  return Math.floor(Math.random() * 0xffffffff)
}

export async function sendKvRequestOverWebSocket(options: {
  ws: WebSocket | null
  pendingKvRequests: Map<number, PendingKvRequest>
  opcode: number
  payload: Record<string, unknown>
  timeoutMs?: number
  requestIdFactory?: () => number
}): Promise<unknown> {
  const {
    ws,
    pendingKvRequests,
    opcode,
    payload,
    timeoutMs = 10000,
    requestIdFactory = defaultRequestIdFactory,
  } = options

  if (!ws || ws.readyState !== WS_OPEN) {
    throw new Error('WebSocket not connected')
  }

  const requestId = requestIdFactory()
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload))

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingKvRequests.delete(requestId)
      reject(new Error('KV request timeout'))
    }, timeoutMs)

    pendingKvRequests.set(requestId, {
      resolve: (response) => {
        clearTimeout(timeout)
        pendingKvRequests.delete(requestId)
        resolve(response)
      },
      reject: (error) => {
        clearTimeout(timeout)
        pendingKvRequests.delete(requestId)
        reject(error)
      },
    })

    ws.send(buildControlFrame(opcode, requestId, payloadBytes))
  })
}

export async function sendControlRequestOverWebSocket(options: {
  ws: WebSocket | null
  pendingControlRequests: Map<number, PendingControlRequest>
  opcode: number
  payload: Record<string, unknown>
  timeoutMs?: number
  requestIdFactory?: () => number
}): Promise<ControlResponse> {
  const {
    ws,
    pendingControlRequests,
    opcode,
    payload,
    timeoutMs = 10000,
    requestIdFactory = defaultRequestIdFactory,
  } = options

  if (!ws || ws.readyState !== WS_OPEN) {
    return { ok: false, error: 'WebSocket not connected' }
  }

  const requestId = requestIdFactory()
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload))

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingControlRequests.delete(requestId)
      resolve({ ok: false, error: 'Request timed out' })
    }, timeoutMs)

    pendingControlRequests.set(requestId, {
      resolve: (response) => {
        clearTimeout(timeout)
        pendingControlRequests.delete(requestId)
        resolve(response)
      },
    })

    ws.send(buildControlFrame(opcode, requestId, payloadBytes))
  })
}

export function handleControlResponseFrame(
  frame: Uint8Array,
  pendingControlRequests: Map<number, PendingControlRequest>,
): ControlResponseHandleResult {
  let requestId: number
  try {
    requestId = readControlFrameRequestId(frame)
  } catch {
    return { kind: 'invalid' }
  }

  const pending = pendingControlRequests.get(requestId)
  if (!pending) {
    return { kind: 'missing', requestId }
  }

  try {
    const payload = readControlFramePayload(frame)
    const json = new TextDecoder().decode(payload)
    const response = JSON.parse(json) as ControlResponse
    pending.resolve(response)
  } catch (e) {
    pending.resolve({ ok: false, error: `Failed to parse response: ${e}` })
  }

  return { kind: 'resolved', requestId }
}

export function handleKvResponseFrame(
  frame: Uint8Array,
  pendingKvRequests: Map<number, PendingKvRequest>,
): KvResponseHandleResult {
  let requestId: number
  try {
    requestId = readControlFrameRequestId(frame)
  } catch {
    return { kind: 'invalid' }
  }

  const pending = pendingKvRequests.get(requestId)
  if (!pending) {
    return { kind: 'missing', requestId }
  }

  try {
    const payload = readControlFramePayload(frame)
    const json = new TextDecoder().decode(payload)
    const response = JSON.parse(json)
    pending.resolve(response)
  } catch (e) {
    pending.reject(new Error(`Failed to parse KV response: ${e}`))
  }

  return { kind: 'resolved', requestId }
}
