const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.webm', '.mov', '.m4v', '.ts', '.m2ts'])

export function isVideoExtension(extension: string): boolean {
  return VIDEO_EXTENSIONS.has(extension.toLowerCase())
}
