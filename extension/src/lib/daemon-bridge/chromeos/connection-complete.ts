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
}): DaemonCapabilities {
  return {
    roots_manageable: capabilities?.roots_manageable !== false,
  }
}

export function buildConnectedDaemonInfo(options: {
  port: number
  token: string
  version?: string | null
  roots: DownloadRoot[]
  host: string
  capabilities?: { roots_manageable?: boolean }
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
