import { createPhaseZeroNodeIoDaemonCapabilities } from './capabilities'
import type { NodeIoDaemonConfig, NodeIoDaemonStatus } from './types'

export class NodeIoDaemonRuntime {
  private started = false

  constructor(private readonly daemonConfig: NodeIoDaemonConfig) {}

  get config(): Readonly<NodeIoDaemonConfig> {
    return this.daemonConfig
  }

  async start(): Promise<void> {
    this.started = true
  }

  async stop(): Promise<void> {
    this.started = false
  }

  getStatus(): NodeIoDaemonStatus {
    return {
      implementation: 'node-io-daemon',
      phase: 'phase0',
      started: this.started,
      host: this.daemonConfig.host,
      port: this.daemonConfig.port,
      bootstrapMode: this.daemonConfig.bootstrapMode,
      capabilities: createPhaseZeroNodeIoDaemonCapabilities(),
    }
  }
}
