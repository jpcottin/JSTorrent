import {
  ILoggingEngine,
  Logger,
  EngineComponent,
  createFilter,
  withScopeAndFiltering,
  globalLogStore,
} from '../../src/logging/logger'
import { BandwidthTracker } from '../../src/core/bandwidth-tracker'
import { IHasher } from '../../src/interfaces/hasher'

// Simple mock hasher using SubtleCrypto
const mockHasher: IHasher = {
  async sha1(data: Uint8Array): Promise<Uint8Array> {
    const hash = await crypto.subtle.digest('SHA-1', data)
    return new Uint8Array(hash)
  },
  async sha1Batch(inputs: Uint8Array[]): Promise<Uint8Array[]> {
    return Promise.all(
      inputs.map(async (data) => {
        const hash = await crypto.subtle.digest('SHA-1', data)
        return new Uint8Array(hash)
      }),
    )
  },
}

export class MockEngine implements ILoggingEngine {
  clientId = 'mock-client'
  filterFn = createFilter({ level: 'debug' })
  bandwidthTracker = new BandwidthTracker()
  listeningPort = 6881
  hasher = mockHasher

  /** Process incoming data immediately (no tick-aligned batching) for test convenience */
  autoDrainBuffers = true

  scopedLoggerFor(component: EngineComponent): Logger {
    return withScopeAndFiltering(component, this.filterFn, {
      onCapture: (entry) => globalLogStore.add(entry.level, entry.message, entry.args),
    })
  }
}
