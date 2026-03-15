import { describe, it, expect } from 'vitest'
import { transformModuleSource } from '../src/runtime/transform'

describe('transformModuleSource', () => {
  it('transforms export const', () => {
    const source = 'export const manifest = { name: "Test" }'
    const result = transformModuleSource(source)
    expect(result).toContain('const manifest = { name: "Test" }')
    expect(result).toContain('exports.manifest = typeof manifest')
    expect(result).toContain('return exports;')
  })

  it('transforms export function', () => {
    const source = 'export function search(ctx, input) {}'
    const result = transformModuleSource(source)
    expect(result).toContain('function search(ctx, input) {}')
    expect(result).toContain('exports.search = typeof search')
  })

  it('transforms export async function', () => {
    const source = 'export async function search(ctx, input) {}'
    const result = transformModuleSource(source)
    expect(result).toContain('async function search(ctx, input) {}')
    expect(result).toContain('exports.search = typeof search')
  })

  it('rejects export default', () => {
    const source = 'export default { name: "Test" }'
    expect(() => transformModuleSource(source)).toThrow('export default is not supported')
  })

  it('rejects unsupported export syntax', () => {
    const source = 'export { foo } from "./bar"'
    expect(() => transformModuleSource(source)).toThrow('Unsupported export syntax')
  })

  it('handles multiple exports', () => {
    const source = `export const manifest = { name: "Test", hosts: ["example.com"] }
export async function search(ctx, input) {}
export const VERSION = "1.0"`
    const result = transformModuleSource(source)
    expect(result).toContain('exports.manifest')
    expect(result).toContain('exports.search')
    expect(result).toContain('exports.VERSION')
  })
})
