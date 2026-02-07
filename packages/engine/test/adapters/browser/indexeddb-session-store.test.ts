import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import {
  IndexedDbSessionStore,
  clearIndexedDbSessionStore,
} from '../../../src/adapters/browser/indexeddb-session-store'

describe('IndexedDbSessionStore', () => {
  let store: IndexedDbSessionStore
  let dbCounter = 0

  beforeEach(() => {
    store = new IndexedDbSessionStore(`test-db-${++dbCounter}`)
  })

  it('returns null for non-existent binary key', async () => {
    expect(await store.get('nonexistent')).toBeNull()
  })

  it('returns null for non-existent json key', async () => {
    expect(await store.getJson('nonexistent')).toBeNull()
  })

  it('set and get binary data', async () => {
    const data = new Uint8Array([1, 2, 3, 4])
    await store.set('key1', data)
    const result = await store.get('key1')
    expect(result).toEqual(data)
    expect(result).toBeInstanceOf(Uint8Array)
  })

  it('setJson and getJson round-trip', async () => {
    const obj = { version: 2, torrents: [{ infoHash: 'abc' }] }
    await store.setJson('data', obj)
    const result = await store.getJson('data')
    expect(result).toEqual(obj)
  })

  it('get returns null for json value (not Uint8Array)', async () => {
    await store.setJson('key', { x: 1 })
    expect(await store.get('key')).toBeNull()
  })

  it('overwrite binary value', async () => {
    await store.set('k', new Uint8Array([1]))
    await store.set('k', new Uint8Array([2, 3]))
    expect(await store.get('k')).toEqual(new Uint8Array([2, 3]))
  })

  it('overwrite json value', async () => {
    await store.setJson('k', { a: 1 })
    await store.setJson('k', { b: 2 })
    expect(await store.getJson('k')).toEqual({ b: 2 })
  })

  it('delete removes key', async () => {
    await store.set('key1', new Uint8Array([1]))
    await store.delete('key1')
    expect(await store.get('key1')).toBeNull()
  })

  it('delete non-existent key is no-op', async () => {
    await store.delete('nonexistent')
  })

  it('keys returns all keys', async () => {
    await store.set('a', new Uint8Array([1]))
    await store.setJson('b', { x: 1 })
    const keys = await store.keys()
    expect(keys.sort()).toEqual(['a', 'b'])
  })

  it('keys with prefix filter', async () => {
    await store.set('torrent:abc', new Uint8Array([1]))
    await store.set('torrent:def', new Uint8Array([2]))
    await store.setJson('config:x', { y: 1 })
    const keys = await store.keys('torrent:')
    expect(keys.sort()).toEqual(['torrent:abc', 'torrent:def'])
  })

  it('keys returns empty array for empty store', async () => {
    expect(await store.keys()).toEqual([])
  })

  it('clear removes all data', async () => {
    await store.set('a', new Uint8Array([1]))
    await store.setJson('b', 'hello')
    await store.clear()
    expect(await store.keys()).toEqual([])
    expect(await store.get('a')).toBeNull()
    expect(await store.getJson('b')).toBeNull()
  })

  it('getMulti returns matching binary values', async () => {
    await store.set('k1', new Uint8Array([10]))
    await store.set('k2', new Uint8Array([20]))
    const result = await store.getMulti(['k1', 'k2'])
    expect(result.size).toBe(2)
    expect(result.get('k1')).toEqual(new Uint8Array([10]))
    expect(result.get('k2')).toEqual(new Uint8Array([20]))
  })

  it('getMulti skips non-binary and missing keys', async () => {
    await store.set('k1', new Uint8Array([10]))
    await store.setJson('k2', { x: 1 })
    const result = await store.getMulti(['k1', 'k2', 'missing'])
    expect(result.size).toBe(1)
    expect(result.get('k1')).toEqual(new Uint8Array([10]))
  })

  it('getMulti returns empty map for empty keys', async () => {
    const result = await store.getMulti([])
    expect(result.size).toBe(0)
  })
})

describe('clearIndexedDbSessionStore', () => {
  it('clears all data from named database', async () => {
    const dbName = 'clear-test-db'
    const store = new IndexedDbSessionStore(dbName)
    await store.set('key', new Uint8Array([1, 2, 3]))
    await store.setJson('json-key', { data: true })

    await clearIndexedDbSessionStore(dbName)

    const store2 = new IndexedDbSessionStore(dbName)
    expect(await store2.get('key')).toBeNull()
    expect(await store2.getJson('json-key')).toBeNull()
    expect(await store2.keys()).toEqual([])
  })
})
