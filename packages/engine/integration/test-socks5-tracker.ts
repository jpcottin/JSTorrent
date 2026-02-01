/**
 * SOCKS5 Tracker Integration Tests
 *
 * Tests HTTP, HTTPS, and UDP tracker announces through a SOCKS5 proxy.
 *
 * Prerequisites:
 * - SSH SOCKS5 proxy for TCP tests: ssh -vND 0.0.0.0:8080 localhost
 *
 * For UDP tests, the SSH proxy doesn't support UDP ASSOCIATE, so we include
 * a simple mock SOCKS5 server that supports it.
 *
 * Run with: npx tsx integration/test-socks5-tracker.ts
 *
 * Options:
 *   --http-only     Only test HTTP tracker
 *   --https-only    Only test HTTPS tracker
 *   --udp-only      Only test UDP tracker
 *   --proxy-port=N  Use different proxy port (default: 8080)
 */

import * as net from 'net'
import * as dgram from 'dgram'
import * as http from 'http'
import * as crypto from 'crypto'
import { NodeSocketFactory } from '../src/adapters/node/node-socket.js'
import { Socks5SocketFactory } from '../src/proxy/socks5-socket-factory.js'
import { HttpTracker } from '../src/tracker/http-tracker.js'
import { UdpTracker } from '../src/tracker/udp-tracker.js'
import { Bencode } from '../src/utils/bencode.js'
import { MinimalHttpClient } from '../src/utils/minimal-http-client.js'
import { ILoggingEngine } from '../src/logging/logger.js'

// Test configuration
const PROXY_HOST = '127.0.0.1'
let PROXY_PORT = 8080
const TEST_INFO_HASH = crypto.randomBytes(20)
const TEST_PEER_ID = Buffer.from('-JT0001-' + crypto.randomBytes(12).toString('hex').slice(0, 12))

// Parse command line args
const args = process.argv.slice(2)
const httpOnly = args.includes('--http-only')
const httpsOnly = args.includes('--https-only')
const udpOnly = args.includes('--udp-only')
const proxyPortArg = args.find((a) => a.startsWith('--proxy-port='))
if (proxyPortArg) {
  PROXY_PORT = parseInt(proxyPortArg.split('=')[1], 10)
}

// Colors for output
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

// Create a minimal engine mock for tracker logging
function createMockEngine(): ILoggingEngine {
  const logger = {
    debug: (message: string, ...args: unknown[]) =>
      console.log(dim(`  [DEBUG] ${message} ${args.join(' ')}`)),
    info: (message: string, ...args: unknown[]) =>
      console.log(`  [INFO] ${message} ${args.join(' ')}`),
    warn: (message: string, ...args: unknown[]) =>
      console.log(yellow(`  [WARN] ${message} ${args.join(' ')}`)),
    error: (message: string, ...args: unknown[]) =>
      console.log(red(`  [ERROR] ${message} ${args.join(' ')}`)),
  }
  return {
    clientId: 'test-client',
    listeningPort: 6881,
    scopedLoggerFor: () => logger,
  }
}

/**
 * Mock HTTP Tracker Server
 * Returns a bencoded response with fake peers
 */
function createMockHttpTracker(): Promise<{
  server: http.Server
  port: number
  announceCount: number
}> {
  return new Promise((resolve) => {
    let announceCount = 0
    const server = http.createServer((req, res) => {
      console.log(dim(`  Mock HTTP Tracker: ${req.method} ${req.url}`))
      announceCount++

      // Parse info_hash from query string
      const url = new URL(req.url!, `http://${req.headers.host}`)
      const infoHashParam = url.searchParams.get('info_hash')
      if (!infoHashParam) {
        res.writeHead(400)
        res.end('Missing info_hash')
        return
      }

      // Return fake peers in compact format
      const response = Buffer.from(
        Bencode.encode({
          interval: 1800,
          complete: 10, // seeders
          incomplete: 5, // leechers
          peers: Buffer.from([
            192,
            168,
            1,
            1,
            0x1a,
            0xe1, // 192.168.1.1:6881
            192,
            168,
            1,
            2,
            0x1a,
            0xe2, // 192.168.1.2:6882
            10,
            0,
            0,
            1,
            0x1a,
            0xe3, // 10.0.0.1:6883
          ]),
        }),
      )

      res.writeHead(200, {
        'Content-Type': 'application/x-bittorrent',
        'Content-Length': response.length.toString(),
        Connection: 'close',
      })
      res.end(response)
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo
      resolve({
        server,
        port: addr.port,
        get announceCount() {
          return announceCount
        },
      })
    })
  })
}

/**
 * Mock UDP Tracker Server (BEP 15)
 */
function createMockUdpTracker(): Promise<{
  socket: dgram.Socket
  port: number
  announceCount: number
}> {
  return new Promise((resolve) => {
    let announceCount = 0
    const socket = dgram.createSocket('udp4')

    // Track connection IDs we've issued
    const validConnectionIds = new Set<string>()

    socket.on('message', (msg, rinfo) => {
      if (msg.length < 16) {
        console.log(dim(`  Mock UDP Tracker: Invalid message (too short)`))
        return
      }

      const action = msg.readUInt32BE(8)

      if (action === 0) {
        // Connect request
        const transactionId = msg.readUInt32BE(12)
        console.log(dim(`  Mock UDP Tracker: Connect request from ${rinfo.address}:${rinfo.port}`))

        // Generate connection ID
        const connectionId = crypto.randomBytes(8)
        validConnectionIds.add(connectionId.toString('hex'))

        // Send connect response
        const response = Buffer.alloc(16)
        response.writeUInt32BE(0, 0) // action: connect
        response.writeUInt32BE(transactionId, 4)
        connectionId.copy(response, 8)

        socket.send(response, rinfo.port, rinfo.address)
      } else if (action === 1) {
        // Announce request
        const connectionId = msg.subarray(0, 8).toString('hex')
        const transactionId = msg.readUInt32BE(12)

        if (!validConnectionIds.has(connectionId)) {
          console.log(dim(`  Mock UDP Tracker: Invalid connection ID`))
          return
        }

        announceCount++
        console.log(dim(`  Mock UDP Tracker: Announce request from ${rinfo.address}:${rinfo.port}`))

        // Send announce response with fake peers
        const response = Buffer.alloc(26) // 20 + 6 bytes for one peer
        response.writeUInt32BE(1, 0) // action: announce
        response.writeUInt32BE(transactionId, 4)
        response.writeUInt32BE(1800, 8) // interval
        response.writeUInt32BE(3, 12) // leechers
        response.writeUInt32BE(7, 16) // seeders

        // Peer: 192.168.1.100:6881
        response.writeUInt8(192, 20)
        response.writeUInt8(168, 21)
        response.writeUInt8(1, 22)
        response.writeUInt8(100, 23)
        response.writeUInt16BE(6881, 24)

        socket.send(response, rinfo.port, rinfo.address)
      }
    })

    socket.bind(0, '127.0.0.1', () => {
      const addr = socket.address() as net.AddressInfo
      resolve({
        socket,
        port: addr.port,
        get announceCount() {
          return announceCount
        },
      })
    })
  })
}

/**
 * Mock SOCKS5 Server with UDP ASSOCIATE support
 *
 * This is needed because SSH's -D flag doesn't support UDP ASSOCIATE.
 */
function createMockSocks5Server(): Promise<{
  server: net.Server
  udpRelay: dgram.Socket
  port: number
}> {
  return new Promise((resolve) => {
    // UDP relay socket
    const udpRelay = dgram.createSocket('udp4')
    let udpRelayPort = 0

    // Track client UDP associations
    const associations = new Map<string, { clientAddr: string; clientPort: number }>()

    udpRelay.on('message', (msg, rinfo) => {
      // SOCKS5 UDP packet format:
      // RSV (2) + FRAG (1) + ATYP (1) + ADDR (variable) + PORT (2) + DATA
      if (msg.length < 10) return

      const frag = msg[2]
      if (frag !== 0) {
        console.log(dim(`  Mock SOCKS5: Dropping fragmented UDP packet`))
        return
      }

      const atyp = msg[3]
      let destAddr: string
      let destPort: number
      let dataOffset: number

      if (atyp === 0x01) {
        // IPv4
        destAddr = `${msg[4]}.${msg[5]}.${msg[6]}.${msg[7]}`
        destPort = msg.readUInt16BE(8)
        dataOffset = 10
      } else if (atyp === 0x03) {
        // Domain name
        const domainLen = msg[4]
        destAddr = msg.subarray(5, 5 + domainLen).toString('ascii')
        destPort = msg.readUInt16BE(5 + domainLen)
        dataOffset = 7 + domainLen
      } else {
        console.log(dim(`  Mock SOCKS5: Unsupported address type: ${atyp}`))
        return
      }

      const data = msg.subarray(dataOffset)
      const clientKey = `${rinfo.address}:${rinfo.port}`

      console.log(
        dim(
          `  Mock SOCKS5 UDP: Forwarding ${data.length} bytes from ${clientKey} to ${destAddr}:${destPort}`,
        ),
      )

      // Store association for return traffic
      associations.set(`${destAddr}:${destPort}`, {
        clientAddr: rinfo.address,
        clientPort: rinfo.port,
      })

      // Forward to actual destination (without SOCKS5 header)
      const forwardSocket = dgram.createSocket('udp4')
      forwardSocket.send(data, destPort, destAddr, (err) => {
        if (err) {
          console.log(red(`  Mock SOCKS5: Forward error: ${err.message}`))
          forwardSocket.close()
          return
        }
      })

      // Listen for response
      forwardSocket.on('message', (response, responseRinfo) => {
        console.log(
          dim(
            `  Mock SOCKS5 UDP: Response ${response.length} bytes from ${responseRinfo.address}:${responseRinfo.port}`,
          ),
        )

        // Wrap response in SOCKS5 UDP header
        const isIPv4 = /^\d+\.\d+\.\d+\.\d+$/.test(responseRinfo.address)
        let replyPacket: Buffer

        if (isIPv4) {
          const parts = responseRinfo.address.split('.').map(Number)
          replyPacket = Buffer.alloc(10 + response.length)
          replyPacket.writeUInt16BE(0, 0) // RSV
          replyPacket.writeUInt8(0, 2) // FRAG
          replyPacket.writeUInt8(0x01, 3) // ATYP: IPv4
          replyPacket.writeUInt8(parts[0], 4)
          replyPacket.writeUInt8(parts[1], 5)
          replyPacket.writeUInt8(parts[2], 6)
          replyPacket.writeUInt8(parts[3], 7)
          replyPacket.writeUInt16BE(responseRinfo.port, 8)
          response.copy(replyPacket, 10)
        } else {
          // For simplicity, only handle IPv4 in this mock
          forwardSocket.close()
          return
        }

        // Send back to client
        udpRelay.send(replyPacket, rinfo.port, rinfo.address)
        forwardSocket.close()
      })

      // Timeout for response
      setTimeout(() => forwardSocket.close(), 5000)
    })

    udpRelay.bind(0, '127.0.0.1', () => {
      udpRelayPort = (udpRelay.address() as net.AddressInfo).port
      console.log(dim(`  Mock SOCKS5 UDP relay listening on port ${udpRelayPort}`))
    })

    // TCP control server
    const server = net.createServer((socket) => {
      console.log(dim(`  Mock SOCKS5: New TCP connection`))
      let state: 'greeting' | 'request' | 'connected' = 'greeting'

      socket.on('data', (data) => {
        if (state === 'greeting') {
          // Greeting: VER + NMETHODS + METHODS
          if (data[0] !== 0x05) {
            socket.destroy()
            return
          }
          // Reply: no auth required
          socket.write(Buffer.from([0x05, 0x00]))
          state = 'request'
        } else if (state === 'request') {
          // Request: VER + CMD + RSV + ATYP + ADDR + PORT
          if (data[0] !== 0x05) {
            socket.destroy()
            return
          }

          const cmd = data[1]

          if (cmd === 0x01) {
            // CONNECT - forward to SSH proxy or handle directly
            // For simplicity, we'll just forward TCP connect requests

            let destAddr: string
            let destPort: number
            const atyp = data[3]

            if (atyp === 0x01) {
              // IPv4
              destAddr = `${data[4]}.${data[5]}.${data[6]}.${data[7]}`
              destPort = data.readUInt16BE(8)
            } else if (atyp === 0x03) {
              // Domain
              const domainLen = data[4]
              destAddr = data.subarray(5, 5 + domainLen).toString('ascii')
              destPort = data.readUInt16BE(5 + domainLen)
            } else {
              // Unsupported
              socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
              return
            }

            console.log(dim(`  Mock SOCKS5: CONNECT to ${destAddr}:${destPort}`))

            // Connect to destination
            const destSocket = net.connect(destPort, destAddr, () => {
              // Success reply
              const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0])
              reply.writeUInt16BE(destSocket.localPort || 0, 8)
              socket.write(reply)
              state = 'connected'

              // Pipe data
              socket.pipe(destSocket)
              destSocket.pipe(socket)
            })

            destSocket.on('error', (err) => {
              console.log(red(`  Mock SOCKS5: Connect error: ${err.message}`))
              socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
              socket.destroy()
            })
          } else if (cmd === 0x03) {
            // UDP ASSOCIATE
            console.log(dim(`  Mock SOCKS5: UDP ASSOCIATE request`))

            // Reply with relay address
            const reply = Buffer.alloc(10)
            reply.writeUInt8(0x05, 0) // VER
            reply.writeUInt8(0x00, 1) // REP: success
            reply.writeUInt8(0x00, 2) // RSV
            reply.writeUInt8(0x01, 3) // ATYP: IPv4
            // Bind address: 127.0.0.1
            reply.writeUInt8(127, 4)
            reply.writeUInt8(0, 5)
            reply.writeUInt8(0, 6)
            reply.writeUInt8(1, 7)
            // Bind port
            reply.writeUInt16BE(udpRelayPort, 8)

            socket.write(reply)
            state = 'connected'

            // Keep connection open (required for UDP ASSOCIATE)
          } else {
            // Unsupported command
            socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          }
        }
      })

      socket.on('error', (err) => {
        console.log(dim(`  Mock SOCKS5: Socket error: ${err.message}`))
      })
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo
      resolve({ server, udpRelay, port: addr.port })
    })
  })
}

/**
 * Test HTTP tracker through SOCKS5 proxy
 */
async function testHttpTracker(proxyPort: number): Promise<boolean> {
  console.log('\n' + yellow('Testing HTTP Tracker through SOCKS5...'))

  const mockTracker = await createMockHttpTracker()
  console.log(`  Mock HTTP tracker on port ${mockTracker.port}`)

  try {
    const nodeFactory = new NodeSocketFactory()
    const socks5Factory = new Socks5SocketFactory(
      nodeFactory,
      { host: PROXY_HOST, port: proxyPort },
      { proxyHttpTrackers: true, proxyUdpTrackers: false, proxyPeerConnections: false },
    )

    const engine = createMockEngine()
    const tracker = new HttpTracker(
      engine,
      `http://127.0.0.1:${mockTracker.port}/announce`,
      TEST_INFO_HASH,
      TEST_PEER_ID,
      socks5Factory,
    )

    let peersReceived = 0
    tracker.on('peersDiscovered', (peers) => {
      peersReceived = peers.length
      console.log(`  Received ${peers.length} peers`)
    })

    await tracker.announce('started', { uploaded: 0, downloaded: 0, left: 1000 })

    const stats = tracker.getStats()
    console.log(`  Status: ${stats.status}`)
    console.log(`  Seeders: ${stats.seeders}, Leechers: ${stats.leechers}`)
    console.log(`  Tracker announce count: ${mockTracker.announceCount}`)

    tracker.destroy()
    mockTracker.server.close()

    if (stats.status === 'ok' && peersReceived > 0) {
      console.log(green('  HTTP Tracker Test: PASSED'))
      return true
    } else {
      console.log(
        red(`  HTTP Tracker Test: FAILED (status=${stats.status}, peers=${peersReceived})`),
      )
      return false
    }
  } catch (err) {
    console.log(
      red(`  HTTP Tracker Test: FAILED - ${err instanceof Error ? err.message : String(err)}`),
    )
    mockTracker.server.close()
    return false
  }
}

/**
 * Test HTTPS through SOCKS5 proxy
 *
 * This tests the TLS upgrade path through the SOCKS5 tunnel.
 * We use httpbin.org to verify HTTPS works through the proxy.
 */
async function testHttpsTracker(proxyPort: number): Promise<boolean> {
  console.log('\n' + yellow('Testing HTTPS through SOCKS5 (TLS upgrade)...'))

  try {
    const nodeFactory = new NodeSocketFactory()
    const socks5Factory = new Socks5SocketFactory(
      nodeFactory,
      { host: PROXY_HOST, port: proxyPort },
      { proxyHttpTrackers: true, proxyUdpTrackers: false, proxyPeerConnections: false },
    )

    // Create a simple HTTP client to test HTTPS
    const client = new MinimalHttpClient(socks5Factory, undefined, 'http-tracker')

    // Make an HTTPS request to httpbin (echoes back the request)
    console.log(`  Making HTTPS request to httpbin.org...`)
    const response = await client.get('https://httpbin.org/get')

    // Parse the JSON response
    const responseText = new TextDecoder().decode(response)
    const json = JSON.parse(responseText)

    console.log(`  Response received: ${response.length} bytes`)
    console.log(`  Origin IP (from httpbin): ${json.origin}`)

    // Verify we got a valid response with expected fields
    if (json.url && json.origin) {
      console.log(green('  HTTPS Test: PASSED (TLS upgrade through SOCKS5 works)'))
      return true
    } else {
      console.log(red(`  HTTPS Test: FAILED - unexpected response format`))
      return false
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.log(red(`  HTTPS Test: FAILED - ${errMsg}`))
    return false
  }
}

/**
 * Test UDP tracker through SOCKS5 proxy (requires UDP ASSOCIATE support)
 */
async function testUdpTracker(_proxyPort: number): Promise<boolean> {
  console.log('\n' + yellow('Testing UDP Tracker through SOCKS5 with UDP ASSOCIATE...'))

  // Create mock UDP tracker and SOCKS5 server
  const mockTracker = await createMockUdpTracker()
  console.log(`  Mock UDP tracker on port ${mockTracker.port}`)

  // For UDP, we need our own mock SOCKS5 server since SSH doesn't support UDP ASSOCIATE
  const mockSocks5 = await createMockSocks5Server()
  console.log(`  Mock SOCKS5 server on port ${mockSocks5.port}`)

  try {
    const nodeFactory = new NodeSocketFactory()
    const socks5Factory = new Socks5SocketFactory(
      nodeFactory,
      { host: PROXY_HOST, port: mockSocks5.port }, // Use our mock SOCKS5 for UDP
      { proxyHttpTrackers: false, proxyUdpTrackers: true, proxyPeerConnections: false },
    )

    const engine = createMockEngine()
    const tracker = new UdpTracker(
      engine,
      `udp://127.0.0.1:${mockTracker.port}/announce`,
      TEST_INFO_HASH,
      TEST_PEER_ID,
      socks5Factory,
    )

    let peersReceived = 0
    let gotError = false
    tracker.on('peersDiscovered', (peers) => {
      peersReceived = peers.length
      console.log(`  Received ${peers.length} peers`)
    })
    tracker.on('error', (err) => {
      gotError = true
      console.log(red(`  Tracker error: ${err.message}`))
    })

    // Give it some time to complete
    const announcePromise = tracker.announce('started', { uploaded: 0, downloaded: 0, left: 1000 })

    // Wait for announce with timeout
    await Promise.race([
      announcePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000)),
    ])

    const stats = tracker.getStats()
    console.log(`  Status: ${stats.status}`)
    console.log(`  Tracker announce count: ${mockTracker.announceCount}`)

    tracker.destroy()
    mockTracker.socket.close()
    mockSocks5.server.close()
    mockSocks5.udpRelay.close()

    if (stats.status === 'ok' && peersReceived > 0 && !gotError) {
      console.log(green('  UDP Tracker Test: PASSED'))
      return true
    } else {
      console.log(
        red(
          `  UDP Tracker Test: FAILED (status=${stats.status}, peers=${peersReceived}, error=${gotError})`,
        ),
      )
      return false
    }
  } catch (err) {
    console.log(
      red(`  UDP Tracker Test: FAILED - ${err instanceof Error ? err.message : String(err)}`),
    )
    mockTracker.socket.close()
    mockSocks5.server.close()
    mockSocks5.udpRelay.close()
    return false
  }
}

/**
 * Test UDP tracker directly (without SOCKS5) to verify mock tracker works
 */
async function testUdpTrackerDirect(): Promise<boolean> {
  console.log('\n' + yellow('Testing UDP Tracker directly (no proxy)...'))

  const mockTracker = await createMockUdpTracker()
  console.log(`  Mock UDP tracker on port ${mockTracker.port}`)

  try {
    const nodeFactory = new NodeSocketFactory()
    const engine = createMockEngine()
    const tracker = new UdpTracker(
      engine,
      `udp://127.0.0.1:${mockTracker.port}/announce`,
      TEST_INFO_HASH,
      TEST_PEER_ID,
      nodeFactory, // Direct, no proxy
    )

    let peersReceived = 0
    tracker.on('peersDiscovered', (peers) => {
      peersReceived = peers.length
      console.log(`  Received ${peers.length} peers`)
    })

    await tracker.announce('started', { uploaded: 0, downloaded: 0, left: 1000 })

    const stats = tracker.getStats()
    console.log(`  Status: ${stats.status}`)
    console.log(`  Tracker announce count: ${mockTracker.announceCount}`)

    tracker.destroy()
    mockTracker.socket.close()

    if (stats.status === 'ok' && peersReceived > 0) {
      console.log(green('  UDP Tracker Direct Test: PASSED'))
      return true
    } else {
      console.log(
        red(`  UDP Tracker Direct Test: FAILED (status=${stats.status}, peers=${peersReceived})`),
      )
      return false
    }
  } catch (err) {
    console.log(
      red(
        `  UDP Tracker Direct Test: FAILED - ${err instanceof Error ? err.message : String(err)}`,
      ),
    )
    mockTracker.socket.close()
    return false
  }
}

/**
 * Main test runner
 */
async function main() {
  console.log('SOCKS5 Tracker Integration Tests')
  console.log('=================================')
  console.log(`Proxy: ${PROXY_HOST}:${PROXY_PORT}`)
  console.log('')

  const results: { test: string; passed: boolean }[] = []

  // First test UDP tracker directly to verify mock works
  if (!httpOnly && !httpsOnly) {
    results.push({ test: 'UDP Direct', passed: await testUdpTrackerDirect() })
  }

  if (!httpsOnly && !udpOnly) {
    results.push({ test: 'HTTP via SOCKS5', passed: await testHttpTracker(PROXY_PORT) })
  }

  if (!httpOnly && !udpOnly) {
    results.push({ test: 'HTTPS via SOCKS5', passed: await testHttpsTracker(PROXY_PORT) })
  }

  if (!httpOnly && !httpsOnly) {
    results.push({ test: 'UDP via SOCKS5', passed: await testUdpTracker(PROXY_PORT) })
  }

  // Summary
  console.log('\n' + '='.repeat(40))
  console.log('Summary:')
  for (const r of results) {
    console.log(`  ${r.passed ? green('PASS') : red('FAIL')}: ${r.test}`)
  }

  const allPassed = results.every((r) => r.passed)
  console.log('')
  console.log(allPassed ? green('All tests passed!') : red('Some tests failed'))

  process.exit(allPassed ? 0 : 1)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
