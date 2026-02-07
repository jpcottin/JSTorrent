/**
 * ISessionStore adapter backed by HostChannel KV storage.
 *
 * Binary values are base64-encoded for transport.
 * JSON values are passed directly.
 */

import type { ISessionStore } from '@jstorrent/engine'
import type { HostChannel } from './host-channel'

function toBase64(buffer: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < buffer.length; i++) {
    binary += String.fromCharCode(buffer[i])
  }
  return btoa(binary)
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export class HostChannelSessionStore implements ISessionStore {
  constructor(private channel: HostChannel) {}

  async get(key: string): Promise<Uint8Array | null> {
    const value = await this.channel.kvGet<string>(key, { keyPrefix: 'session:' })
    return value ? fromBase64(value) : null
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    await this.channel.kvSet(key, toBase64(value), { keyPrefix: 'session:' })
  }

  async delete(key: string): Promise<void> {
    await this.channel.kvDelete(key, { keyPrefix: 'session:' })
  }

  async keys(prefix?: string): Promise<string[]> {
    return this.channel.kvKeys(prefix, { keyPrefix: 'session:' })
  }

  async clear(): Promise<void> {
    await this.channel.kvClear(undefined, { keyPrefix: 'session:' })
  }

  async getMulti(keys: string[]): Promise<Map<string, Uint8Array>> {
    if (keys.length === 0) return new Map()

    const raw = await this.channel.kvGetMulti(keys, { keyPrefix: 'session:' })
    const result = new Map<string, Uint8Array>()
    for (const [k, v] of Object.entries(raw)) {
      if (v) result.set(k, fromBase64(v as string))
    }
    return result
  }

  async getJson<T>(key: string): Promise<T | null> {
    const value = await this.channel.kvGet<T>(key, { keyPrefix: 'session:' })
    return value ?? null
  }

  async setJson<T>(key: string, value: T): Promise<void> {
    await this.channel.kvSet(key, value, { keyPrefix: 'session:' })
  }
}
