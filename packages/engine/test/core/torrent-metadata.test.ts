import { describe, expect, it } from 'vitest'
import {
  getByteListField,
  getPreferredTorrentName,
  getPreferredTorrentNameBytes,
  getPreferredTorrentTextField,
} from '../../src/core/torrent-metadata'
import { fromString } from '../../src/utils/buffer'

describe('torrent-metadata helpers', () => {
  it('prefers name.utf-8 over name', () => {
    const info = {
      name: fromString('fallback'),
      'name.utf-8': fromString('Каталог'),
    }

    expect(getPreferredTorrentName(info)).toBe('Каталог')
    expect(getPreferredTorrentNameBytes(info)).toEqual(fromString('Каталог'))
  })

  it('falls back to legacy name when name.utf-8 is absent', () => {
    const info = {
      name: fromString('fallback'),
    }

    expect(getPreferredTorrentName(info)).toBe('fallback')
  })

  it('prefers utf-8 text fields and list fields', () => {
    const dict = {
      comment: fromString('legacy'),
      'comment.utf-8': fromString('комментарий'),
      path: [fromString('fallback.txt')],
      'path.utf-8': [fromString('файл.txt')],
    }

    expect(getPreferredTorrentTextField(dict, 'comment.utf-8', 'comment')).toBe('комментарий')
    expect(getByteListField(dict, 'path.utf-8', 'path')).toEqual([fromString('файл.txt')])
  })
})
