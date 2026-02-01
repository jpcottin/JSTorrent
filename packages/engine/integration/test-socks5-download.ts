/**
 * SOCKS5 Proxy Download Test
 *
 * Tests that we can actually download a torrent through the SOCKS5 proxy.
 *
 * Prerequisites:
 * 1. Start test seeder: pnpm seed-for-test
 * 2. Start SSH SOCKS5 proxy: ssh -vND 0.0.0.0:8080 localhost
 *
 * Run with: npx tsx integration/test-socks5-download.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createNodeEngine } from '../src/presets/node.js'
import { MemoryConfigHub } from '../src/config/memory-config-hub.js'
import { MemorySessionStore } from '../src/adapters/memory/memory-session-store.js'

// Proxy config
const PROXY_HOST = '127.0.0.1'
const PROXY_PORT = 8080

// Test seeder magnet (from pnpm seed-for-test --size 100mb)
// Use x.pe peer hint to connect directly to seeder
const TEST_MAGNET =
  'magnet:?xt=urn:btih:67d01ece1b99c49c257baada0f760b770a7530b9&dn=testdata_100mb.bin&x.pe=127.0.0.1:6881'

async function main() {
  console.log('SOCKS5 Proxy Download Test')
  console.log('==========================')
  console.log(`Proxy: ${PROXY_HOST}:${PROXY_PORT}`)
  console.log('')

  // Create temp directory for downloads
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'socks5-test-'))
  console.log(`Download dir: ${tmpDir}`)

  // Create ConfigHub with proxy settings
  const config = new MemoryConfigHub({
    proxyEnabled: true,
    proxyHost: PROXY_HOST,
    proxyPort: PROXY_PORT,
    proxyPeerConnections: true,
    proxyHttpTrackers: true,
    proxyUdpTrackers: false, // SSH proxy doesn't support UDP
  })

  console.log('Proxy settings:')
  console.log(`  enabled: ${config.proxyEnabled.get()}`)
  console.log(`  host: ${config.proxyHost.get()}`)
  console.log(`  port: ${config.proxyPort.get()}`)
  console.log(`  proxyPeerConnections: ${config.proxyPeerConnections.get()}`)
  console.log(`  proxyHttpTrackers: ${config.proxyHttpTrackers.get()}`)
  console.log(`  proxyUdpTrackers: ${config.proxyUdpTrackers.get()}`)
  console.log('')

  // Create engine with proxy config - use different port than seeder
  const engine = createNodeEngine({
    downloadPath: tmpDir,
    sessionStore: new MemorySessionStore(),
    config,
    port: 16881, // Different from seeder's 6881
    onLog: (entry) => {
      // Print all logs for debugging
      console.log(`[${entry.component}] ${entry.message}`)
    },
  })

  console.log('Engine created, resuming...')
  engine.resume()
  console.log('Engine resumed')
  console.log('')

  // Add the test torrent
  console.log('Adding torrent...')
  console.log(`Magnet: ${TEST_MAGNET}`)

  const { torrent } = await engine.addTorrent(TEST_MAGNET)
  console.log(`Torrent added: ${torrent.infoHashStr}`)
  console.log('')

  // Monitor progress
  let lastProgress = -1
  let bytesReceived = 0
  let peersConnected = 0
  const startTime = Date.now()
  const timeout = 30000 // 30 second timeout

  console.log('Monitoring download progress...')
  console.log('(Press Ctrl+C to stop)')
  console.log('')

  const checkProgress = () => {
    const progress = torrent.progress
    const downloaded = torrent.totalDownloaded
    const peers = torrent.numPeers
    const speed = torrent.downloadSpeed
    const swarm = torrent.swarm
    const elapsed = Date.now() - startTime

    if (downloaded !== bytesReceived || peers !== peersConnected) {
      bytesReceived = downloaded
      peersConnected = peers
      console.log(
        `[${(elapsed / 1000).toFixed(1)}s] ` +
          `Progress: ${(progress * 100).toFixed(1)}% | ` +
          `Downloaded: ${bytesReceived} bytes | ` +
          `Peers: ${peersConnected} (swarm: ${swarm.total}) | ` +
          `Speed: ${(speed / 1024).toFixed(1)} KB/s`,
      )
    }

    if (progress !== lastProgress && Math.floor(progress * 10) !== lastProgress) {
      lastProgress = Math.floor(progress * 10)
    }

    if (progress >= 1) {
      console.log('')
      console.log('✓ Download complete!')
      cleanup()
      return
    }

    if (elapsed > timeout) {
      console.log('')
      if (bytesReceived > 0) {
        console.log(`✓ Test PASSED: Downloaded ${bytesReceived} bytes through proxy`)
      } else {
        console.log('✗ Test FAILED: No bytes received within timeout')
        console.log('')
        console.log('Debug info:')
        console.log(`  Swarm total: ${swarm.total}`)
        console.log(`  Swarm connected: ${swarm.connected}`)
        console.log(`  Swarm connecting: ${swarm.connecting}`)
        console.log(`  Activity state: ${torrent.activityState}`)
      }
      cleanup()
      return
    }

    setTimeout(checkProgress, 1000)
  }

  const cleanup = async () => {
    console.log('')
    console.log('Cleaning up...')
    await engine.destroy()

    // Clean up temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore
    }

    console.log('Done')
    process.exit(bytesReceived > 0 ? 0 : 1)
  }

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log('')
    console.log('Interrupted')
    cleanup()
  })

  checkProgress()
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
