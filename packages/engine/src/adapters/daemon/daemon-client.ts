import { DaemonConnection } from './daemon-connection'
import { StorageRoot } from '../../storage/types'

/**
 * Response type from the daemon /roots endpoint.
 */
interface DaemonRoot {
  key: string
  uri: string
  display_name: string
  removable: boolean
  last_stat_ok: boolean
  last_checked: number
}

interface DaemonRootsResponse {
  roots: DaemonRoot[]
}

/**
 * Fetch storage roots from the daemon.
 * Converts the daemon's root format to the engine's StorageRoot format.
 */
export async function fetchDaemonRoots(connection: DaemonConnection): Promise<StorageRoot[]> {
  const response = await connection.request<DaemonRootsResponse>('GET', '/roots')
  return response.roots.map((r) => ({
    key: r.key,
    label: r.display_name,
    path: r.uri, // Use URI as path for daemon filesystem
  }))
}

/**
 * Response type from the daemon /status endpoint (Android companion server).
 */
export interface DaemonStatusResponse {
  port: number
  ioPort?: number // WebSocket port for /io endpoint (high-throughput server)
  streamingPort?: number // Streaming batch write server port (no memory aggregation)
  tcpSinkPort?: number
  nettyHttpPort?: number
  paired: boolean
  extensionId?: string
  installId?: string
  version?: string
  tokenValid?: boolean
}

/**
 * Fetch status from the daemon via POST /status.
 * Used to discover the ioPort for WebSocket connection.
 *
 * Note: Android companion server requires a chrome-extension:// Origin header.
 */
export async function fetchDaemonStatus(
  host: string,
  port: number,
  token: string,
  extensionId: string,
  installId: string,
): Promise<DaemonStatusResponse> {
  const url = `http://${host}:${port}/status`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-JST-Auth': token,
      'X-JST-ExtensionId': extensionId,
      'X-JST-InstallId': installId,
      Origin: `chrome-extension://${extensionId}`,
    },
    body: JSON.stringify({ token }),
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch daemon status: ${response.status} ${response.statusText}`)
  }

  return response.json() as Promise<DaemonStatusResponse>
}
