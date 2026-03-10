const DEFAULT_HTTP_STREAM_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000

export interface NodeIoDaemonRegisteredHttpStream {
  token: string
  torrentId: string
  rootKey: string
  path: string
  fileSize: number
  mimeType: string | null
  createdAt: number
  lastAccessedAt: number
}

export class NodeIoDaemonHttpStreamRegistry {
  private readonly streams = new Map<string, NodeIoDaemonRegisteredHttpStream>()

  constructor(private readonly idleTimeoutMs: number = DEFAULT_HTTP_STREAM_IDLE_TIMEOUT_MS) {}

  register(stream: {
    token: string
    torrentId: string
    rootKey: string
    path: string
    fileSize: number
    mimeType: string | null
  }): NodeIoDaemonRegisteredHttpStream {
    const now = Date.now()
    const registered: NodeIoDaemonRegisteredHttpStream = {
      ...stream,
      createdAt: now,
      lastAccessedAt: now,
    }
    this.streams.set(stream.token, registered)
    return { ...registered }
  }

  getAndTouch(token: string): NodeIoDaemonRegisteredHttpStream | null {
    const current = this.streams.get(token)
    if (!current) {
      return null
    }

    const now = Date.now()
    if (now - current.lastAccessedAt > this.idleTimeoutMs) {
      this.streams.delete(token)
      return null
    }

    const updated = { ...current, lastAccessedAt: now }
    this.streams.set(token, updated)
    return { ...updated }
  }

  revoke(token: string): boolean {
    return this.streams.delete(token)
  }

  clear(): void {
    this.streams.clear()
  }
}
