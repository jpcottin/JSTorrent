import { NodeIoDaemonRuntime } from './daemon-runtime'
import { normalizeNodeIoDaemonConfig, type PartialNodeIoDaemonConfig } from './config'
import type { NodeIoDaemon } from './types'

export function createNodeIoDaemon(config: PartialNodeIoDaemonConfig = {}): NodeIoDaemon {
  const runtime = new NodeIoDaemonRuntime(normalizeNodeIoDaemonConfig(config))

  return {
    get config() {
      return runtime.config
    },
    start: () => runtime.start(),
    stop: () => runtime.stop(),
    getStatus: () => runtime.getStatus(),
  }
}
