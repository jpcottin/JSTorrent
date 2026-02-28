import type { IUdpSocket } from '../interfaces/socket'
import type { Logger } from '../logging/logger'

export const NATPMP_GATEWAY_PORT = 5351

const VERSION = 0
const OPCODE_EXTERNAL_ADDRESS = 0
const OPCODE_MAP_UDP = 1
const OPCODE_MAP_TCP = 2
const RESPONSE_FLAG = 0x80

const INITIAL_RETRY_MS = 250
const MAX_RETRIES = 9

export enum NatPmpResultCode {
  Success = 0,
  UnsupportedVersion = 1,
  NotAuthorized = 2,
  NetworkFailure = 3,
  OutOfResources = 4,
  UnsupportedOpcode = 5,
}

const RESULT_CODE_NAMES: Record<number, string> = {
  [NatPmpResultCode.UnsupportedVersion]: 'Unsupported Version',
  [NatPmpResultCode.NotAuthorized]: 'Not Authorized',
  [NatPmpResultCode.NetworkFailure]: 'Network Failure',
  [NatPmpResultCode.OutOfResources]: 'Out of Resources',
  [NatPmpResultCode.UnsupportedOpcode]: 'Unsupported Opcode',
}

export class NatPmpError extends Error {
  constructor(
    message: string,
    public readonly resultCode?: NatPmpResultCode,
  ) {
    super(message)
    this.name = 'NatPmpError'
  }
}

export interface NatPmpMapping {
  internalPort: number
  externalPort: number
  lifetime: number
}

export class NatPmpClient {
  private pendingResolve: ((data: Uint8Array) => void) | null = null
  private pendingReject: ((err: Error) => void) | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(
    private socket: IUdpSocket,
    private gatewayIP: string,
    private logger?: Logger,
  ) {
    this.socket.onMessage((_src, data) => {
      if (this.pendingResolve) {
        this.pendingResolve(data)
      }
    })
  }

  async getExternalAddress(): Promise<string> {
    const request = new Uint8Array(2)
    request[0] = VERSION
    request[1] = OPCODE_EXTERNAL_ADDRESS

    const response = await this.rpc(request)
    checkResponse(response, OPCODE_EXTERNAL_ADDRESS, 12)

    const ip = `${response[8]}.${response[9]}.${response[10]}.${response[11]}`
    this.logger?.info(`NAT-PMP: External address ${ip}`)
    return ip
  }

  async addMapping(
    internalPort: number,
    externalPort: number,
    protocol: 'TCP' | 'UDP',
    lifetime: number,
  ): Promise<NatPmpMapping> {
    const opcode = protocol === 'UDP' ? OPCODE_MAP_UDP : OPCODE_MAP_TCP
    const request = buildMappingRequest(opcode, internalPort, externalPort, lifetime)

    const response = await this.rpc(request)
    checkResponse(response, opcode, 16)

    const view = new DataView(response.buffer, response.byteOffset, response.byteLength)
    const mapping: NatPmpMapping = {
      internalPort: view.getUint16(8),
      externalPort: view.getUint16(10),
      lifetime: view.getUint32(12),
    }

    this.logger?.info(
      `NAT-PMP: Mapped ${protocol} ${mapping.internalPort} -> ${mapping.externalPort} (${mapping.lifetime}s)`,
    )
    return mapping
  }

  async removeMapping(internalPort: number, protocol: 'TCP' | 'UDP'): Promise<boolean> {
    const opcode = protocol === 'UDP' ? OPCODE_MAP_UDP : OPCODE_MAP_TCP
    const request = buildMappingRequest(opcode, internalPort, 0, 0)

    try {
      const response = await this.rpc(request)
      checkResponse(response, opcode, 16)
      this.logger?.info(`NAT-PMP: Removed ${protocol} mapping for port ${internalPort}`)
      return true
    } catch {
      this.logger?.warn(`NAT-PMP: Failed to remove ${protocol} mapping for port ${internalPort}`)
      return false
    }
  }

  close(): void {
    this.closed = true
    this.cancelPendingRpc(new NatPmpError('Client is closed'))
  }

  private cancelPendingRpc(err: Error): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    const reject = this.pendingReject
    this.pendingResolve = null
    this.pendingReject = null
    if (reject) {
      reject(err)
    }
  }

  private rpc(request: Uint8Array): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      if (this.closed) {
        reject(new NatPmpError('Client is closed'))
        return
      }

      let retryCount = 0
      let settled = false

      const onResponse = (data: Uint8Array) => {
        if (settled) return
        // Validate response matches our request opcode
        if (data.length >= 2 && data[1] === (request[1] | RESPONSE_FLAG)) {
          settled = true
          this.clearRpcState()
          resolve(new Uint8Array(data))
        }
      }

      this.pendingReject = (err: Error) => {
        if (settled) return
        settled = true
        this.clearRpcState()
        reject(err)
      }

      const sendAndRetry = () => {
        if (settled) return

        if (retryCount >= MAX_RETRIES) {
          settled = true
          this.clearRpcState()
          reject(new NatPmpError(`No response after ${MAX_RETRIES} retries`))
          return
        }

        this.pendingResolve = onResponse
        this.socket.send(this.gatewayIP, NATPMP_GATEWAY_PORT, request)

        const delay = INITIAL_RETRY_MS * Math.pow(2, retryCount)
        retryCount++
        this.retryTimer = setTimeout(sendAndRetry, delay)
      }

      sendAndRetry()
    })
  }

  private clearRpcState(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.pendingResolve = null
    this.pendingReject = null
  }
}

export function buildMappingRequest(
  opcode: number,
  internalPort: number,
  externalPort: number,
  lifetime: number,
): Uint8Array {
  const buf = new Uint8Array(12)
  const view = new DataView(buf.buffer)
  buf[0] = VERSION
  buf[1] = opcode
  // bytes 2-3 reserved (zero)
  view.setUint16(4, internalPort)
  view.setUint16(6, externalPort)
  view.setUint32(8, lifetime)
  return buf
}

export function checkResponse(
  data: Uint8Array,
  expectedOpcode: number,
  expectedSize: number,
): void {
  if (data.length !== expectedSize) {
    throw new NatPmpError(`Unexpected response size: ${data.length}, expected ${expectedSize}`)
  }
  if (data[0] !== VERSION) {
    throw new NatPmpError(
      `Unsupported protocol version: ${data[0]}`,
      NatPmpResultCode.UnsupportedVersion,
    )
  }
  if (data[1] !== (expectedOpcode | RESPONSE_FLAG)) {
    throw new NatPmpError(
      `Unexpected opcode: ${data[1]}, expected ${expectedOpcode | RESPONSE_FLAG}`,
    )
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const resultCode = view.getUint16(2)
  if (resultCode !== NatPmpResultCode.Success) {
    const name = RESULT_CODE_NAMES[resultCode] ?? `Unknown (${resultCode})`
    throw new NatPmpError(`NAT-PMP error: ${name}`, resultCode as NatPmpResultCode)
  }
}
