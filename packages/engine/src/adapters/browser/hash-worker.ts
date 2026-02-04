/**
 * Web Worker for SHA1 hashing using SubtleCrypto.
 * Receives ArrayBuffer via transferable, returns hash via transferable.
 *
 * This file is loaded as a Web Worker by worker-hasher.ts using:
 *   new Worker(new URL('./hash-worker.ts', import.meta.url), { type: 'module' })
 *
 * Vite compiles this TypeScript file automatically when building.
 */

interface HashRequest {
  id: number
  data?: ArrayBuffer
  batch?: ArrayBuffer[]
  /** If true, transfer the data buffer back along with the hash */
  returnData?: boolean
}

interface HashResponse {
  id: number
  hash?: ArrayBuffer
  hashes?: ArrayBuffer[]
  /** Original data buffer, returned when returnData was true */
  data?: ArrayBuffer
  error?: string
}

// Worker postMessage signature: postMessage(message, transfer)
// Use type assertion since the main thread Window.postMessage has different overloads
const workerSelf = self as unknown as {
  onmessage: ((e: MessageEvent<HashRequest>) => void) | null
  postMessage(message: HashResponse, transfer?: Transferable[]): void
}

workerSelf.onmessage = async (e: MessageEvent<HashRequest>) => {
  const { id, data, batch, returnData } = e.data

  try {
    if (batch) {
      const hashes = await Promise.all(batch.map((buf) => crypto.subtle.digest('SHA-1', buf)))
      workerSelf.postMessage({ id, hashes }, hashes as Transferable[])
    } else if (data) {
      const hash = await crypto.subtle.digest('SHA-1', data)
      if (returnData) {
        // Transfer both hash and original data back to main thread
        workerSelf.postMessage({ id, hash, data }, [hash, data])
      } else {
        workerSelf.postMessage({ id, hash }, [hash])
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Hash failed'
    workerSelf.postMessage({ id, error: message })
  }
}
