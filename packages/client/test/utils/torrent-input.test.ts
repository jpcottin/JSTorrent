import { describe, expect, it } from 'vitest'
import {
  isUnsupportedRemoteTorrentUrl,
  UNSUPPORTED_REMOTE_TORRENT_URL_MESSAGE,
} from '../../src/utils/torrent-input'

describe('torrent input classification', () => {
  it('flags remote URLs as unsupported manual add input', () => {
    expect(isUnsupportedRemoteTorrentUrl('https://webtorrent.io/torrents/big-buck-bunny.torrent')).toBe(
      true,
    )
    expect(isUnsupportedRemoteTorrentUrl(' http://example.com/file.torrent ')).toBe(true)
    expect(isUnsupportedRemoteTorrentUrl('file:///Users/test/Downloads/test.torrent')).toBe(true)
  })

  it('does not flag magnet links or bare hashes', () => {
    expect(
      isUnsupportedRemoteTorrentUrl(
        'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny',
      ),
    ).toBe(false)
    expect(isUnsupportedRemoteTorrentUrl('dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c')).toBe(false)
  })

  it('keeps the unsupported URL message stable', () => {
    expect(UNSUPPORTED_REMOTE_TORRENT_URL_MESSAGE).toBe(
      'Remote torrent URLs are not supported here. Use a magnet link or import the .torrent file.',
    )
  })
})
