export interface ControlFrameHeader {
  version: number
  opcode: number
  requestId: number
}

export const CONTROL_FRAME_HEADER_SIZE = 8

function assertHasHeader(frame: Uint8Array): void {
  if (frame.byteLength < CONTROL_FRAME_HEADER_SIZE) {
    throw new Error(
      `Control frame too short: ${frame.byteLength} (need ${CONTROL_FRAME_HEADER_SIZE})`,
    )
  }
}

export function buildControlFrame(
  opcode: number,
  requestId: number,
  payload: Uint8Array,
): ArrayBuffer {
  const frame = new Uint8Array(CONTROL_FRAME_HEADER_SIZE + payload.length)
  frame[0] = 1 // version
  frame[1] = opcode

  const view = new DataView(frame.buffer)
  view.setUint32(4, requestId, true)

  frame.set(payload, CONTROL_FRAME_HEADER_SIZE)
  return frame.buffer
}

export function readControlFrameHeader(frame: Uint8Array): ControlFrameHeader {
  assertHasHeader(frame)

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  return {
    version: frame[0],
    opcode: frame[1],
    requestId: view.getUint32(4, true),
  }
}

export function readControlFrameRequestId(frame: Uint8Array): number {
  return readControlFrameHeader(frame).requestId
}

export function readControlFramePayload(frame: Uint8Array): Uint8Array {
  assertHasHeader(frame)
  return frame.slice(CONTROL_FRAME_HEADER_SIZE)
}

export function decodeControlFrameJsonPayload<T>(frame: Uint8Array): T {
  const json = new TextDecoder().decode(readControlFramePayload(frame))
  return JSON.parse(json) as T
}
