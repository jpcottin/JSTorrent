import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeSessionStore } from '../../../src/adapters/native/native-session-store'

const globals = globalThis as Record<string, unknown>
const originalAtob =
  typeof globalThis.atob === 'function'
    ? globalThis.atob.bind(globalThis)
    : (value: string) => Buffer.from(value, 'base64').toString('binary')

const mockStorage = new Map<string, string>()

describe('NativeSessionStore', () => {
  beforeEach(() => {
    mockStorage.clear()

    globalThis.__jstorrent_storage_get = vi.fn((key: string) => mockStorage.get(key) ?? null)
    globalThis.__jstorrent_storage_set = vi.fn((key: string, value: string) => {
      mockStorage.set(key, value)
    })
    globalThis.__jstorrent_storage_delete = vi.fn((key: string) => {
      mockStorage.delete(key)
    })
    globalThis.__jstorrent_storage_keys = vi.fn((prefix: string) =>
      JSON.stringify(Array.from(mockStorage.keys()).filter((key) => key.startsWith(prefix))),
    )

    globalThis.atob = vi.fn((value: string) => {
      if (/\s/.test(value)) {
        throw new Error('atob: Invalid base64 character')
      }
      return originalAtob(value)
    })
  })

  afterEach(() => {
    delete globals.__jstorrent_storage_get
    delete globals.__jstorrent_storage_set
    delete globals.__jstorrent_storage_delete
    delete globals.__jstorrent_storage_keys
    globals.atob = originalAtob
  })

  it('decodes persisted base64 even when it contains whitespace', async () => {
    const store = new NativeSessionStore()
    mockStorage.set('session:payload', JSON.stringify('SG Vs\nbG8=\t'))

    const value = await store.get('payload')

    expect(value).toEqual(new Uint8Array([72, 101, 108, 108, 111]))
  })
})
