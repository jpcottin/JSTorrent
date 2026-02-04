# @jstorrent/engine

BitTorrent client for Node.js. Download torrents from the command line or use as a library.

## CLI Usage

```bash
# Install globally
npm install -g @jstorrent/engine

# Download a torrent
jstorrent "magnet:?xt=urn:btih:..." -o ~/Downloads
jstorrent ./file.torrent --download-path /data

# Continue seeding after download
jstorrent "magnet:?..." --seed

# Show help
jstorrent --help
```

### CLI Options

```
-o, --download-path <path>  Download directory (default: current directory)
-p, --port <port>           Listen port (default: 6881)
-c, --max-connections <n>   Max peer connections (default: 50)
-s, --seed                  Continue seeding after download completes
--verbose                   Show detailed logs
-v, --version               Show version
-h, --help                  Show help
```

## Library Usage

```typescript
import { createNodeEngine } from '@jstorrent/engine/presets/node'

const engine = createNodeEngine({
  downloadPath: './downloads',
  port: 6881,
})

const { torrent } = await engine.addTorrent('magnet:?xt=urn:btih:...')

// Wait for completion
while (torrent.progress < 1.0) {
  console.log(`${(torrent.progress * 100).toFixed(1)}%`)
  await new Promise(r => setTimeout(r, 1000))
}

console.log('Download complete!')
await engine.destroy()
```

## Features

- Full BitTorrent protocol (BEP 3, 5, 6, 9, 10, 23, 29)
- DHT for trackerless peer discovery
- HTTP, HTTPS, and UDP tracker support
- Message Stream Encryption (MSE/PE)
- SOCKS5 proxy support
- Session persistence for resume capability
- Multi-file torrent support

## License

MIT
