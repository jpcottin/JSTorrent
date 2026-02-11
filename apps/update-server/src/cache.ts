export class Cache<T> {
  private data: T | null = null
  private fetchedAt = 0
  private inflight: Promise<T | null> | null = null

  constructor(
    private fetchFn: () => Promise<T | null>,
    private ttlMs: number,
  ) {}

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
}
