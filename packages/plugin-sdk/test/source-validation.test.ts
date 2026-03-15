import { describe, it, expect } from 'vitest'
import { validateModuleSource } from '../src/validation/source'

describe('validateModuleSource', () => {
  it('validates a correct plugin source', () => {
    const source = `export const manifest = { name: "Test", hosts: ["example.com"] }
export async function search(ctx, input) {}`
    const result = validateModuleSource(source)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.exportedNames).toContain('manifest')
    expect(result.exportedNames).toContain('search')
  })

  it('reports missing manifest', () => {
    const source = 'export async function search(ctx, input) {}'
    const result = validateModuleSource(source)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('manifest'))
  })

  it('reports missing search', () => {
    const source = 'export const manifest = { name: "Test", hosts: ["example.com"] }'
    const result = validateModuleSource(source)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('search'))
  })

  it('reports export default', () => {
    const source = `export default { name: "Test" }
export async function search(ctx, input) {}`
    const result = validateModuleSource(source)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('export default'))
  })
})
