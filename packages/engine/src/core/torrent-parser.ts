import { Bencode } from '../utils/bencode'
import { TorrentFile } from './torrent-file'
import { IHasher } from '../interfaces/hasher'
import {
  decodeTorrentText,
  getByteListField,
  getPreferredTorrentName,
  getPreferredTorrentTextField,
} from './torrent-metadata'

export interface ParsedTorrent {
  infoHash: Uint8Array
  name: string
  pieceLength: number
  pieces: Uint8Array[]
  files: TorrentFile[]
  length: number
  announce: string[]
  urlSeeds?: string[]
  infoBuffer?: Uint8Array
  isPrivate?: boolean
  // Optional metadata from top-level torrent dict
  comment?: string
  createdBy?: string
  creationDate?: number
}

function parseUrlSeedsField(value: unknown): string[] | undefined {
  const decoded: string[] = []
  const seen = new Set<string>()

  const add = (entry: Uint8Array | undefined) => {
    const url = decodeTorrentText(entry)?.trim()
    if (!url || seen.has(url)) return
    seen.add(url)
    decoded.push(url)
  }

  if (value instanceof Uint8Array) {
    add(value)
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry instanceof Uint8Array) {
        add(entry)
      }
    }
  }

  return decoded.length > 0 ? decoded : undefined
}

export class TorrentParser {
  static async parse(buffer: Uint8Array, hasher: IHasher): Promise<ParsedTorrent> {
    const decoded = Bencode.decode(buffer) as Record<string, unknown> | null
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('Invalid torrent: top-level value is not a dictionary')
    }
    const info = decoded.info
    if (!info || typeof info !== 'object' || Array.isArray(info)) {
      throw new Error('Invalid torrent: missing info dictionary')
    }

    // Calculate infoHash
    const infoBuffer = Bencode.getRawInfo(buffer)
    if (!infoBuffer) {
      throw new Error('Invalid torrent: could not extract raw info for hashing')
    }

    // Extract optional metadata from top-level torrent dict
    const comment = getPreferredTorrentTextField(decoded, 'comment.utf-8', 'comment')
    const createdBy = getPreferredTorrentTextField(decoded, 'created by.utf-8', 'created by')
    const creationDate = decoded['creation date'] as number | undefined
    const urlSeeds = parseUrlSeedsField(decoded['url-list'])

    const infoHash = await hasher.sha1(infoBuffer, 'info-hash')
    return this.parseInfoDictionary(
      info as Record<string, unknown>,
      infoHash,
      Array.isArray(decoded['announce-list'])
        ? (decoded['announce-list'] as Uint8Array[][])
        : undefined,
      decoded.announce instanceof Uint8Array ? decoded.announce : undefined,
      urlSeeds,
      infoBuffer,
      comment,
      createdBy,
      creationDate,
    )
  }

  static async parseInfoBuffer(infoBuffer: Uint8Array, hasher: IHasher): Promise<ParsedTorrent> {
    const info = Bencode.decode(infoBuffer)
    if (!info || typeof info !== 'object' || Array.isArray(info)) {
      throw new Error('Invalid torrent: info buffer is not a dictionary')
    }
    const infoHash = await hasher.sha1(infoBuffer, 'info-hash')
    return this.parseInfoDictionary(
      info as Record<string, unknown>,
      infoHash,
      undefined,
      undefined,
      undefined,
      infoBuffer,
    )
  }

  static parseInfoDictionary(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    info: Record<string, unknown>,
    infoHash: Uint8Array,
    announceList?: Uint8Array[][],
    announceUrl?: Uint8Array,
    urlSeeds?: string[],
    infoBuffer?: Uint8Array,
    comment?: string,
    createdBy?: string,
    creationDate?: number,
  ): ParsedTorrent {
    const name = getPreferredTorrentName(info)
    if (!name) {
      throw new Error('Invalid torrent: missing or invalid name')
    }

    const pieceLength = info['piece length']
    if (typeof pieceLength !== 'number') {
      throw new Error('Invalid torrent: missing piece length')
    }

    const piecesBuffer = info.pieces
    if (!(piecesBuffer instanceof Uint8Array)) {
      throw new Error('Invalid torrent: pieces must be a byte string')
    }
    if (piecesBuffer.length % 20 !== 0) {
      throw new Error('Invalid torrent: pieces length must be multiple of 20')
    }

    const pieces: Uint8Array[] = []
    for (let i = 0; i < piecesBuffer.length; i += 20) {
      pieces.push(piecesBuffer.slice(i, i + 20))
    }

    const files: TorrentFile[] = []
    let totalLength = 0

    if (Array.isArray(info.files)) {
      // Multi-file torrent: info.name is the root directory
      let offset = 0
      for (const file of info.files) {
        if (!file || typeof file !== 'object' || Array.isArray(file)) {
          throw new Error('Invalid torrent: file entry must be a dictionary')
        }
        const pathEntries = getByteListField(file as Record<string, unknown>, 'path.utf-8', 'path')
        if (!pathEntries || pathEntries.length === 0) {
          throw new Error('Invalid torrent: file path must be a non-empty list')
        }
        const pathParts = pathEntries
          .map((p) => decodeTorrentText(p))
          .filter((p): p is string => p !== undefined)
        if (pathParts.length !== pathEntries.length) {
          throw new Error('Invalid torrent: file path contains invalid UTF-8')
        }
        // Path includes torrent name as root directory per BT spec
        const path = name + '/' + pathParts.join('/')
        const length = (file as Record<string, unknown>).length
        if (typeof length !== 'number') {
          throw new Error('Invalid torrent: file length missing')
        }
        files.push({
          path,
          length,
          offset,
        })
        offset += length
        totalLength += length
      }
    } else {
      // Single file
      if (typeof info.length !== 'number') {
        throw new Error('Invalid torrent: single-file torrent missing length')
      }
      totalLength = info.length
      files.push({
        path: name,
        length: totalLength,
        offset: 0,
      })
    }

    const announce: string[] = []
    if (announceList) {
      for (const tier of announceList) {
        for (const url of tier) {
          announce.push(new TextDecoder().decode(url))
        }
      }
    } else if (announceUrl) {
      announce.push(new TextDecoder().decode(announceUrl))
    }

    return {
      infoHash,
      name,
      pieceLength,
      pieces,
      files,
      length: totalLength,
      announce,
      urlSeeds,
      infoBuffer,
      isPrivate: info.private === 1,
      comment,
      createdBy,
      creationDate,
    }
  }
}
