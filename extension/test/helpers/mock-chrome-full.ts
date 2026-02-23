import { vi } from 'vitest'
import { createMockNativePort, type MockNativePort } from './mock-native-port'

export interface MockChromeOptions {
  storageSeed?: Record<string, unknown>
  nativePort?: MockNativePort
  runtimeId?: string
  manifestVersion?: string
  tabsQueryResult?: Array<{ id?: number }>
}

function cloneStorage(storage: Record<string, unknown>): Record<string, unknown> {
  return { ...storage }
}

function pickStorageKeys(
  storage: Record<string, unknown>,
  keys?: string | string[] | Record<string, unknown> | null,
): Record<string, unknown> {
  if (keys == null) return cloneStorage(storage)

  if (typeof keys === 'string') {
    return { [keys]: storage[keys] }
  }

  if (Array.isArray(keys)) {
    const result: Record<string, unknown> = {}
    for (const key of keys) {
      result[key] = storage[key]
    }
    return result
  }

  const result: Record<string, unknown> = {}
  for (const [key, defaultValue] of Object.entries(keys)) {
    result[key] = key in storage ? storage[key] : defaultValue
  }
  return result
}

export function installMockChromeFull(options: MockChromeOptions = {}): {
  chrome: typeof globalThis.chrome
  nativePort: MockNativePort
  storageData: Record<string, unknown>
} {
  const storageData: Record<string, unknown> = { ...(options.storageSeed ?? {}) }
  const nativePort = options.nativePort ?? createMockNativePort()

  const chromeMock = {
    runtime: {
      id: options.runtimeId ?? 'test-extension-id',
      lastError: null as { message: string } | null,
      connectNative: vi.fn(() => nativePort),
      getManifest: vi.fn(() => ({ version: options.manifestVersion ?? '1.0.0-test' })),
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
      onConnect: { addListener: vi.fn() },
      onConnectExternal: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
    },
    storage: {
      local: {
        get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
          return pickStorageKeys(storageData, keys)
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(storageData, items)
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          if (Array.isArray(keys)) {
            for (const key of keys) delete storageData[key]
          } else {
            delete storageData[keys]
          }
        }),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
    },
    tabs: {
      query: vi.fn(async () => options.tabsQueryResult ?? [{ id: 1 }]),
      update: vi.fn(async () => undefined),
      create: vi.fn(async () => undefined),
    },
  }

  Object.defineProperty(globalThis, 'chrome', {
    value: chromeMock,
    configurable: true,
    writable: true,
  })

  return {
    chrome: chromeMock as unknown as typeof globalThis.chrome,
    nativePort,
    storageData,
  }
}
