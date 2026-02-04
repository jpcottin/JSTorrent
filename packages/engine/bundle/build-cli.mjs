#!/usr/bin/env node
/**
 * Build Script for CLI Bundle
 *
 * Usage: node bundle/build-cli.mjs
 */

import esbuild from 'esbuild'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8'))

async function build() {
  console.log('Building CLI bundle...')

  try {
    const result = await esbuild.build({
      entryPoints: [path.join(__dirname, '../src/cli.ts')],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'esm',
      outfile: path.join(__dirname, '../dist/cli.js'),
      banner: {
        js: '#!/usr/bin/env node',
      },
      external: [],
      minify: false,
      sourcemap: false,
      define: {
        JSTORRENT_VERSION: JSON.stringify(packageJson.version),
      },
    })

    if (result.errors.length > 0) {
      console.error('Build failed with errors:')
      result.errors.forEach((err) => console.error(err))
      process.exit(1)
    }

    // Make executable
    const outfile = path.join(__dirname, '../dist/cli.js')
    fs.chmodSync(outfile, 0o755)

    // Log output size
    const stat = fs.statSync(outfile)
    const sizeKB = (stat.size / 1024).toFixed(1)
    console.log(`\nBuild complete: dist/cli.js`)
    console.log(`  Size: ${sizeKB} KB`)
    console.log(`  Version: ${packageJson.version}`)
  } catch (err) {
    console.error('Build failed:', err)
    process.exit(1)
  }
}

build()
