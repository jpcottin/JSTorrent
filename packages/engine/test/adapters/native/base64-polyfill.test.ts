import { afterEach, describe, expect, it, vi } from 'vitest'

const globals = globalThis as Record<string, unknown>
const originalAtob = globals.atob
const originalBtoa = globals.btoa

describe('base64 polyfill', () => {
  afterEach(() => {
    vi.resetModules()

    if (originalAtob === undefined) {
      delete globals.atob
    } else {
      globals.atob = originalAtob
    }

    if (originalBtoa === undefined) {
      delete globals.btoa
    } else {
      globals.btoa = originalBtoa
    }
  })

  it('ignores ASCII whitespace like native atob', async () => {
    delete globals.atob
    delete globals.btoa

    await import('../../../src/adapters/native/polyfills')

    expect(atob('SG Vs\nbG8=\t')).toBe('Hello')
  })
})
