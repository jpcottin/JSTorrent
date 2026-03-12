import { Bencode } from '../utils/bencode'
import { TorrentFile } from './torrent-file'
import { IHasher } from '../interfaces/hasher'

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

/** Safely decode bytes to string, returning undefined on invalid UTF-8 */
function safeDecodeText(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return undefined
  }
}

function parseUrlSeedsField(value: unknown): string[] | undefined {
  const decoded: string[] = []
  const seen = new Set<string>()

  const add = (entry: Uint8Array | undefined) => {
    const url = safeDecodeText(entry)?.trim()
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
    if (!info) {
      throw new Error('Invalid torrent: missing info dictionary')
    }

    // Calculate infoHash
    const infoBuffer = Bencode.getRawInfo(buffer)
    if (!infoBuffer) {
      throw new Error('Invalid torrent: could not extract raw info for hashing')
    }

    // Extract optional metadata from top-level torrent dict
    const comment = safeDecodeText(
      decoded.comment instanceof Uint8Array ? decoded.comment : undefined,
    )
    const createdBy = safeDecodeText(
      decoded['created by'] instanceof Uint8Array ? decoded['created by'] : undefined,
    )
    const creationDate = decoded['creation date'] as number | undefined
    const urlSeeds = parseUrlSeedsField(decoded['url-list'])

    const infoHash = await hasher.sha1(infoBuffer, 'info-hash')
    return this.parseInfoDictionary(
      info,
      infoHash,
      Array.isArray(decoded['announce-list']) ? (decoded['announce-list'] as Uint8Array[][]) : undefined,
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
    const infoHash = await hasher.sha1(infoBuffer, 'info-hash')
    return this.parseInfoDictionary(info, infoHash, undefined, undefined, undefined, infoBuffer)
  }

  static parseInfoDictionary(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    info: any,
    infoHash: Uint8Array,
    announceList?: Uint8Array[][],
    announceUrl?: Uint8Array,
    urlSeeds?: string[],
    infoBuffer?: Uint8Array,
    comment?: string,
    createdBy?: string,
    creationDate?: number,
  ): ParsedTorrent {
    const name = new TextDecoder().decode(info.name)
    const pieceLength = info['piece length']

    const piecesBuffer = info.pieces
    if (piecesBuffer.length % 20 !== 0) {
      throw new Error('Invalid torrent: pieces length must be multiple of 20')
    }

    const pieces: Uint8Array[] = []
    for (let i = 0; i < piecesBuffer.length; i += 20) {
      pieces.push(piecesBuffer.slice(i, i + 20))
    }

    const files: TorrentFile[] = []
    let totalLength = 0

    if (info.files) {
      // Multi-file torrent: info.name is the root directory
      let offset = 0
      for (const file of info.files) {
        const pathParts = file.path.map((p: Uint8Array) => new TextDecoder().decode(p))
        // Path includes torrent name as root directory per BT spec
        const path = name + '/' + pathParts.join('/')
        const length = file.length
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
