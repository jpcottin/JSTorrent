import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryFileSystem } from '../../../src/adapters/memory/memory-filesystem'

describe('InMemoryFileSystem.writeAtomic', () => {
  let fs: InMemoryFileSystem

  beforeEach(() => {
    fs = new InMemoryFileSystem()
  })

  it('should create a new file', async () => {
    const data = new TextEncoder().encode('hello world')
    await fs.writeAtomic('test.json', data)

    const content = await fs.readFile('test.json')
    expect(new TextDecoder().decode(content)).toBe('hello world')
  })

  it('should overwrite an existing file', async () => {
    await fs.writeAtomic('test.json', new TextEncoder().encode('old'))
    await fs.writeAtomic('test.json', new TextEncoder().encode('new'))

    const content = await fs.readFile('test.json')
    expect(new TextDecoder().decode(content)).toBe('new')
  })

  it('should auto-create parent directories', async () => {
    const data = new TextEncoder().encode('nested')
    await fs.writeAtomic('sub/deep/test.json', data)

    const content = await fs.readFile('sub/deep/test.json')
    expect(new TextDecoder().decode(content)).toBe('nested')
    expect(await fs.exists('sub')).toBe(true)
    expect(await fs.exists('sub/deep')).toBe(true)
  })

  it('should handle dot-prefixed filenames', async () => {
    const data = new TextEncoder().encode('{"infohash":"abc"}')
    await fs.writeAtomic('.abc123.jstorrent.json', data)

    expect(await fs.exists('.abc123.jstorrent.json')).toBe(true)
  })

  it('should not share buffer with caller', async () => {
    const data = new TextEncoder().encode('original')
    await fs.writeAtomic('test.json', data)
    data[0] = 0 // mutate caller's buffer

    const content = await fs.readFile('test.json')
    expect(new TextDecoder().decode(content)).toBe('original')
  })
})
