import * as crypto from 'node:crypto'

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export interface DecodedWebSocketFrame {
  fin: boolean
  opcode: number
  masked: boolean
  payload: Buffer
  bytesConsumed: number
}

export function createWebSocketAcceptValue(key: string): string {
  return crypto.createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64')
}

export function decodeWebSocketFrame(buffer: Buffer): DecodedWebSocketFrame | null {
  if (buffer.length < 2) {
    return null
  }

  const firstByte = buffer[0]
  const secondByte = buffer[1]
  const fin = (firstByte & 0x80) !== 0
  const opcode = firstByte & 0x0f
  const masked = (secondByte & 0x80) !== 0
  let payloadLength = secondByte & 0x7f
  let offset = 2

  if (payloadLength === 126) {
    if (buffer.length < offset + 2) {
      return null
    }
    payloadLength = buffer.readUInt16BE(offset)
    offset += 2
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) {
      return null
    }
    const length64 = buffer.readBigUInt64BE(offset)
    if (length64 > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('WebSocket frame too large')
    }
    payloadLength = Number(length64)
    offset += 8
  }

  const maskLength = masked ? 4 : 0
  const totalLength = offset + maskLength + payloadLength
  if (buffer.length < totalLength) {
    return null
  }

  const mask = masked ? buffer.subarray(offset, offset + 4) : null
  const payloadStart = offset + maskLength
  const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + payloadLength))

  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4]
    }
  }

  return {
    fin,
    opcode,
    masked,
    payload,
    bytesConsumed: totalLength,
  }
}

export function encodeBinaryWebSocketFrame(payload: Uint8Array): Buffer {
  return encodeWebSocketFrame(0x2, payload)
}

export function encodePongWebSocketFrame(payload: Uint8Array = new Uint8Array(0)): Buffer {
  return encodeWebSocketFrame(0xa, payload)
}

export function encodeCloseWebSocketFrame(code = 1000, reason = ''): Buffer {
  const reasonBytes = new TextEncoder().encode(reason)
  const payload = new Uint8Array(2 + reasonBytes.byteLength)
  const view = new DataView(payload.buffer)
  view.setUint16(0, code, false)
  payload.set(reasonBytes, 2)
  return encodeWebSocketFrame(0x8, payload)
}

function encodeWebSocketFrame(opcode: number, payload: Uint8Array): Buffer {
  const payloadLength = payload.byteLength

  if (payloadLength < 126) {
    const frame = Buffer.alloc(2 + payloadLength)
    frame[0] = 0x80 | opcode
    frame[1] = payloadLength
    Buffer.from(payload).copy(frame, 2)
    return frame
  }

  if (payloadLength <= 0xffff) {
    const frame = Buffer.alloc(4 + payloadLength)
    frame[0] = 0x80 | opcode
    frame[1] = 126
    frame.writeUInt16BE(payloadLength, 2)
    Buffer.from(payload).copy(frame, 4)
    return frame
  }

  const frame = Buffer.alloc(10 + payloadLength)
  frame[0] = 0x80 | opcode
  frame[1] = 127
  frame.writeBigUInt64BE(BigInt(payloadLength), 2)
  Buffer.from(payload).copy(frame, 10)
  return frame
}
