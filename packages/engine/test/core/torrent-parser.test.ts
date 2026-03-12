import { beforeEach, describe, expect, it } from 'vitest'
import { TorrentParser } from '../../src/core/torrent-parser'
import { Bencode } from '../../src/utils/bencode'
import { SubtleCryptoHasher } from '../../src/adapters/browser/subtle-crypto-hasher'

describe('TorrentParser', () => {
  let hasher: SubtleCryptoHasher

  beforeEach(() => {
    hasher = new SubtleCryptoHasher()
  })

  it('parses a single-string url-list into urlSeeds', async () => {
    const buffer = Bencode.encode({
      announce: 'http://tracker.example.com/announce',
      'url-list': 'https://cdn.example.com/file.bin',
      info: {
        name: 'file.bin',
        'piece length': 16384,
        pieces: new Uint8Array(20),
        length: 1024,
      },
    })

    const parsed = await TorrentParser.parse(buffer, hasher)

    expect(parsed.urlSeeds).toEqual(['https://cdn.example.com/file.bin'])
  })

  it('parses list-form url-list, trimming empties and deduplicating', async () => {
    const buffer = Bencode.encode({
      'url-list': [
        'https://cdn.example.com/root/',
        '',
        'https://mirror.example.com/root/',
        'https://cdn.example.com/root/',
      ],
      info: {
        name: 'bundle',
        'piece length': 16384,
        pieces: new Uint8Array(20),
        length: 1024,
      },
    })

    const parsed = await TorrentParser.parse(buffer, hasher)

    expect(parsed.urlSeeds).toEqual([
      'https://cdn.example.com/root/',
      'https://mirror.example.com/root/',
    ])
  })
})
