#!/usr/bin/env npx tsx
/**
 * Test DHT bootstrap through the io-daemon's UDP proxy.
 * Connects to a running io-daemon via WebSocket and sends DHT queries
 * through the daemon's UDP socket implementation.
 *
 * Usage: npx tsx scripts/test-dht-daemon-bootstrap.ts [port] [token]
 *
 * If not provided, reads from the running jstorrent-io-daemon process args.
 */

import {
  encodeFindNodeQuery,
  decodeMessage,
  getResponseNodes,
  getResponseNodeId,
  isResponse,
} from '../packages/engine/src/dht/krpc-messages'
import { generateRandomNodeId, nodeIdToHex } from '../packages/engine/src/dht/xor-distance'
import { BOOTSTRAP_NODES, QUERY_TIMEOUT_MS } from '../packages/engine/src/dht/constants'
import { execSync } from 'child_process'

// Protocol constants (matching io-daemon and daemon-socket-factory.ts)
const PROTOCOL_VERSION = 1
const OP_CLIENT_HELLO = 0x01
const OP_SERVER_HELLO = 0x02
const OP_AUTH = 0x03
const OP_AUTH_RESULT = 0x04
const OP_UDP_BIND = 0x20
const OP_UDP_BOUND = 0x21
const OP_UDP_SEND = 0x22
const OP_UDP_RECV = 0x23
const OP_UDP_CLOSE = 0x24
const OP_ERROR = 0x7f

function packEnvelope(msgType: number, reqId: number, payload?: Uint8Array): ArrayBuffer {
  const payloadLen = payload ? payload.byteLength : 0
  const buffer = new ArrayBuffer(8 + payloadLen)
  const view = new DataView(buffer)
  view.setUint8(0, PROTOCOL_VERSION)
  view.setUint8(1, msgType)
  view.setUint16(2, 0, true) // flags
  view.setUint32(4, reqId, true) // request_id
  if (payload) {
    new Uint8Array(buffer, 8).set(payload)
  }
  return buffer
}

function unpackEnvelope(buffer: ArrayBuffer) {
  const view = new DataView(buffer)
  return {
    version: view.getUint8(0),
    msgType: view.getUint8(1),
    flags: view.getUint16(2, true),
    reqId: view.getUint32(4, true),
    payload: new Uint8Array(buffer, 8),
  }
}

function detectDaemon(): { port: number; token: string } | null {
  try {
    const output = execSync('pgrep -fl jstorrent-io-daemon', { encoding: 'utf8' })
    const portMatch = output.match(/--port\s+(\d+)/)
    const tokenMatch = output.match(/--token\s+([\w-]+)/)
    if (!portMatch || !tokenMatch) return null

    // Port 0 means auto-assigned, need to find actual port from log
    let port = parseInt(portMatch[1])
    if (port === 0) {
      try {
        const log = execSync(
          'tail -20 ~/Library/Application\\ Support/jstorrent-native/io-daemon.log',
          { encoding: 'utf8' },
        )
        const listenMatch = log.match(/listening on 127\.0\.0\.1:(\d+)/g)
        if (listenMatch) {
          const lastMatch = listenMatch[listenMatch.length - 1]
          const portNum = lastMatch.match(/:(\d+)$/)
          if (portNum) port = parseInt(portNum[1])
        }
      } catch {
        /* ignore */
      }
    }

    return { port, token: tokenMatch[1] }
  } catch {
    return null
  }
}

function toArrayBuffer(data: unknown): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data
  if (data instanceof Buffer)
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  if (data instanceof Blob) throw new Error('Blob not supported - set binaryType to arraybuffer')
  throw new Error(`Unexpected data type: ${typeof data}`)
}

async function connectAndAuth(port: number, token: string): Promise<WebSocket> {
  const url = `ws://127.0.0.1:${port}/io`
  console.log(`Connecting to ${url}...`)

  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer' as any

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('WebSocket connection failed'))
  })
  console.log('WebSocket connected')

  // Handshake: CLIENT_HELLO
  ws.send(packEnvelope(OP_CLIENT_HELLO, 1))

  // Wait for SERVER_HELLO
  await waitForOpcode(ws, OP_SERVER_HELLO)
  console.log('Got SERVER_HELLO')

  // Send AUTH
  const encoder = new TextEncoder()
  const tokenBytes = encoder.encode(token)
  const authPayload = new Uint8Array(1 + tokenBytes.length + 1 + 1)
  let offset = 0
  authPayload[offset++] = 0 // authType 0
  authPayload.set(tokenBytes, offset)
  offset += tokenBytes.length
  authPayload[offset++] = 0 // null separator (extensionId = empty)
  authPayload[offset++] = 0 // null separator (installId = empty)

  ws.send(packEnvelope(OP_AUTH, 2, authPayload))

  // Wait for AUTH_RESULT
  const authFrame = await waitForOpcode(ws, OP_AUTH_RESULT)
  const authResult = unpackEnvelope(authFrame)
  if (authResult.payload.byteLength > 0 && authResult.payload[0] === 0) {
    console.log('Authenticated successfully')
  } else {
    throw new Error('Auth failed')
  }

  return ws
}

function waitForOpcode(ws: WebSocket, expectedOp: number): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeEventListener('message', handler)
      reject(new Error(`Timeout waiting for opcode 0x${expectedOp.toString(16)}`))
    }, 10000)

    const handler = (ev: MessageEvent) => {
      const frame = toArrayBuffer(ev.data)
      const env = unpackEnvelope(frame)
      if (env.msgType === expectedOp) {
        clearTimeout(timeout)
        ws.removeEventListener('message', handler)
        resolve(frame)
      } else if (env.msgType === OP_ERROR) {
        clearTimeout(timeout)
        ws.removeEventListener('message', handler)
        reject(new Error(`Received ERROR: ${new TextDecoder().decode(env.payload)}`))
      }
    }
    ws.addEventListener('message', handler)
  })
}

async function bindUdpSocket(ws: WebSocket, socketId: number, bindPort: number = 0): Promise<void> {
  const bindAddr = '0.0.0.0'
  const addrBytes = new TextEncoder().encode(bindAddr)
  const buffer = new ArrayBuffer(4 + 2 + addrBytes.length)
  const view = new DataView(buffer)
  view.setUint32(0, socketId, true)
  view.setUint16(4, bindPort, true)
  new Uint8Array(buffer, 6).set(addrBytes)

  const reqId = Math.floor(Math.random() * 0xffffffff)
  ws.send(packEnvelope(OP_UDP_BIND, reqId, new Uint8Array(buffer)))

  // Wait for BOUND response
  const frame = await new Promise<ArrayBuffer>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeEventListener('message', handler)
      reject(new Error('UDP bind timeout'))
    }, 5000)

    const handler = (ev: MessageEvent) => {
      const frame = toArrayBuffer(ev.data)
      const env = unpackEnvelope(frame)
      // Check if it's a response for our reqId
      if (env.reqId === reqId) {
        clearTimeout(timeout)
        ws.removeEventListener('message', handler)
        resolve(frame)
      }
    }
    ws.addEventListener('message', handler)
  })

  const env = unpackEnvelope(frame)
  if (env.payload.byteLength >= 5) {
    const status = env.payload[4]
    if (status !== 0) {
      throw new Error(`UDP bind failed with status ${status}`)
    }
    const boundPort = new DataView(env.payload.buffer, env.payload.byteOffset).getUint16(5, true)
    console.log(`UDP socket ${socketId} bound on port ${boundPort}`)
  }
}

function sendUdp(
  ws: WebSocket,
  socketId: number,
  destAddr: string,
  destPort: number,
  data: Uint8Array,
): void {
  const addrBytes = new TextEncoder().encode(destAddr)
  const buffer = new ArrayBuffer(4 + 2 + 2 + addrBytes.length + data.byteLength)
  const view = new DataView(buffer)
  view.setUint32(0, socketId, true)
  view.setUint16(4, destPort, true)
  view.setUint16(6, addrBytes.length, true)
  new Uint8Array(buffer, 8).set(addrBytes)
  new Uint8Array(buffer, 8 + addrBytes.length).set(data)

  const env = new ArrayBuffer(8 + buffer.byteLength)
  const envView = new DataView(env)
  envView.setUint8(0, PROTOCOL_VERSION)
  envView.setUint8(1, OP_UDP_SEND)
  envView.setUint16(2, 0, true)
  envView.setUint32(4, 0, true)
  new Uint8Array(env, 8).set(new Uint8Array(buffer))

  ws.send(env)
}

function closeUdpSocket(ws: WebSocket, socketId: number): void {
  const buffer = new ArrayBuffer(4)
  new DataView(buffer).setUint32(0, socketId, true)

  const env = new ArrayBuffer(8 + 4)
  const envView = new DataView(env)
  envView.setUint8(0, PROTOCOL_VERSION)
  envView.setUint8(1, OP_UDP_CLOSE)
  envView.setUint16(2, 0, true)
  envView.setUint32(4, 0, true)
  new Uint8Array(env, 8).set(new Uint8Array(buffer))

  ws.send(env)
}

interface UdpRecvMessage {
  socketId: number
  addr: string
  port: number
  data: Uint8Array
}

function parseUdpRecv(payload: Uint8Array): UdpRecvMessage {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const socketId = view.getUint32(0, true)
  const port = view.getUint16(4, true)
  const addrLen = view.getUint16(6, true)
  const addr = new TextDecoder().decode(payload.slice(8, 8 + addrLen))
  const data = payload.slice(8 + addrLen)
  return { socketId, addr, port, data }
}

async function main() {
  // Get daemon info
  let port: number
  let token: string

  if (process.argv[2] && process.argv[3]) {
    port = parseInt(process.argv[2])
    token = process.argv[3]
  } else {
    const info = detectDaemon()
    if (!info || info.port === 0) {
      console.error('Could not detect running io-daemon. Pass port and token as args.')
      process.exit(1)
    }
    port = info.port
    token = info.token
  }

  console.log(`=== DHT Bootstrap via io-daemon (port ${port}) ===\n`)

  // Connect and authenticate
  const ws = await connectAndAuth(port, token)

  // Bind UDP socket
  const socketId = 100 // arbitrary ID
  await bindUdpSocket(ws, socketId)

  // Set up UDP receive handler
  const pendingQueries = new Map<
    string,
    {
      host: string
      port: number
      resolve: (msg: UdpRecvMessage) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  ws.addEventListener('message', (ev: MessageEvent) => {
    const frame = toArrayBuffer(ev.data)
    const env = unpackEnvelope(frame)
    if (env.msgType === OP_UDP_RECV) {
      const msg = parseUdpRecv(env.payload)
      if (msg.socketId === socketId) {
        // Try to match to a pending query by decoding the response
        const decoded = decodeMessage(msg.data)
        if (decoded && isResponse(decoded)) {
          // Find pending query by transaction ID
          const tidKey = Array.from(decoded.t)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
          const pending = pendingQueries.get(tidKey)
          if (pending) {
            clearTimeout(pending.timer)
            pendingQueries.delete(tidKey)
            pending.resolve(msg)
          }
        }
      }
    }
  })

  // Helper to send a find_node query and wait for response
  const nodeId = generateRandomNodeId()
  let tidCounter = 0

  async function queryBootstrapNode(host: string, port: number): Promise<UdpRecvMessage | null> {
    tidCounter++
    const transactionId = new Uint8Array(2)
    transactionId[0] = (tidCounter >> 8) & 0xff
    transactionId[1] = tidCounter & 0xff
    const tidKey = Array.from(transactionId)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')

    const queryData = encodeFindNodeQuery(transactionId, nodeId, nodeId)

    return new Promise<UdpRecvMessage | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingQueries.delete(tidKey)
        resolve(null)
      }, QUERY_TIMEOUT_MS)

      pendingQueries.set(tidKey, {
        host,
        port,
        resolve: resolve as (msg: UdpRecvMessage) => void,
        timer,
      })

      console.log(
        `  Sending find_node to ${host}:${port} (${queryData.length} bytes, tid=${tidKey})`,
      )
      sendUdp(ws, socketId, host, port, queryData)
    })
  }

  console.log(`\nOur node ID: ${nodeIdToHex(nodeId).slice(0, 16)}...`)
  console.log(`Querying bootstrap nodes (timeout: ${QUERY_TIMEOUT_MS / 1000}s)...\n`)

  // First, resolve hostnames and try with IP addresses directly
  const dns = await import('dns')
  const { promisify } = await import('util')
  const resolve4 = promisify(dns.resolve4)

  console.log('--- Test A: Sending to hostnames (as the engine does) ---\n')
  for (const { host, port: bport } of BOOTSTRAP_NODES) {
    const result = await queryBootstrapNode(host, bport)
    if (result) {
      const decoded = decodeMessage(result.data)!
      if (isResponse(decoded)) {
        const responderId = getResponseNodeId(decoded as any)
        const nodes = getResponseNodes(decoded as any)
        console.log(`  ✓ Response from ${result.addr}:${result.port} (was ${host}:${bport})`)
        console.log(
          `    Responder ID: ${responderId ? nodeIdToHex(responderId).slice(0, 16) + '...' : 'none'}`,
        )
        console.log(`    Nodes returned: ${nodes.length}`)
        for (const node of nodes.slice(0, 5)) {
          console.log(`      ${node.host}:${node.port} (${nodeIdToHex(node.id).slice(0, 16)}...)`)
        }
      }
    } else {
      console.log(`  ✗ ${host}:${bport} - TIMEOUT (no response via daemon)`)
    }
  }

  console.log('\n--- Test B: Sending to resolved IP addresses ---\n')
  for (const { host, port: bport } of BOOTSTRAP_NODES) {
    let ip: string
    try {
      const ips = await resolve4(host)
      ip = ips[0]
      console.log(`  Resolved ${host} → ${ip}`)
    } catch (err) {
      console.log(`  ✗ DNS resolution failed for ${host}: ${err}`)
      continue
    }
    const result = await queryBootstrapNode(ip, bport)
    if (result) {
      const decoded = decodeMessage(result.data)!
      if (isResponse(decoded)) {
        const responderId = getResponseNodeId(decoded as any)
        const nodes = getResponseNodes(decoded as any)
        console.log(`  ✓ Response from ${result.addr}:${result.port} (was ${host}/${ip}:${bport})`)
        console.log(
          `    Responder ID: ${responderId ? nodeIdToHex(responderId).slice(0, 16) + '...' : 'none'}`,
        )
        console.log(`    Nodes returned: ${nodes.length}`)
      }
    } else {
      console.log(`  ✗ ${ip}:${bport} (${host}) - TIMEOUT (no response via daemon)`)
    }
  }

  // Clean up
  closeUdpSocket(ws, socketId)
  ws.close()
  console.log('\nDone.')
  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
