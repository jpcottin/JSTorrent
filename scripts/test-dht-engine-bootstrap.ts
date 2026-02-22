#!/usr/bin/env npx tsx
/**
 * Test DHT bootstrap using the actual JSTorrent engine code.
 * This uses the real DHTNode, KRPCSocket, NodeSocketFactory, and Bencode
 * to verify that the full stack can bootstrap from the real DHT network.
 *
 * Usage: npx tsx scripts/test-dht-engine-bootstrap.ts
 */

import { DHTNode } from '../packages/engine/src/dht/dht-node'
import { NodeSocketFactory } from '../packages/engine/src/adapters/node/node-socket'
import { BOOTSTRAP_NODES } from '../packages/engine/src/dht/constants'
import {
  encodeFindNodeQuery,
  decodeMessage,
  getResponseNodes,
  getResponseNodeId,
} from '../packages/engine/src/dht/krpc-messages'
import { generateRandomNodeId, nodeIdToHex } from '../packages/engine/src/dht/xor-distance'
import { KRPCSocket } from '../packages/engine/src/dht/krpc-socket'
import type { Logger } from '../packages/engine/src/logging/logger'

// Simple console logger that implements the Logger interface
const logger: Logger = {
  trace: (...args: unknown[]) => console.log('[TRACE]', ...args),
  debug: (...args: unknown[]) => console.log('[DEBUG]', ...args),
  info: (...args: unknown[]) => console.log('[INFO]', ...args),
  warn: (...args: unknown[]) => console.warn('[WARN]', ...args),
  error: (...args: unknown[]) => console.error('[ERROR]', ...args),
}

async function testRawKRPC() {
  console.log('=== Test 1: Raw KRPC query using engine code ===\n')

  const socketFactory = new NodeSocketFactory()
  const krpc = new KRPCSocket(socketFactory, {
    timeout: 10_000,
    rateLimitEnabled: false,
  })

  await krpc.bind()
  console.log('KRPC socket bound successfully')

  const nodeId = generateRandomNodeId()
  console.log(`Our node ID: ${nodeIdToHex(nodeId).slice(0, 16)}...`)

  // Try each bootstrap node individually
  for (const { host, port } of BOOTSTRAP_NODES) {
    const transactionId = krpc.generateTransactionId()
    const queryData = encodeFindNodeQuery(transactionId, nodeId, nodeId)
    console.log(`\nQuerying ${host}:${port} (${queryData.length} bytes)...`)

    try {
      const response = await krpc.query(host, port, queryData, transactionId, 'find_node')
      const responderId = getResponseNodeId(response)
      const nodes = getResponseNodes(response)
      console.log(`  ✓ Response from ${host}:${port}`)
      console.log(
        `    Responder ID: ${responderId ? nodeIdToHex(responderId).slice(0, 16) + '...' : 'none'}`,
      )
      console.log(`    Nodes returned: ${nodes.length}`)
      for (const node of nodes.slice(0, 5)) {
        console.log(`      ${node.host}:${node.port} (${nodeIdToHex(node.id).slice(0, 16)}...)`)
      }
    } catch (err) {
      console.log(`  ✗ ${host}:${port} - ${err instanceof Error ? err.message : err}`)
    }
  }

  krpc.close()
  console.log('\nKRPC socket closed')
}

async function testFullBootstrap() {
  console.log('\n=== Test 2: Full DHTNode bootstrap ===\n')

  const socketFactory = new NodeSocketFactory()
  const dhtNode = new DHTNode({
    socketFactory,
    logger,
    skipMaintenance: true,
    krpcOptions: {
      timeout: 10_000,
      rateLimitEnabled: false,
    },
  })

  await dhtNode.start()
  console.log(`DHT node started with ID: ${dhtNode.nodeIdHex.slice(0, 16)}...`)

  console.log('Bootstrapping...\n')
  const stats = await dhtNode.bootstrap({ maxRetries: 0 })

  console.log('\n--- Bootstrap Results ---')
  console.log(`  Queried:     ${stats.queriedCount}`)
  console.log(`  Responses:   ${stats.responsesReceived}`)
  console.log(`  Failures:    ${stats.failures}`)
  console.log(`  RT size:     ${stats.routingTableSize}`)
  console.log(`  Duration:    ${stats.durationMs}ms`)

  // Show some routing table contents
  const allNodes = dhtNode.getAllNodes()
  console.log(`\nRouting table contains ${allNodes.length} nodes:`)
  for (const node of allNodes.slice(0, 10)) {
    console.log(`  ${node.host}:${node.port} (${nodeIdToHex(node.id).slice(0, 16)}...)`)
  }

  dhtNode.stop()
  console.log('\nDHT node stopped')
}

async function main() {
  try {
    await testRawKRPC()
    await testFullBootstrap()
  } catch (err) {
    console.error('Fatal error:', err)
    process.exit(1)
  }
  process.exit(0)
}

main()
