import { describe, it, expect, beforeEach } from 'vitest'
import { TorrentDiskQueue } from '../../src/core/disk-queue'

describe('TorrentDiskQueue', () => {
  let queue: TorrentDiskQueue

  beforeEach(() => {
    queue = new TorrentDiskQueue({ maxWorkers: 2 })
  })

  describe('enqueue', () => {
    it('should execute jobs immediately when under capacity', async () => {
      const executed: number[] = []

      await queue.enqueue({ type: 'write', pieceIndex: 1, fileCount: 1, size: 1000 }, async () => {
        executed.push(1)
      })

      expect(executed).toEqual([1])
    })

    it('should queue jobs when at capacity', async () => {
      const order: number[] = []
      const resolvers: Array<() => void> = []

      // Create 3 jobs, queue has capacity 2
      const job1 = queue.enqueue(
        { type: 'write', pieceIndex: 1, fileCount: 1, size: 1000 },
        () =>
          new Promise((r) => {
            resolvers[0] = () => {
              order.push(1)
              r()
            }
          }),
      )
      const job2 = queue.enqueue(
        { type: 'write', pieceIndex: 2, fileCount: 1, size: 1000 },
        () =>
          new Promise((r) => {
            resolvers[1] = () => {
              order.push(2)
              r()
            }
          }),
      )
      const job3 = queue.enqueue(
        { type: 'write', pieceIndex: 3, fileCount: 1, size: 1000 },
        () =>
          new Promise((r) => {
            resolvers[2] = () => {
              order.push(3)
              r()
            }
          }),
      )

      // Check snapshot - should have 2 running, 1 pending
      const snapshot1 = queue.getSnapshot()
      expect(snapshot1.running.length).toBe(2)
      expect(snapshot1.pending.length).toBe(1)

      // Complete first job
      resolvers[0]()
      await job1

      // Job 3 should now be running
      const snapshot2 = queue.getSnapshot()
      expect(snapshot2.running.length).toBe(2)
      expect(snapshot2.pending.length).toBe(0)

      // Complete remaining
      resolvers[1]()
      resolvers[2]()
      await Promise.all([job2, job3])

      expect(order).toEqual([1, 2, 3])
    })
  })

  describe('getSnapshot', () => {
    it('should return empty snapshot initially', () => {
      const snapshot = queue.getSnapshot()
      expect(snapshot.pending).toEqual([])
      expect(snapshot.running).toEqual([])
      expect(snapshot.draining).toBe(false)
    })

    it('should include job details in snapshot', async () => {
      let resolver: () => void

      queue.enqueue({ type: 'write', pieceIndex: 42, fileCount: 2, size: 16384 }, () => {
        return new Promise((r) => {
          resolver = r
        })
      })

      const snapshot = queue.getSnapshot()
      expect(snapshot.running.length).toBe(1)
      expect(snapshot.running[0].pieceIndex).toBe(42)
      expect(snapshot.running[0].fileCount).toBe(2)
      expect(snapshot.running[0].size).toBe(16384)
      expect(snapshot.running[0].type).toBe('write')
      expect(snapshot.running[0].status).toBe('running')
      expect(snapshot.running[0].startedAt).toBeDefined()

      resolver!()
    })

    it('should return copies, not references', async () => {
      let resolver: () => void

      queue.enqueue(
        { type: 'write', pieceIndex: 1, fileCount: 1, size: 1000 },
        () =>
          new Promise((r) => {
            resolver = r
          }),
      )

      const snapshot1 = queue.getSnapshot()
      const snapshot2 = queue.getSnapshot()

      expect(snapshot1.running).not.toBe(snapshot2.running)
      expect(snapshot1.running[0]).not.toBe(snapshot2.running[0])

      resolver!()
    })
  })

  describe('drain', () => {
    it('should resolve immediately if no jobs running', async () => {
      await queue.drain()
      expect(queue.getSnapshot().draining).toBe(true)
    })

    it('should wait for running jobs to complete', async () => {
      let resolver: () => void
      let drained = false

      queue.enqueue(
        { type: 'write', pieceIndex: 1, fileCount: 1, size: 1000 },
        () =>
          new Promise((r) => {
            resolver = r
          }),
      )

      const drainPromise = queue.drain().then(() => {
        drained = true
      })

      // Should not be drained yet
      expect(drained).toBe(false)
      expect(queue.getSnapshot().draining).toBe(true)

      // Complete the job
      resolver!()
      await drainPromise

      expect(drained).toBe(true)
    })

    it('should not start new jobs while draining', async () => {
      let resolver1: () => void
      const started: number[] = []

      queue.enqueue(
        { type: 'write', pieceIndex: 1, fileCount: 1, size: 1000 },
        () =>
          new Promise((r) => {
            started.push(1)
            resolver1 = r
          }),
      )

      // Start draining
      const drainPromise = queue.drain()

      // Try to enqueue another job
      queue.enqueue(
        { type: 'write', pieceIndex: 2, fileCount: 1, size: 1000 },
        () =>
          new Promise(() => {
            started.push(2)
          }),
      )

      // Job 2 should be pending, not started
      expect(started).toEqual([1])
      expect(queue.getSnapshot().pending.length).toBe(1)

      resolver1!()
      await drainPromise

      // Still pending after drain
      expect(started).toEqual([1])
    })
  })

  describe('resume', () => {
    it('should start pending jobs after resume', async () => {
      let resolver1: () => void
      let resolver2: () => void
      const started: number[] = []

      const job1Promise = queue.enqueue(
        { type: 'write', pieceIndex: 1, fileCount: 1, size: 1000 },
        () =>
          new Promise((r) => {
            started.push(1)
            resolver1 = r
          }),
      )

      const drainPromise = queue.drain()
      resolver1!()
      await job1Promise
      await drainPromise

      queue.enqueue(
        { type: 'write', pieceIndex: 2, fileCount: 1, size: 1000 },
        () =>
          new Promise((r) => {
            started.push(2)
            resolver2 = r
          }),
      )

      // Still draining, job 2 not started
      expect(started).toEqual([1])

      // Resume
      queue.resume()

      // Now job 2 should start
      expect(started).toEqual([1, 2])

      resolver2!()
    })
  })

  describe('maxWorkers config', () => {
    it('should respect custom maxWorkers', async () => {
      const queue4 = new TorrentDiskQueue({ maxWorkers: 4 })
      const resolvers: Array<() => void> = []

      for (let i = 0; i < 6; i++) {
        queue4.enqueue(
          { type: 'write', pieceIndex: i, fileCount: 1, size: 1000 },
          () =>
            new Promise((r) => {
              resolvers.push(r)
            }),
        )
      }

      const snapshot = queue4.getSnapshot()
      expect(snapshot.running.length).toBe(4)
      expect(snapshot.pending.length).toBe(2)

      resolvers.forEach((r) => r())
    })
  })

  describe('pendingBytes', () => {
    it('should start at 0', () => {
      expect(queue.pendingBytes).toBe(0)
    })

    it('should increment when jobs are enqueued', async () => {
      let resolver: () => void

      // Block both workers
      queue.enqueue(
        { type: 'write', pieceIndex: 1, fileCount: 1, size: 1000 },
        () =>
          new Promise((r) => {
            resolver = r
          }),
      )
      queue.enqueue(
        { type: 'write', pieceIndex: 2, fileCount: 1, size: 2000 },
        () => new Promise(() => {}),
      )

      // Third job should be pending
      queue.enqueue({ type: 'write', pieceIndex: 3, fileCount: 1, size: 5000 }, () =>
        Promise.resolve(),
      )

      expect(queue.pendingBytes).toBe(5000)

      resolver!()
    })

    it('should decrement when pending jobs start running', async () => {
      let resolver1: () => void
      let resolver2: () => void
      let job3Started = false
      let resolver3: () => void

      const job1Promise = queue.enqueue(
        { type: 'write', pieceIndex: 1, fileCount: 1, size: 1000 },
        () =>
          new Promise((r) => {
            resolver1 = r
          }),
      )

      // Block both workers
      queue.enqueue(
        { type: 'write', pieceIndex: 2, fileCount: 1, size: 2000 },
        () =>
          new Promise((r) => {
            resolver2 = r
          }),
      )

      // Third job is pending
      queue.enqueue(
        { type: 'write', pieceIndex: 3, fileCount: 1, size: 3000 },
        () =>
          new Promise((r) => {
            job3Started = true
            resolver3 = r
          }),
      )

      expect(queue.pendingBytes).toBe(3000)

      // Complete first job, third job should start
      resolver1!()
      await job1Promise // Wait for job 1 to actually complete (and job 3 to start)

      // Job 3 should have started, leaving nothing pending
      expect(job3Started).toBe(true)
      expect(queue.pendingBytes).toBe(0)

      // Cleanup
      resolver2!()
      resolver3!()
    })

    it('should reset to 0 on clearPending', async () => {
      // Block both workers
      queue.enqueue(
        { type: 'write', pieceIndex: 1, fileCount: 1, size: 1000 },
        () => new Promise(() => {}),
      )
      queue.enqueue(
        { type: 'write', pieceIndex: 2, fileCount: 1, size: 2000 },
        () => new Promise(() => {}),
      )

      // Third job is pending - catch the rejection since clearPending will reject it
      const job3Promise = queue
        .enqueue({ type: 'write', pieceIndex: 3, fileCount: 1, size: 5000 }, () =>
          Promise.resolve(),
        )
        .catch(() => {}) // Ignore the rejection

      expect(queue.pendingBytes).toBe(5000)

      queue.clearPending()

      expect(queue.pendingBytes).toBe(0)
      await job3Promise // Ensure the rejection is handled
    })
  })

  describe('pendingCount', () => {
    it('should start at 0', () => {
      expect(queue.pendingCount).toBe(0)
    })

    it('should reflect number of pending jobs', async () => {
      // Block both workers
      queue.enqueue(
        { type: 'write', pieceIndex: 1, fileCount: 1, size: 1000 },
        () => new Promise(() => {}),
      )
      queue.enqueue(
        { type: 'write', pieceIndex: 2, fileCount: 1, size: 2000 },
        () => new Promise(() => {}),
      )

      expect(queue.pendingCount).toBe(0) // Both are running

      // Third and fourth jobs are pending
      queue.enqueue({ type: 'write', pieceIndex: 3, fileCount: 1, size: 3000 }, () =>
        Promise.resolve(),
      )
      queue.enqueue({ type: 'write', pieceIndex: 4, fileCount: 1, size: 4000 }, () =>
        Promise.resolve(),
      )

      expect(queue.pendingCount).toBe(2)
    })
  })

  describe('grabPending', () => {
    it('should return empty array when no pending jobs', () => {
      const grabbed = queue.grabPending(10000, 10)
      expect(grabbed).toEqual([])
    })

    it('should grab pending jobs up to maxCount', async () => {
      // Block both workers
      queue.enqueue(
        { type: 'write', pieceIndex: 1, fileCount: 1, size: 1000 },
        () => new Promise(() => {}),
      )
      queue.enqueue(
        { type: 'write', pieceIndex: 2, fileCount: 1, size: 2000 },
        () => new Promise(() => {}),
      )

      // Add 5 pending jobs
      for (let i = 0; i < 5; i++) {
        queue.enqueue({ type: 'write', pieceIndex: 10 + i, fileCount: 1, size: 1000 }, () =>
          Promise.resolve(),
        )
      }

      expect(queue.pendingCount).toBe(5)
      expect(queue.pendingBytes).toBe(5000)

      // Grab only 2 jobs
      const grabbed = queue.grabPending(100000, 2)

      expect(grabbed.length).toBe(2)
      expect(grabbed[0].job.pieceIndex).toBe(10)
      expect(grabbed[1].job.pieceIndex).toBe(11)
      expect(queue.pendingCount).toBe(3)
      expect(queue.pendingBytes).toBe(3000)
    })

    it('should grab pending jobs up to maxBytes', async () => {
      // Block both workers
      queue.enqueue(
        { type: 'write', pieceIndex: 1, fileCount: 1, size: 1000 },
        () => new Promise(() => {}),
      )
      queue.enqueue(
        { type: 'write', pieceIndex: 2, fileCount: 1, size: 2000 },
        () => new Promise(() => {}),
      )

      // Add pending jobs of various sizes
      queue.enqueue({ type: 'write', pieceIndex: 10, fileCount: 1, size: 500 }, () =>
        Promise.resolve(),
      )
      queue.enqueue({ type: 'write', pieceIndex: 11, fileCount: 1, size: 600 }, () =>
        Promise.resolve(),
      )
      queue.enqueue({ type: 'write', pieceIndex: 12, fileCount: 1, size: 700 }, () =>
        Promise.resolve(),
      )

      expect(queue.pendingBytes).toBe(1800)

      // Grab up to 1000 bytes
      const grabbed = queue.grabPending(1000, 100)

      // Should grab first two: 500 + 600 = 1100 bytes (stops because exceeds maxBytes)
      expect(grabbed.length).toBe(2)
      expect(grabbed[0].job.size).toBe(500)
      expect(grabbed[1].job.size).toBe(600)
      expect(queue.pendingBytes).toBe(700)
    })

    it('should update pendingBytes correctly when grabbing', async () => {
      // Block both workers
      queue.enqueue(
        { type: 'write', pieceIndex: 1, fileCount: 1, size: 1000 },
        () => new Promise(() => {}),
      )
      queue.enqueue(
        { type: 'write', pieceIndex: 2, fileCount: 1, size: 2000 },
        () => new Promise(() => {}),
      )

      // Add pending jobs
      queue.enqueue({ type: 'write', pieceIndex: 10, fileCount: 1, size: 1000 }, () =>
        Promise.resolve(),
      )
      queue.enqueue({ type: 'write', pieceIndex: 11, fileCount: 1, size: 2000 }, () =>
        Promise.resolve(),
      )
      queue.enqueue({ type: 'write', pieceIndex: 12, fileCount: 1, size: 3000 }, () =>
        Promise.resolve(),
      )

      expect(queue.pendingBytes).toBe(6000)

      const grabbed = queue.grabPending(10000, 2)

      expect(grabbed.length).toBe(2)
      expect(queue.pendingBytes).toBe(3000) // Only 3000-byte job remaining
    })

    it('should return jobs with execute callbacks that can be called', async () => {
      let executed = false

      // Block both workers
      queue.enqueue(
        { type: 'write', pieceIndex: 1, fileCount: 1, size: 1000 },
        () => new Promise(() => {}),
      )
      queue.enqueue(
        { type: 'write', pieceIndex: 2, fileCount: 1, size: 2000 },
        () => new Promise(() => {}),
      )

      // Add pending job with side effect
      queue.enqueue({ type: 'write', pieceIndex: 10, fileCount: 1, size: 1000 }, async () => {
        executed = true
      })

      const grabbed = queue.grabPending(10000, 10)

      expect(grabbed.length).toBe(1)
      expect(executed).toBe(false)

      // Execute the grabbed job
      await grabbed[0].execute()

      expect(executed).toBe(true)
    })
  })
})
