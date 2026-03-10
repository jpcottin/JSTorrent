const DEFAULT_HTTP_STREAM_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000

export interface NodeIoDaemonRegisteredHttpStream {
  token: string
  ownerId: string | null
  torrentId: string
  fileIndex: number | null
  rootKey: string
  path: string
  fileSize: number
  mimeType: string | null
  createdAt: number
  lastAccessedAt: number
}

export interface NodeIoDaemonTouchedHttpStreamResult {
  stream: NodeIoDaemonRegisteredHttpStream | null
  expired: NodeIoDaemonRegisteredHttpStream | null
}

export class NodeIoDaemonHttpStreamRegistry {
  private readonly streams = new Map<string, NodeIoDaemonRegisteredHttpStream>()

  constructor(private readonly idleTimeoutMs: number = DEFAULT_HTTP_STREAM_IDLE_TIMEOUT_MS) {}

  register(stream: {
    token: string
    ownerId: string | null
    torrentId: string
    fileIndex: number | null
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
    return this.getAndTouchDetailed(token).stream
  }

  getAndTouchDetailed(token: string): NodeIoDaemonTouchedHttpStreamResult {
    const current = this.streams.get(token)
    if (!current) {
      return { stream: null, expired: null }
    }

    const now = Date.now()
    if (now - current.lastAccessedAt > this.idleTimeoutMs) {
      this.streams.delete(token)
      return {
        stream: null,
        expired: { ...current },
      }
    }

    const updated = { ...current, lastAccessedAt: now }
    this.streams.set(token, updated)
    return {
      stream: { ...updated },
      expired: null,
    }
  }

  peek(token: string): NodeIoDaemonRegisteredHttpStream | null {
    const current = this.streams.get(token)
    return current ? { ...current } : null
  }

  revoke(token: string): NodeIoDaemonRegisteredHttpStream | null {
    const current = this.streams.get(token)
    if (!current) {
      return null
    }
    this.streams.delete(token)
    return { ...current }
  }

  revokeOwnedBy(ownerId: string): NodeIoDaemonRegisteredHttpStream[] {
    const revoked: NodeIoDaemonRegisteredHttpStream[] = []
    for (const [token, stream] of this.streams.entries()) {
      if (stream.ownerId !== ownerId) {
        continue
      }
      this.streams.delete(token)
      revoked.push({ ...stream })
    }
    return revoked
  }

  revokeTorrent(torrentId: string): NodeIoDaemonRegisteredHttpStream[] {
    const revoked: NodeIoDaemonRegisteredHttpStream[] = []
    for (const [token, stream] of this.streams.entries()) {
      if (stream.torrentId !== torrentId) {
        continue
      }
      this.streams.delete(token)
      revoked.push({ ...stream })
    }
    return revoked
  }

  clear(): NodeIoDaemonRegisteredHttpStream[] {
    const revoked = [...this.streams.values()].map((stream) => ({ ...stream }))
    this.streams.clear()
    return revoked
  }
}
