import { readFileSync } from 'node:fs'
import { loadPlugin } from '../../runtime/load-module.js'
import { normalizeSearchPluginManifest } from '../../validation/manifest.js'
import { formatManifest } from '../format.js'

export function runInspect(filePath: string): void {
  const source = readFileSync(filePath, 'utf-8')

  let module
  try {
    module = loadPlugin(source)
  } catch (error) {
    console.error(
      `Failed to load plugin: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
    return
  }

  try {
    const manifest = normalizeSearchPluginManifest(module.manifest)
    console.log(formatManifest(manifest))
  } catch (error) {
    console.error(`Manifest error: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
