import { describe, expect, it, vi } from 'vitest'
import { mapCompanionRoot, mapCompanionRoots } from '../../../src/lib/daemon-bridge/protocol/root-mapper'

describe('root-mapper', () => {
  it('maps field aliases and prefers uri/displayName/camelCase values', () => {
    const root = mapCompanionRoot({
      key: 'k1',
      uri: 'content://tree/downloads',
      path: '/fallback',
      displayName: 'Downloads',
      display_name: 'fallback',
      removable: true,
      lastStatOk: false,
      last_stat_ok: true,
      lastChecked: 123,
      last_checked: 999,
      diskId: 'disk-camel',
      disk_id: 'disk-snake',
    })

    expect(root).toEqual({
      key: 'k1',
      path: 'content://tree/downloads',
      display_name: 'Downloads',
      removable: true,
      last_stat_ok: false,
      last_checked: 123,
      disk_id: 'disk-camel',
    })
  })

  it('falls back to snake_case values and defaults', () => {
    vi.spyOn(Date, 'now').mockReturnValue(777)

    const root = mapCompanionRoot({
      key: 'k2',
      path: '/data',
      display_name: 'Data',
      removable: false,
      last_stat_ok: true,
    })

    expect(root).toEqual({
      key: 'k2',
      path: '/data',
      display_name: 'Data',
      removable: false,
      last_stat_ok: true,
      last_checked: 777,
      disk_id: '',
    })
  })

  it('maps arrays and handles null/undefined input', () => {
    expect(mapCompanionRoots(undefined)).toEqual([])
    expect(mapCompanionRoots(null)).toEqual([])

    const mapped = mapCompanionRoots([
      {
        key: 'a',
        path: '/a',
        display_name: 'A',
        removable: true,
      },
    ])

    expect(mapped).toHaveLength(1)
    expect(mapped[0].key).toBe('a')
    expect(mapped[0].path).toBe('/a')
  })
})
