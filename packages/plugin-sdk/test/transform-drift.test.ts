import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { transformModuleSource } from '../src/runtime/transform'

// Extract transformModuleSource from the sandbox JS to compare outputs.
// The sandbox wraps everything in an IIFE, so we execute it to get the function.
function getSandboxTransform(): (source: string) => string {
  const sandboxPath = resolve(
    __dirname,
    '../../client/search-plugin-sandbox/search-plugin-sandbox.js',
  )
  const sandboxSource = readFileSync(sandboxPath, 'utf-8')

  // Extract the transformModuleSource function from the IIFE
  const match = sandboxSource.match(/function transformModuleSource\(source\)\s*\{[\s\S]*?\n {2}\}/)
  if (!match) throw new Error('Could not extract transformModuleSource from sandbox JS')

  return new Function(`${match[0]}\nreturn transformModuleSource;`)() as (source: string) => string
}

const fixtures = [
  'export const manifest = { name: "Test", hosts: ["example.com"] }',
  'export async function search(ctx, input) { return }',
  'export function search(ctx, input) {}',
  `export const manifest = { name: "Multi", hosts: ["a.com"] }
export async function search(ctx, input) {}
export const VERSION = "1.0"`,
]

describe('transformModuleSource drift check', () => {
  const sandboxTransform = getSandboxTransform()

  for (const fixture of fixtures) {
    it(`produces identical output for: ${fixture.slice(0, 50)}...`, () => {
      const sdkResult = transformModuleSource(fixture)
      const sandboxResult = sandboxTransform(fixture)
      expect(sdkResult).toBe(sandboxResult)
    })
  }
})
