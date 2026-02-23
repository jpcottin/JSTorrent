import { describe, expect, it, vi } from 'vitest'
import {
  buildConnectedDaemonInfo,
  buildDaemonCapabilities,
  fetchChromeosRoots,
} from '../../../src/lib/daemon-bridge/chromeos/connection-complete'

function responseOf(status: number, jsonBody: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => jsonBody,
  } as Response
}

describe('chromeos connection-complete', () => {
  it('fetchChromeosRoots fetches and maps companion roots', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(999)

    const fetchImpl = vi.fn(async () =>
      responseOf(200, {
        roots: [
          {
            key: 'k1',
            uri: 'content://downloads',
            displayName: 'Downloads',
            removable: true,
            lastStatOk: false,
            diskId: 'disk-1',
          },
        ],
      }),
    )

    const roots = await fetchChromeosRoots({
      fetchImpl,
      host: '100.115.92.2',
      port: 7800,
      headers: { 'X-JST-Auth': 'tok' },
    })

    expect(fetchImpl).toHaveBeenCalledWith('http://100.115.92.2:7800/roots', {
      headers: { 'X-JST-Auth': 'tok' },
    })
    expect(roots).toEqual([
      {
        key: 'k1',
        path: 'content://downloads',
        display_name: 'Downloads',
        removable: true,
        last_stat_ok: false,
        last_checked: 999,
        disk_id: 'disk-1',
      },
    ])
  })

  it('buildDaemonCapabilities defaults roots_manageable to true', () => {
    expect(buildDaemonCapabilities()).toEqual({ roots_manageable: true })
    expect(buildDaemonCapabilities({})).toEqual({ roots_manageable: true })
    expect(buildDaemonCapabilities({ roots_manageable: false })).toEqual({ roots_manageable: false })
  })

  it('buildConnectedDaemonInfo includes defaults and fields', () => {
    const roots = [
      {
        key: 'k1',
        path: '/d',
        display_name: 'D',
        removable: true,
        last_stat_ok: true,
        last_checked: 1,
      },
    ]

    expect(
      buildConnectedDaemonInfo({
        port: 7800,
        token: 'tok',
        version: null,
        roots,
        host: '100.115.92.2',
        capabilities: {},
        ioPort: 7801,
        streamingPort: 7802,
      }),
    ).toEqual({
      port: 7800,
      token: 'tok',
      version: 'unknown',
      roots,
      host: '100.115.92.2',
      capabilities: { roots_manageable: true },
      ioPort: 7801,
      streamingPort: 7802,
    })
  })
})
