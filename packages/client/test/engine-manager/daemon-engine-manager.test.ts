import { describe, expect, it } from 'vitest'
import { shouldDisableDownloadManifestSetting } from '../../src/engine-manager/daemon-engine-manager'

describe('shouldDisableDownloadManifestSetting', () => {
  it('returns false when the setting is already disabled', () => {
    expect(shouldDisableDownloadManifestSetting(undefined, false)).toBe(false)
  })

  it('returns true when write_atomic is missing or false', () => {
    expect(shouldDisableDownloadManifestSetting(undefined, true)).toBe(true)
    expect(
      shouldDisableDownloadManifestSetting(
        {
          capabilities: {
            roots_manageable: true,
            lan_share_urls: true,
            free_space: true,
            write_atomic: false,
          },
        },
        true,
      ),
    ).toBe(true)
  })

  it('returns false when write_atomic is advertised', () => {
    expect(
      shouldDisableDownloadManifestSetting(
        {
          capabilities: {
            roots_manageable: true,
            lan_share_urls: true,
            free_space: true,
            write_atomic: true,
          },
        },
        true,
      ),
    ).toBe(false)
  })
})
