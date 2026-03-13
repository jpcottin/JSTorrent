export function getByteStringField(
  dict: Record<string, unknown> | undefined,
  ...keys: string[]
): Uint8Array | undefined {
  if (!dict) return undefined
  for (const key of keys) {
    const value = dict[key]
    if (value instanceof Uint8Array) {
      return value
    }
  }
  return undefined
}

export function getByteListField(
  dict: Record<string, unknown> | undefined,
  ...keys: string[]
): Uint8Array[] | undefined {
  if (!dict) return undefined
  for (const key of keys) {
    const value = dict[key]
    if (Array.isArray(value) && value.every((entry) => entry instanceof Uint8Array)) {
      return value as Uint8Array[]
    }
  }
  return undefined
}

export function decodeTorrentText(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return undefined
  }
}

export function getPreferredTorrentTextField(
  dict: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  return decodeTorrentText(getByteStringField(dict, ...keys))
}

export function getPreferredTorrentNameBytes(
  info: Record<string, unknown> | undefined,
): Uint8Array | undefined {
  return getByteStringField(info, 'name.utf-8', 'name')
}

export function getPreferredTorrentName(
  info: Record<string, unknown> | undefined,
): string | undefined {
  return decodeTorrentText(getPreferredTorrentNameBytes(info))
}
