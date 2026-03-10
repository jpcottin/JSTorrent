const decoder = new TextDecoder()

export const IO_PROTOCOL_VERSION = 1

export const IO_OP_CLIENT_HELLO = 0x01
export const IO_OP_SERVER_HELLO = 0x02
export const IO_OP_AUTH = 0x03
export const IO_OP_AUTH_RESULT = 0x04
export const IO_OP_ERROR = 0x7f
export const IO_OP_TCP_CONNECT = 0x10
export const IO_OP_TCP_CONNECTED = 0x11
export const IO_OP_TCP_SEND = 0x12
export const IO_OP_TCP_RECV = 0x13
export const IO_OP_TCP_CLOSE = 0x14
export const IO_OP_TCP_LISTEN = 0x15
export const IO_OP_TCP_LISTEN_RESULT = 0x16
export const IO_OP_TCP_ACCEPT = 0x17
export const IO_OP_TCP_STOP_LISTEN = 0x18
export const IO_OP_TCP_SECURE = 0x19
export const IO_OP_TCP_SECURED = 0x1a

export interface IoProtocolEnvelope {
  version: number
  msgType: number
  flags: number
  requestId: number
  payload: Uint8Array
}

export interface IoProtocolAuthPayload {
  authType: number
  token: string
  extensionId: string
  installId: string
}

export function parseIoProtocolEnvelope(payload: Uint8Array): IoProtocolEnvelope | null {
  if (payload.byteLength < 8) {
    return null
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  return {
    version: view.getUint8(0),
    msgType: view.getUint8(1),
    flags: view.getUint16(2, true),
    requestId: view.getUint32(4, true),
    payload: payload.slice(8),
  }
}

export function buildIoProtocolFrame(
  msgType: number,
  requestId: number,
  payload: Uint8Array = new Uint8Array(0),
): Buffer {
  const frame = new Uint8Array(8 + payload.byteLength)
  const view = new DataView(frame.buffer)
  view.setUint8(0, IO_PROTOCOL_VERSION)
  view.setUint8(1, msgType)
  view.setUint16(2, 0, true)
  view.setUint32(4, requestId, true)
  frame.set(payload, 8)
  return Buffer.from(frame)
}

export function buildIoProtocolErrorFrame(requestId: number, message: string): Buffer {
  return buildIoProtocolFrame(IO_OP_ERROR, requestId, new TextEncoder().encode(message))
}

export function buildIoProtocolAuthResultFrame(
  requestId: number,
  ok: boolean,
  message?: string,
): Buffer {
  const extra = message ? new TextEncoder().encode(message) : new Uint8Array(0)
  const payload = new Uint8Array(1 + extra.byteLength)
  payload[0] = ok ? 0 : 1
  payload.set(extra, 1)
  return buildIoProtocolFrame(IO_OP_AUTH_RESULT, requestId, payload)
}

export function parseIoProtocolAuthPayload(payload: Uint8Array): IoProtocolAuthPayload | null {
  if (payload.byteLength === 0) {
    return null
  }

  const authType = payload[0]
  const data = payload.slice(1)

  if (authType === 0) {
    const fields = splitNullSeparatedFields(data, 3)
    return {
      authType,
      token: fields[0] ?? '',
      extensionId: fields[1] ?? '',
      installId: fields[2] ?? '',
    }
  }

  if (authType === 1) {
    return {
      authType,
      token: decoder.decode(data),
      extensionId: '',
      installId: '',
    }
  }

  return null
}

function splitNullSeparatedFields(payload: Uint8Array, limit: number): string[] {
  const fields: string[] = []
  let start = 0

  for (let index = 0; index < payload.byteLength && fields.length < limit - 1; index += 1) {
    if (payload[index] === 0) {
      fields.push(decoder.decode(payload.slice(start, index)))
      start = index + 1
    }
  }

  fields.push(decoder.decode(payload.slice(start)))
  return fields
}
