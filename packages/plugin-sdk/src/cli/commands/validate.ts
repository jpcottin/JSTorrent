import { readFileSync } from 'node:fs'
import { loadPlugin } from '../../runtime/load-module.js'
import { normalizeSearchPluginManifest } from '../../validation/manifest.js'
import { validateModuleSource } from '../../validation/source.js'
import { formatManifest } from '../format.js'

export function runValidate(filePath: string): void {
  const source = readFileSync(filePath, 'utf-8')

  const sourceResult = validateModuleSource(source)
  if (!sourceResult.valid) {
    console.error('Source validation failed:')
    for (const error of sourceResult.errors) {
      console.error(`  - ${error}`)
    }
    process.exitCode = 1
    return
  }

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
    console.log(`\nExports:  ${sourceResult.exportedNames.join(', ')}`)
    console.log(`Search:   ${typeof module.search === 'function' ? 'OK' : 'MISSING'}`)
    console.log('\nValidation passed.')
  } catch (error) {
    console.error(
      `Manifest validation failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  }
}
