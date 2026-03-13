import fs from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

const SCRIPT_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)))
const SANDBOX_ASSET_DIR = resolve(SCRIPT_DIR, '../packages/client/search-plugin-sandbox')

function loadSandboxAsset(fileName) {
  return fs.readFileSync(resolve(SANDBOX_ASSET_DIR, fileName), 'utf-8')
}

export function sharedSearchPluginSandboxAssets() {
  const assets = [
    {
      fileName: 'search-plugin-sandbox.html',
      source: loadSandboxAsset('search-plugin-sandbox.html'),
      contentType: 'text/html; charset=utf-8',
    },
    {
      fileName: 'search-plugin-sandbox.js',
      source: loadSandboxAsset('search-plugin-sandbox.js'),
      contentType: 'application/javascript; charset=utf-8',
    },
  ]

  return {
    name: 'shared-search-plugin-sandbox-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const requestPath = req.url ? req.url.split('?')[0] : ''
        const asset = assets.find((entry) => `/${entry.fileName}` === requestPath)
        if (!asset) {
          next()
          return
        }

        res.statusCode = 200
        res.setHeader('Content-Type', asset.contentType)
        res.end(asset.source)
      })
    },
    generateBundle() {
      for (const asset of assets) {
        this.emitFile({
          type: 'asset',
          fileName: asset.fileName,
          source: asset.source,
        })
      }
    },
  }
}
