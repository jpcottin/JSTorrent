import type { FetchLike } from '../chromeos/http-api'

export async function checkDaemonHealth(options: {
  fetchImpl: FetchLike
  host: string
  port: number
}): Promise<boolean> {
  const { fetchImpl, host, port } = options

  try {
    const response = await fetchImpl(`http://${host}:${port}/health`)
    return response.ok
  } catch {
    return false
  }
}

export function restartHealthCheck(options: {
  existingInterval: ReturnType<typeof setInterval> | null
  fetchImpl: FetchLike
  host: string
  port: number
  onUnhealthy: () => void
  intervalMs?: number
}): ReturnType<typeof setInterval> {
  const { existingInterval, fetchImpl, host, port, onUnhealthy, intervalMs = 5000 } = options

  if (existingInterval) {
    clearInterval(existingInterval)
  }

  return setInterval(async () => {
    const healthy = await checkDaemonHealth({ fetchImpl, host, port })
    if (!healthy) {
      onUnhealthy()
    }
  }, intervalMs)
}
