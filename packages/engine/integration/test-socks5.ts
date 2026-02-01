/**
 * Simple SOCKS5 Proxy Test Script
 *
 * Prerequisites:
 * 1. Start test seeder: pnpm seed-for-test
 * 2. Start SSH SOCKS5 proxy: ssh -vND 0.0.0.0:8080 localhost
 *
 * Run with: npx tsx integration/test-socks5.ts
 */

import * as net from 'net'
import * as os from 'os'
import {
  buildGreeting,
  buildConnectRequest,
  parseGreetingResponse,
  parseConnectReply,
  getConnectResponseLength,
  getReplyError,
  SOCKS5_AUTH,
  SOCKS5_REPLY,
} from '../src/proxy/socks5-protocol.js'

const PROXY_HOST = '127.0.0.1'
const PROXY_PORT = 8080

// Target: test seeder
const TARGET_HOST = '127.0.0.1'
const TARGET_PORT = 6881

async function testSocks5Connection(targetHost: string, targetPort: number): Promise<void> {
  console.log(`\n=== Testing SOCKS5 connection to ${targetHost}:${targetPort} ===`)

  const socket = new net.Socket()
  let state: 'greeting' | 'connect' | 'done' = 'greeting'
  let buffer = Buffer.alloc(0)

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('Timeout'))
    }, 10000)

    socket.on('connect', () => {
      console.log('Connected to proxy')

      // Send greeting
      const greeting = buildGreeting(false)
      console.log('Sending greeting:', Buffer.from(greeting).toString('hex'))
      socket.write(greeting)
    })

    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data])
      console.log(`Received data (state=${state}):`, buffer.toString('hex'))

      if (state === 'greeting') {
        const method = parseGreetingResponse(new Uint8Array(buffer))
        if (method === null) {
          console.log('Need more data for greeting response')
          return
        }

        console.log('Greeting response method:', method)
        if (method === SOCKS5_AUTH.NO_ACCEPTABLE) {
          socket.destroy()
          reject(new Error('No acceptable auth method'))
          return
        }

        // Send CONNECT request
        buffer = buffer.slice(2)
        state = 'connect'

        const connectRequest = buildConnectRequest(targetHost, targetPort)
        console.log('Sending CONNECT request:', Buffer.from(connectRequest).toString('hex'))
        console.log('  Breakdown:')
        console.log('    Version:', connectRequest[0])
        console.log('    Command:', connectRequest[1])
        console.log('    Reserved:', connectRequest[2])
        console.log(
          '    ATYP:',
          connectRequest[3],
          connectRequest[3] === 1 ? '(IPv4)' : connectRequest[3] === 3 ? '(DOMAIN)' : '(?)',
        )
        socket.write(connectRequest)
      } else if (state === 'connect') {
        const responseLen = getConnectResponseLength(new Uint8Array(buffer))
        if (responseLen === null || buffer.length < responseLen) {
          console.log(
            'Need more data for connect response, need',
            responseLen,
            'have',
            buffer.length,
          )
          return
        }

        const reply = parseConnectReply(new Uint8Array(buffer))
        console.log('CONNECT reply code:', reply)

        if (reply === SOCKS5_REPLY.SUCCESS) {
          console.log('✓ SOCKS5 connection successful!')
          state = 'done'
          clearTimeout(timeout)
          socket.destroy()
          resolve()
        } else {
          const errorMsg = getReplyError(reply!)
          console.log('✗ SOCKS5 connection failed:', errorMsg)
          socket.destroy()
          reject(new Error(errorMsg || `Reply code ${reply}`))
        }
      }
    })

    socket.on('error', (err) => {
      clearTimeout(timeout)
      console.error('Socket error:', err.message)
      reject(err)
    })

    socket.on('close', () => {
      clearTimeout(timeout)
      if (state !== 'done') {
        reject(new Error('Connection closed before completion'))
      }
    })

    console.log(`Connecting to proxy ${PROXY_HOST}:${PROXY_PORT}...`)
    socket.connect(PROXY_PORT, PROXY_HOST)
  })
}

async function main() {
  console.log('SOCKS5 Proxy Integration Test')
  console.log('=============================')

  try {
    // Test 1: Connect to localhost (127.0.0.1 - IPv4)
    await testSocks5Connection('127.0.0.1', TARGET_PORT)

    // Test 2: Connect to localhost hostname (DOMAIN)
    await testSocks5Connection('localhost', TARGET_PORT)

    // Test 3: Connect to local IP (e.g., machine's actual IP)
    // Get local IP
    const nets = os.networkInterfaces()
    let localIP: string | undefined
    for (const name of Object.keys(nets)) {
      for (const iface of nets[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          localIP = iface.address
          break
        }
      }
      if (localIP) break
    }

    if (localIP) {
      await testSocks5Connection(localIP, TARGET_PORT)
    }

    console.log('\n=============================')
    console.log('All tests passed!')
  } catch (err) {
    console.error('\n=============================')
    console.error('Test failed:', err)
    process.exit(1)
  }
}

main()
