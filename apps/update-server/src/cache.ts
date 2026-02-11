import * as fs from 'node:fs'

export class Cache<T> {
  private data: T | null = null
  private fetchedAt = 0
  private inflight: Promise<T | null> | null = null

  constructor(
    private fetchFn: () => Promise<T | null>,
    private ttlMs: number,
    private diskPath?: string,
  ) {
    if (diskPath) {
      try {
        const raw = fs.readFileSync(diskPath, 'utf-8')
        this.data = JSON.parse(raw) as T
        // fetchedAt stays 0 so first get() treats it as stale and refreshes,
        // but this data is available as fallback if the refresh fails
      } catch {
        // No disk cache yet — that's fine
      }
    }
  }

  async get(): Promise<T | null> {
    if (this.data && Date.now() - this.fetchedAt < this.ttlMs) {
      return this.data
    }
    // Deduplicate concurrent fetches
    if (!this.inflight) {
      this.inflight = this.fetchFn()
        .then((result) => {
          if (result) {
            this.data = result
            this.fetchedAt = Date.now()
            this.writeToDisk(result)
          }
          this.inflight = null
          return result ?? this.data
        })
        .catch((err) => {
          console.error('Cache fetch error:', err)
          this.inflight = null
          return this.data // Return stale data on error
        })
    }
    return this.inflight
  }

  invalidate(): void {
    this.fetchedAt = 0
  }

  private writeToDisk(data: T): void {
    if (!this.diskPath) return
    try {
      fs.writeFileSync(this.diskPath, JSON.stringify(data))
    } catch (err) {
      console.error('Cache disk write error:', err)
    }
  }
}
