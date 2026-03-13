import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import solid from 'vite-plugin-solid'
import { resolve } from 'path'
import fs from 'fs'
import { sharedSearchPluginSandboxAssets } from '../../scripts/vite-search-plugin-sandbox-assets.mjs'

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST

const packageJson = JSON.parse(fs.readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))

// Ensure GeoIP data file exists (copy stub if not)
const geoipDataPath = resolve(__dirname, '../../packages/engine/src/geo/ipv4-country-data.ts')
const geoipStubPath = resolve(__dirname, '../../packages/engine/src/geo/ipv4-country-data.stub.ts')
if (!fs.existsSync(geoipDataPath) && fs.existsSync(geoipStubPath)) {
  fs.copyFileSync(geoipStubPath, geoipDataPath)
  console.log('Copied GeoIP stub to ipv4-country-data.ts (run pnpm update-geoip for real data)')
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    // Solid plugin MUST come first, only for .solid.tsx files
    solid({
      include: ['**/*.solid.tsx'],
      solid: {
        generate: 'dom',
      },
    }),
    // React plugin for all other .tsx files
    react({
      exclude: ['**/*.solid.tsx'],
    }),
    sharedSearchPluginSandboxAssets(),
  ],
  resolve: {
    alias: {
      '@jstorrent/engine': resolve(__dirname, '../../packages/engine/src'),
      '@jstorrent/client/core': resolve(__dirname, '../../packages/client/src/core'),
      '@jstorrent/client': resolve(__dirname, '../../packages/client/src'),
      '@jstorrent/ui': resolve(__dirname, '../../packages/ui/src'),
    },
  },
  define: {
    'import.meta.env.PACKAGE_VERSION': JSON.stringify(packageJson.version),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
}))
