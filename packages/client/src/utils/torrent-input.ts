export const UNSUPPORTED_REMOTE_TORRENT_URL_MESSAGE =
  'Remote torrent URLs are not supported here. Use a magnet link or import the .torrent file.'

export function isUnsupportedRemoteTorrentUrl(input: string): boolean {
  const trimmed = input.trim()
  return /^(https?|file):\/\//i.test(trimmed)
}
