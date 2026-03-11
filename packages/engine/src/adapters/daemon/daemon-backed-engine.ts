import { BtEngine } from '../../core/bt-engine'
import { DaemonConnection } from './daemon-connection'
import {
  createDaemonEngine,
  type DaemonEngineConfig,
  resolveDaemonConnection,
} from '../../presets/daemon'
import {
  DaemonControlStreamService,
  type DaemonControlStreamConfig,
  type RegisterHttpStreamRequest,
} from './daemon-control-stream-service'

export interface DaemonBackedEngineConfig extends DaemonEngineConfig {
  controlStream?: DaemonControlStreamConfig | null
}

function controlConfigKey(config: DaemonControlStreamConfig): string {
  return `${config.host}:${config.port}:${config.token}:${config.extensionId}:${config.installId}`
}

export class DaemonBackedEngine {
  private controlStreamService: DaemonControlStreamService | null = null
  private controlStreamServiceKey: string | null = null

  constructor(
    public readonly engine: BtEngine,
    public readonly connection: DaemonConnection,
  ) {}

  static async create(config: DaemonBackedEngineConfig): Promise<DaemonBackedEngine> {
    const connection = await resolveDaemonConnection(config)
    const engine = await createDaemonEngine({
      ...config,
      connection,
    })
    const daemonBackedEngine = new DaemonBackedEngine(engine, connection)
    if (config.controlStream) {
      await daemonBackedEngine.ensureControlStream(config.controlStream)
    }
    return daemonBackedEngine
  }

  getControlStreamService(): DaemonControlStreamService | null {
    return this.controlStreamService
  }

  async ensureControlStream(
    config: DaemonControlStreamConfig,
  ): Promise<DaemonControlStreamService> {
    const key = controlConfigKey(config)
    if (this.controlStreamService && this.controlStreamServiceKey === key) {
      await this.controlStreamService.connect()
      return this.controlStreamService
    }

    this.closeControlStream()
    this.controlStreamService = new DaemonControlStreamService(this.engine, config)
    this.controlStreamServiceKey = key
    await this.controlStreamService.connect()
    return this.controlStreamService
  }

  closeControlStream(): void {
    this.controlStreamService?.close()
    this.controlStreamService = null
    this.controlStreamServiceKey = null
  }

  async registerHttpStream(
    config: DaemonControlStreamConfig,
    request: RegisterHttpStreamRequest,
  ): Promise<{ mediaPort: number }> {
    const controlStream = await this.ensureControlStream(config)
    return controlStream.registerHttpStream(request)
  }

  async destroy(): Promise<void> {
    this.closeControlStream()
    await this.engine.destroy()
    this.connection.close()
  }
}
