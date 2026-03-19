import type { DaemonCapabilities, DaemonInfo, DownloadRoot } from '../../native-connection'
import { mapCompanionRoots, type CompanionRoot } from '../protocol/root-mapper'
import type { FetchLike } from './http-api'

export async function fetchChromeosRoots(options: {
  fetchImpl: FetchLike
  host: string
  port: number
  headers: Record<string, string>
}): Promise<DownloadRoot[]> {
  const { fetchImpl, host, port, headers } = options

  const rootsResponse = await fetchImpl(`http://${host}:${port}/roots`, { headers })
  const rootsData = (await rootsResponse.json()) as {
    roots: CompanionRoot[]
  }

  return mapCompanionRoots(rootsData.roots)
}

export function buildDaemonCapabilities(capabilities?: {
  roots_manageable?: boolean
  lan_share_urls?: boolean
  free_space?: boolean
  write_atomic?: boolean
}): DaemonCapabilities {
  return {
    roots_manageable: capabilities?.roots_manageable !== false,
    lan_share_urls: capabilities?.lan_share_urls === true,
    free_space: capabilities?.free_space === true,
    write_atomic: capabilities?.write_atomic === true,
  }
}

export function buildConnectedDaemonInfo(options: {
  port: number
  token: string
  version?: string | null
  roots: DownloadRoot[]
  host: string
  capabilities?: {
    roots_manageable?: boolean
    lan_share_urls?: boolean
    free_space?: boolean
    write_atomic?: boolean
  }
  ioPort?: number
  streamingPort?: number
}): DaemonInfo {
  const { port, token, version, roots, host, capabilities, ioPort, streamingPort } = options

  return {
    port,
    token,
    version: version ?? 'unknown',
    roots,
    host,
    capabilities: buildDaemonCapabilities(capabilities),
    ioPort,
    streamingPort,
  }
}
