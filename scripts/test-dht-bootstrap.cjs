#!/usr/bin/env node

/**
 * Test DHT bootstrap node reachability.
 * Sends a find_node query to each bootstrap node and reports which ones respond.
 *
 * Usage: node scripts/test-dht-bootstrap.js
 */

const dgram = require('dgram')
const crypto = require('crypto')
const dns = require('dns')

// Minimal bencode encoder (no dependencies)
function bencode(obj) {
  if (Buffer.isBuffer(obj) || obj instanceof Uint8Array) {
    return Buffer.concat([Buffer.from(obj.length + ':'), Buffer.from(obj)])
  }
  if (typeof obj === 'string') {
    return Buffer.from(obj.length + ':' + obj)
  }
  if (typeof obj === 'number') {
    return Buffer.from('i' + obj + 'e')
  }
  if (Array.isArray(obj)) {
    return Buffer.concat([Buffer.from('l'), ...obj.map(bencode), Buffer.from('e')])
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort()
    const parts = [Buffer.from('d')]
    for (const key of keys) {
      parts.push(bencode(key))
      parts.push(bencode(obj[key]))
    }
    parts.push(Buffer.from('e'))
    return Buffer.concat(parts)
  }
}

const BOOTSTRAP_NODES = [
  { host: 'router.bittorrent.com', port: 6881 },
  { host: 'router.utorrent.com', port: 6881 },
  { host: 'dht.transmissionbt.com', port: 6881 },
  { host: 'dht.libtorrent.org', port: 25401 },
]

const TIMEOUT_MS = 10_000

const socket = dgram.createSocket('udp4')
const nodeId = crypto.randomBytes(20)
const responded = new Set()
const dnsResults = new Map()
let tidCounter = 0

// Resolve DNS for all nodes first
const dnsPromises = BOOTSTRAP_NODES.map(
  ({ host }) =>
    new Promise((resolve) => {
      dns.resolve4(host, (err, addresses) => {
        if (err) {
          dnsResults.set(host, `FAILED: ${err.code}`)
        } else {
          dnsResults.set(host, addresses.join(', '))
        }
        resolve()
      })
    }),
)

socket.on('message', (msg, rinfo) => {
  const key = `${rinfo.address}:${rinfo.port}`
  const matchingNode = BOOTSTRAP_NODES.find((n) => {
    const resolved = dnsResults.get(n.host)
    return resolved && resolved.includes(rinfo.address) && n.port === rinfo.port
  })
  const label = matchingNode ? `${matchingNode.host}:${matchingNode.port}` : key

  // Try to count nodes in response
  let nodeCount = '?'
  try {
    // Find "nodes" value - it's a compact node info string (26 bytes per node)
    // Look for "5:nodes" followed by length-prefixed bytes
    const nodesMarker = Buffer.from('5:nodes')
    const idx = msg.indexOf(nodesMarker)
    if (idx !== -1) {
      // Parse bencode string length after "5:nodes"
      const afterMarker = idx + nodesMarker.length
      const colonIdx = msg.indexOf(0x3a, afterMarker) // ':'
      if (colonIdx !== -1) {
        const len = parseInt(msg.slice(afterMarker, colonIdx).toString())
        nodeCount = String(Math.floor(len / 26))
      }
    }
  } catch {
    // ignore parse errors
  }

  responded.add(label)
  console.log(`  ✓ ${label} → ${msg.length} bytes, ~${nodeCount} nodes`)
})

async function main() {
  await Promise.all(dnsPromises)

  console.log('DNS resolution:')
  for (const { host } of BOOTSTRAP_NODES) {
    console.log(`  ${host} → ${dnsResults.get(host)}`)
  }
  console.log()

  // Send find_node to each bootstrap node
  console.log(`Sending find_node queries (timeout: ${TIMEOUT_MS / 1000}s)...`)
  for (const { host, port } of BOOTSTRAP_NODES) {
    tidCounter++
    const tid = Buffer.from([tidCounter >> 8, tidCounter & 0xff])
    const query = { a: { id: nodeId, target: nodeId }, q: 'find_node', t: tid, y: 'q' }
    const encoded = bencode(query)

    socket.send(encoded, port, host, (err) => {
      if (err) console.log(`  ✗ ${host}:${port} send error: ${err.message}`)
    })
  }

  // Wait for responses
  await new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS))

  console.log()
  console.log('Summary:')
  for (const { host, port } of BOOTSTRAP_NODES) {
    const label = `${host}:${port}`
    if (responded.has(label)) {
      console.log(`  ✓ ${label} - reachable`)
    } else {
      console.log(`  ✗ ${label} - NO RESPONSE (port may be blocked)`)
    }
  }

  const reachable = responded.size
  const total = BOOTSTRAP_NODES.length
  console.log()
  if (reachable === 0) {
    console.log(`RESULT: 0/${total} nodes reachable. DHT bootstrap will fail.`)
    console.log('Likely cause: UDP port 6881 is blocked by firewall/ISP.')
  } else if (reachable < total) {
    console.log(`RESULT: ${reachable}/${total} nodes reachable. DHT bootstrap should work.`)
  } else {
    console.log(`RESULT: All ${total} nodes reachable. DHT bootstrap should work well.`)
  }

  socket.close()
  process.exit(reachable > 0 ? 0 : 1)
}

main()
