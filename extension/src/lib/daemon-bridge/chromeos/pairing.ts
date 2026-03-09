export interface PairingStatus {
  paired: boolean
  extensionId: string | null
  installId: string | null
  version: string | null
  ioPort?: number
  streamingPort?: number
}

export type PairingRequestResult = 'approved' | 'pending' | 'conflict'

export interface EnsurePairingOptions {
  host: string
  port: number
  extensionId: string
  installId: string
  fetchStatus: (host: string, port: number) => Promise<PairingStatus>
  requestPairing: (host: string, port: number) => Promise<PairingRequestResult>
  completeConnection: (
    host: string,
    port: number,
    version?: string | null,
    ioPort?: number,
    streamingPort?: number,
  ) => Promise<void>
  wait: (ms: number) => Promise<void>
  conflictRetryMs?: number
  pollIntervalMs?: number
  maxPollAttempts?: number
}

function isPairedForCurrentClient(
  status: Pick<PairingStatus, 'paired' | 'extensionId' | 'installId'>,
  extensionId: string,
  installId: string,
): boolean {
  return status.paired && status.extensionId === extensionId && status.installId === installId
}

export async function ensureChromeosPairedAndConnect(
  options: EnsurePairingOptions,
): Promise<'connected' | 'timeout'> {
  const {
    host,
    port,
    extensionId,
    installId,
    fetchStatus,
    requestPairing,
    completeConnection,
    wait,
    conflictRetryMs = 2000,
    pollIntervalMs = 1000,
    maxPollAttempts = 60,
  } = options

  while (true) {
    const status = await fetchStatus(host, port)

    if (isPairedForCurrentClient(status, extensionId, installId)) {
      await completeConnection(host, port, status.version, status.ioPort, status.streamingPort)
      return 'connected'
    }

    const pairResult = await requestPairing(host, port)

    if (pairResult === 'approved') {
      const newStatus = await fetchStatus(host, port)
      await completeConnection(
        host,
        port,
        newStatus.version,
        newStatus.ioPort,
        newStatus.streamingPort,
      )
      return 'connected'
    }

    if (pairResult === 'conflict') {
      await wait(conflictRetryMs)
      continue
    }

    break
  }

  for (let i = 0; i < maxPollAttempts; i++) {
    await wait(pollIntervalMs)

    try {
      const status = await fetchStatus(host, port)
      if (isPairedForCurrentClient(status, extensionId, installId)) {
        await completeConnection(host, port, status.version, status.ioPort, status.streamingPort)
        return 'connected'
      }
    } catch {
      // Keep polling
    }
  }

  return 'timeout'
}
