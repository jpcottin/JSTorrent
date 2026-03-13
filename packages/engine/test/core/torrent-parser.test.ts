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

  it('prefers utf-8 name/path/comment fields over legacy variants', async () => {
    const buffer = Bencode.encode({
      comment: 'legacy comment',
      'comment.utf-8': 'русский комментарий',
      'created by': 'legacy creator',
      'created by.utf-8': 'Юникод автор',
      info: {
        name: 'fallback-name',
        'name.utf-8': 'Каталог',
        'piece length': 16384,
        pieces: new Uint8Array(20),
        files: [
          {
            length: 5,
            path: ['fallback.txt'],
            'path.utf-8': ['файл.txt'],
          },
        ],
      },
    })

    const parsed = await TorrentParser.parse(buffer, hasher)

    expect(parsed.name).toBe('Каталог')
    expect(parsed.files).toEqual([
      {
        path: 'Каталог/файл.txt',
        length: 5,
        offset: 0,
      },
    ])
    expect(parsed.comment).toBe('русский комментарий')
    expect(parsed.createdBy).toBe('Юникод автор')
  })
})
