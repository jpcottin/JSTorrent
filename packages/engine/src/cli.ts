/**
 * JSTorrent CLI - Download torrents from the command line.
 *
 * Usage:
 *   jstorrent "magnet:?xt=urn:btih:..." --download-path ./downloads
 *   jstorrent ./file.torrent -o ./downloads
 *   jstorrent --help
 */

import * as fs from 'fs'
import * as path from 'path'
import { createNodeEngine, NodeEngineConfig } from './presets/node'
import { VERSION } from './version'
import { infoHashFromBytes } from './utils/infohash'
import { Torrent } from './core/torrent'

interface CliOptions {
  input: string
  downloadPath: string
  port: number
  maxConnections: number
  verbose: boolean
  seed: boolean
}

function parseArgs(): CliOptions | null {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp()
    return null
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(`jstorrent ${VERSION}`)
    return null
  }

  let input = ''
  let downloadPath = process.cwd()
  let port = 6881
  let maxConnections = 50
  let verbose = false
  let seed = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--download-path':
      case '-o':
        downloadPath = args[++i]
        break
      case '--port':
      case '-p':
        port = parseInt(args[++i], 10)
        break
      case '--max-connections':
      case '-c':
        maxConnections = parseInt(args[++i], 10)
        break
      case '--verbose':
        verbose = true
        break
      case '--seed':
      case '-s':
        seed = true
        break
      default:
        if (!arg.startsWith('-')) {
          input = arg
        } else {
          console.error(`Unknown option: ${arg}`)
          process.exit(1)
        }
    }
  }

  if (!input) {
    console.error('Error: No torrent input specified')
    printHelp()
    process.exit(1)
  }

  return { input, downloadPath, port, maxConnections, verbose, seed }
}

function printHelp() {
  console.log(`
jstorrent ${VERSION} - BitTorrent client for Node.js

Usage:
  jstorrent <magnet-link-or-torrent-file> [options]

Arguments:
  <input>                  Magnet link or path to .torrent file

Options:
  -o, --download-path <path>  Download directory (default: current directory)
  -p, --port <port>           Listen port (default: 6881)
  -c, --max-connections <n>   Max peer connections (default: 50)
  -s, --seed                  Continue seeding after download completes
  --verbose                   Show detailed logs
  -v, --version               Show version
  -h, --help                  Show this help

Examples:
  jstorrent "magnet:?xt=urn:btih:..." -o ~/Downloads
  jstorrent ./ubuntu.torrent --download-path /data
  jstorrent "magnet:?..." --seed --verbose
`)
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

function formatEta(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return '--:--'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m}:${s.toString().padStart(2, '0')}`
}

function getTotalSize(torrent: Torrent): number {
  // Calculate from piece info: (piecesCount - 1) * pieceLength + lastPieceLength
  if (torrent.piecesCount === 0) return 0
  return (torrent.piecesCount - 1) * torrent.pieceLength + torrent.lastPieceLength
}

function printProgress(torrent: Torrent) {
  const progress = (torrent.progress * 100).toFixed(1)
  const downloaded = formatBytes(torrent.totalDownloaded)
  const totalSize = getTotalSize(torrent)
  const total = totalSize > 0 ? formatBytes(totalSize) : '?'
  const downSpeed = formatSpeed(torrent.downloadSpeed)
  const upSpeed = formatSpeed(torrent.uploadSpeed)
  const peers = torrent.numPeers
  const remaining = totalSize - torrent.totalDownloaded
  const eta =
    torrent.downloadSpeed > 0 && remaining > 0
      ? formatEta(remaining / torrent.downloadSpeed)
      : '--:--'

  // Clear line and print progress
  process.stdout.write(
    `\r${progress}% | ${downloaded}/${total} | ↓${downSpeed} ↑${upSpeed} | ${peers} peers | ETA: ${eta}   `,
  )
}

async function main() {
  const options = parseArgs()
  if (!options) {
    process.exit(0)
  }

  // Ensure download path exists
  if (!fs.existsSync(options.downloadPath)) {
    fs.mkdirSync(options.downloadPath, { recursive: true })
  }

  const config: NodeEngineConfig = {
    downloadPath: path.resolve(options.downloadPath),
    port: options.port,
    maxConnections: options.maxConnections,
  }

  if (options.verbose) {
    config.onLog = (entry) => {
      console.log(`[${entry.level}] ${entry.message}`)
    }
  }

  console.log(`JSTorrent ${VERSION}`)
  console.log(`Download path: ${config.downloadPath}`)

  const engine = createNodeEngine(config)

  // Determine input type
  let torrentInput: string | Uint8Array
  if (options.input.startsWith('magnet:')) {
    torrentInput = options.input
    console.log('Adding magnet link...')
  } else {
    // Read torrent file
    const torrentPath = path.resolve(options.input)
    if (!fs.existsSync(torrentPath)) {
      console.error(`Error: File not found: ${torrentPath}`)
      process.exit(1)
    }
    torrentInput = fs.readFileSync(torrentPath)
    console.log(`Adding torrent file: ${torrentPath}`)
  }

  const result = await engine.addTorrent(torrentInput)
  if (!result.torrent) {
    console.error('Failed to add torrent')
    process.exit(1)
  }

  const torrent = result.torrent
  const infoHash = infoHashFromBytes(torrent.infoHash)
  console.log(`Info hash: ${infoHash}`)

  // Wait for metadata if needed
  if (!torrent.metadataComplete) {
    console.log('Fetching metadata from peers...')
    await new Promise<void>((resolve) => {
      const checkMetadata = () => {
        if (torrent.metadataComplete) {
          resolve()
        } else {
          setTimeout(checkMetadata, 500)
        }
      }
      checkMetadata()
    })
  }

  console.log(`Name: ${torrent.name}`)
  console.log(`Size: ${formatBytes(getTotalSize(torrent))}`)
  console.log(`Files: ${torrent.files.length}`)
  console.log('')

  // Progress loop
  let lastProgress = -1
  const progressInterval = setInterval(() => {
    printProgress(torrent)

    // Check if complete
    if (torrent.progress >= 1.0 && lastProgress < 1.0) {
      console.log('\n\nDownload complete!')
      if (!options.seed) {
        clearInterval(progressInterval)
        cleanup()
      } else {
        console.log('Seeding... (press Ctrl+C to stop)')
      }
    }
    lastProgress = torrent.progress
  }, 500)

  const cleanup = async () => {
    clearInterval(progressInterval)
    console.log('\nShutting down...')
    await engine.destroy()
    process.exit(0)
  }

  // Handle signals
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
