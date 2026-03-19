import type { TorrentFile } from './torrent-file'

const BAD_DIRECTIONAL_CODE_POINTS = new Set([
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x200e, 0x200f,
])

const EXTRA_INVALID_PATH_CHARS = new Set(['"', '*', ':', '<', '>', '?', '|'])

function splitExtension(name: string): { stem: string; extension: string } {
  const lastDot = name.lastIndexOf('.')
  if (lastDot <= 0 || lastDot < name.length - 10) {
    return { stem: name, extension: '' }
  }
  return {
    stem: name.slice(0, lastDot),
    extension: name.slice(lastDot),
  }
}

function truncatePathElement(element: string, limit: number = 240): string {
  const chars = Array.from(element)
  if (chars.length <= limit) return element

  const { stem, extension } = splitExtension(element)
  const extensionChars = Array.from(extension)
  if (extensionChars.length === 0 || extensionChars.length >= limit) {
    return chars.slice(0, limit).join('')
  }

  const stemLimit = Math.max(1, limit - extensionChars.length)
  return Array.from(stem).slice(0, stemLimit).join('') + extension
}

export function sanitizeTorrentPathElement(element: string, forceElement: boolean): string {
  if (element === '.' && !forceElement) return ''

  let sanitized = ''
  let added = 0
  let numDots = 0

  for (const char of element) {
    const codePoint = char.codePointAt(0)
    if (codePoint === undefined) continue

    if (BAD_DIRECTIONAL_CODE_POINTS.has(codePoint)) {
      continue
    }

    if (char === '/' || char === '\\') {
      continue
    }

    if (char === '\u{fffd}' || codePoint < 32 || EXTRA_INVALID_PATH_CHARS.has(char)) {
      sanitized += '_'
      added += 1
      continue
    }

    sanitized += char
    added += 1
    if (char === '.') numDots += 1
  }

  if (added === 0) {
    return forceElement ? '_' : ''
  }

  if (added === numDots && added <= 2) {
    return forceElement ? '_' : ''
  }

  return truncatePathElement(sanitized)
}

export function sanitizeTorrentRootName(name: string, infoHashHex: string): string {
  const sanitized = sanitizeTorrentPathElement(name, false)
  return sanitized.length > 0 ? sanitized : infoHashHex
}

function disambiguateLeafName(name: string, suffix: number): string {
  const { stem, extension } = splitExtension(name)
  return `${stem}.${suffix}${extension}`
}

function resolveDuplicateFilePaths(files: TorrentFile[]): TorrentFile[] {
  const usedPaths = new Set<string>()

  return files.map((file) => {
    if (!usedPaths.has(file.path)) {
      usedPaths.add(file.path)
      return file
    }

    const parts = file.path.split('/')
    const leaf = parts.pop() ?? '_'
    const dir = parts.join('/')

    let suffix = 1
    let candidate = file.path
    do {
      const renamedLeaf = disambiguateLeafName(leaf, suffix)
      candidate = dir.length > 0 ? `${dir}/${renamedLeaf}` : renamedLeaf
      suffix += 1
    } while (usedPaths.has(candidate))

    usedPaths.add(candidate)
    return {
      ...file,
      path: candidate,
    }
  })
}

export function buildSanitizedTorrentFiles(
  rootName: string,
  infoHashHex: string,
  files: Array<{ pathParts: string[]; length: number; offset: number }>,
): TorrentFile[] {
  const sanitizedRoot = sanitizeTorrentRootName(rootName, infoHashHex)
  const sanitizedFiles = files.map((file) => {
    const sanitizedParts = file.pathParts.map((part) => sanitizeTorrentPathElement(part, true))
    return {
      path: [sanitizedRoot, ...sanitizedParts].join('/'),
      length: file.length,
      offset: file.offset,
    }
  })
  return resolveDuplicateFilePaths(sanitizedFiles)
}
