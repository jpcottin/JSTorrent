import type { IUdpSocket } from '../interfaces/socket'
import type { Logger } from '../logging/logger'
import { NATPMP_GATEWAY_PORT } from './nat-pmp-client'

export const PCP_VERSION = 2

const OPCODE_MAP = 1
const RESPONSE_FLAG = 0x80

const INITIAL_RETRY_MS = 250
const MAX_RETRIES = 9

const PROTOCOL_TCP = 6
const PROTOCOL_UDP = 17

const PCP_REQUEST_SIZE = 60
const PCP_RESPONSE_SIZE = 60

export enum PcpResultCode {
  Success = 0,
  UnsupportedVersion = 1,
  NotAuthorized = 2,
  MalformedRequest = 3,
  UnsupportedOpcode = 4,
  UnsupportedOption = 5,
  MalformedOption = 6,
  NetworkFailure = 7,
  NoResources = 8,
  UnsupportedProtocol = 9,
  UserExceededQuota = 10,
  CannotProvideExternal = 11,
  AddressMismatch = 12,
  ExcessiveRemotePeers = 13,
}

const RESULT_CODE_NAMES: Record<number, string> = {
  [PcpResultCode.UnsupportedVersion]: 'Unsupported Version',
  [PcpResultCode.NotAuthorized]: 'Not Authorized',
  [PcpResultCode.MalformedRequest]: 'Malformed Request',
  [PcpResultCode.UnsupportedOpcode]: 'Unsupported Opcode',
  [PcpResultCode.UnsupportedOption]: 'Unsupported Option',
  [PcpResultCode.MalformedOption]: 'Malformed Option',
  [PcpResultCode.NetworkFailure]: 'Network Failure',
  [PcpResultCode.NoResources]: 'No Resources',
  [PcpResultCode.UnsupportedProtocol]: 'Unsupported Protocol',
  [PcpResultCode.UserExceededQuota]: 'User Exceeded Quota',
  [PcpResultCode.CannotProvideExternal]: 'Cannot Provide External',
  [PcpResultCode.AddressMismatch]: 'Address Mismatch',
  [PcpResultCode.ExcessiveRemotePeers]: 'Excessive Remote Peers',
}

export class PcpError extends Error {
  constructor(
    message: string,
    public readonly resultCode?: PcpResultCode,
  ) {
    super(message)
    this.name = 'PcpError'
  }
}

export interface PcpMapping {
  internalPort: number
  externalPort: number
  externalIP: string
  lifetime: number
  nonce: Uint8Array
  protocol: 'TCP' | 'UDP'
}

export class PcpClient {
  private pendingResolve: ((data: Uint8Array) => void) | null = null
  private pendingReject: ((err: Error) => void) | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(
    private socket: IUdpSocket,
    private gatewayIP: string,
    private clientIP: string,
    private logger?: Logger,
  ) {
    this.socket.onMessage((_src, data) => {
      if (this.pendingResolve) {
        this.pendingResolve(data)
      }
    })
  }

  async addMapping(
    internalPort: number,
    externalPort: number,
    protocol: 'TCP' | 'UDP',
    lifetime: number,
  ): Promise<PcpMapping> {
    const nonce = randomNonce()
    const request = buildPcpMapRequest(
      this.clientIP,
      nonce,
      internalPort,
      externalPort,
      protocol,
      lifetime,
    )

    const response = await this.rpc(request)
    const mapping = parsePcpMapResponse(response, nonce)

    this.logger?.info(
      `PCP: Mapped ${protocol} ${mapping.internalPort} -> ${mapping.externalPort} (${mapping.lifetime}s) ext=${mapping.externalIP}`,
    )
    return mapping
  }

  async removeMapping(mapping: PcpMapping): Promise<boolean> {
    const request = buildPcpMapRequest(
      this.clientIP,
      mapping.nonce,
      mapping.internalPort,
      0,
      mapping.protocol,
      0,
    )

    try {
      const response = await this.rpc(request)
      parsePcpMapResponse(response, mapping.nonce)
      this.logger?.info(`PCP: Removed ${mapping.protocol} mapping for port ${mapping.internalPort}`)
      return true
    } catch {
      this.logger?.warn(
        `PCP: Failed to remove ${mapping.protocol} mapping for port ${mapping.internalPort}`,
      )
      return false
    }
  }

  close(): void {
    this.closed = true
    this.cancelPendingRpc(new PcpError('Client is closed'))
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
        reject(new PcpError('Client is closed'))
        return
      }

      let retryCount = 0
      let settled = false

      const onResponse = (data: Uint8Array) => {
        if (settled) return
        // Validate response: version=2, opcode has R bit set matching our request
        if (
          data.length >= 4 &&
          data[0] === PCP_VERSION &&
          data[1] === (request[1] | RESPONSE_FLAG)
        ) {
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
          reject(new PcpError(`No response after ${MAX_RETRIES} retries`))
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

export function buildPcpMapRequest(
  clientIP: string,
  nonce: Uint8Array,
  internalPort: number,
  externalPort: number,
  protocol: 'TCP' | 'UDP',
  lifetime: number,
): Uint8Array {
  const buf = new Uint8Array(PCP_REQUEST_SIZE)
  const view = new DataView(buf.buffer)

  // Header (24 bytes)
  buf[0] = PCP_VERSION
  buf[1] = OPCODE_MAP
  // bytes 2-3 reserved
  view.setUint32(4, lifetime)
  buf.set(ipToMappedIPv6(clientIP), 8)

  // MAP payload (36 bytes)
  buf.set(nonce.subarray(0, 12), 24)
  buf[36] = protocol === 'TCP' ? PROTOCOL_TCP : PROTOCOL_UDP
  // bytes 37-39 reserved
  view.setUint16(40, internalPort)
  view.setUint16(42, externalPort)
  // bytes 44-59: suggested external IP (all zeros = let gateway choose)

  return buf
}

export function parsePcpMapResponse(data: Uint8Array, expectedNonce: Uint8Array): PcpMapping {
  if (data.length < PCP_RESPONSE_SIZE) {
    throw new PcpError(`Unexpected response size: ${data.length}, expected ${PCP_RESPONSE_SIZE}`)
  }

  if (data[0] !== PCP_VERSION) {
    throw new PcpError(`Unsupported protocol version: ${data[0]}`, PcpResultCode.UnsupportedVersion)
  }

  if (data[1] !== (OPCODE_MAP | RESPONSE_FLAG)) {
    throw new PcpError(`Unexpected opcode: ${data[1]}, expected ${OPCODE_MAP | RESPONSE_FLAG}`)
  }

  // Byte 3 is the result code (byte 2 is reserved)
  const resultCode = data[3]
  if (resultCode !== PcpResultCode.Success) {
    const name = RESULT_CODE_NAMES[resultCode] ?? `Unknown (${resultCode})`
    throw new PcpError(`PCP error: ${name}`, resultCode as PcpResultCode)
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  // Validate nonce (bytes 24-35)
  for (let i = 0; i < 12; i++) {
    if (data[24 + i] !== expectedNonce[i]) {
      throw new PcpError('Nonce mismatch')
    }
  }

  const protocolByte = data[36]
  const protocol: 'TCP' | 'UDP' = protocolByte === PROTOCOL_TCP ? 'TCP' : 'UDP'

  return {
    internalPort: view.getUint16(40),
    externalPort: view.getUint16(42),
    externalIP: mappedIPv6ToIP(data.subarray(44, 60)),
    lifetime: view.getUint32(4),
    nonce: new Uint8Array(data.subarray(24, 36)),
    protocol,
  }
}

export function ipToMappedIPv6(ipv4: string): Uint8Array {
  const bytes = new Uint8Array(16)
  const parts = ipv4.split('.')
  // 10 zero bytes, then 0xFF 0xFF, then 4 IPv4 bytes
  bytes[10] = 0xff
  bytes[11] = 0xff
  bytes[12] = parseInt(parts[0], 10)
  bytes[13] = parseInt(parts[1], 10)
  bytes[14] = parseInt(parts[2], 10)
  bytes[15] = parseInt(parts[3], 10)
  return bytes
}

export function mappedIPv6ToIP(bytes: Uint8Array): string {
  // Check for IPv4-mapped-IPv6: 10 zero bytes + 0xFF 0xFF + 4 IPv4 bytes
  let isV4Mapped = bytes[10] === 0xff && bytes[11] === 0xff
  if (isV4Mapped) {
    for (let i = 0; i < 10; i++) {
      if (bytes[i] !== 0) {
        isV4Mapped = false
        break
      }
    }
  }
  if (isV4Mapped) {
    return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`
  }
  // Fall back to full IPv6 representation
  const parts: string[] = []
  for (let i = 0; i < 16; i += 2) {
    parts.push(((bytes[i] << 8) | bytes[i + 1]).toString(16))
  }
  return parts.join(':')
}

function randomNonce(): Uint8Array {
  const nonce = new Uint8Array(12)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(nonce)
  } else {
    for (let i = 0; i < 12; i++) {
      nonce[i] = Math.floor(Math.random() * 256)
    }
  }
  return nonce
}
