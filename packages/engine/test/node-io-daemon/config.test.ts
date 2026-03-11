import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NODE_IO_DAEMON_CONFIG,
  normalizeNodeIoDaemonConfig,
} from '../../src/node-io-daemon/config'

describe('node-io-daemon config', () => {
  it('uses daemon defaults when no config is provided', () => {
    expect(normalizeNodeIoDaemonConfig()).toEqual(DEFAULT_NODE_IO_DAEMON_CONFIG)
  })

  it('preserves explicit overrides', () => {
    const folderPicker = () => null
    expect(
      normalizeNodeIoDaemonConfig({
        host: '0.0.0.0',
        port: 19090,
        bootstrapMode: 'realistic',
        authToken: 'secret',
        configPath: '/tmp/node-io-daemon.json',
        folderPicker,
      }),
    ).toEqual({
      host: '0.0.0.0',
      port: 19090,
      bootstrapMode: 'realistic',
      authToken: 'secret',
      configPath: '/tmp/node-io-daemon.json',
      httpStreamBridge: null,
      roots: [],
      folderPicker,
    })
  })
})
