import { defineConfig } from 'astro/config'
import react from '@astrojs/react'
import solidJs from '@astrojs/solid-js'
import sitemap from '@astrojs/sitemap'
import { resolve } from 'path'

const __dirname = new URL('.', import.meta.url).pathname

export default defineConfig({
  site: 'https://jstorrent.com',
  integrations: [
    solidJs({ include: ['**/*.solid.tsx'] }),
    react({ include: ['**/*.tsx'], exclude: ['**/*.solid.tsx'] }),
    sitemap(),
  ],
  server: {
    port: 3000,
    host: true,
    allowedHosts: true,
  },
  vite: {
    server: {
      strictPort: true,
    },
    resolve: {
      alias: {
        '@jstorrent/engine': resolve(__dirname, '../packages/engine/src'),
        '@jstorrent/client/core': resolve(__dirname, '../packages/client/src/core'),
        '@jstorrent/client': resolve(__dirname, '../packages/client/src'),
        '@jstorrent/ui/piece-visualization': resolve(
          __dirname,
          '../packages/ui/src/components/PieceVisualization.tsx',
        ),
        '@jstorrent/ui': resolve(__dirname, '../packages/ui/src'),
      },
    },
  },
})
