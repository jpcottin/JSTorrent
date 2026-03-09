export interface ChromeosDaemonStatus {
  port: number
  paired: boolean
  extensionId: string | null
  installId: string | null
  version: string | null
  capabilities?: { roots_manageable?: boolean; lan_share_urls?: boolean }
  ioPort?: number
  streamingPort?: number
}

export interface ChromeStorageLike {
  get(keys: string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export async function fetchChromeosStatus(options: {
  fetchImpl: FetchLike
  host: string
  port: number
  headers: Record<string, string>
}): Promise<ChromeosDaemonStatus> {
  const { fetchImpl, host, port, headers } = options

  const response = await fetchImpl(`http://${host}:${port}/status`, {
    method: 'POST',
    headers,
  })

  if (!response.ok) {
    throw new Error(`Status failed: ${response.status}`)
  }

  return (await response.json()) as ChromeosDaemonStatus
}

export async function requestChromeosPairing(options: {
  fetchImpl: FetchLike
  host: string
  port: number
  headers: Record<string, string>
  token: string
}): Promise<'approved' | 'pending' | 'conflict'> {
  const { fetchImpl, host, port, headers, token } = options

  try {
    const response = await fetchImpl(`http://${host}:${port}/pair`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token }),
    })

    if (response.ok) {
      const data = (await response.json()) as { status: string }
      return data.status as 'approved' | 'pending'
    }

    if (response.status === 409) {
      return 'conflict'
    }

    return 'pending'
  } catch {
    return 'pending'
  }
}

function uniqueNumbers(input: number[]): number[] {
  return Array.from(new Set(input))
}

export async function findChromeosDaemonPort(options: {
  storage: ChromeStorageLike
  fetchImpl: FetchLike
  storageKeyPort: string
  storageKeyHost: string
  hosts: string[]
  fallbackPorts: number[]
  timeoutMs?: number
}): Promise<{ host: string; port: number } | null> {
  const {
    storage,
    fetchImpl,
    storageKeyPort,
    storageKeyHost,
    hosts,
    fallbackPorts,
    timeoutMs = 2000,
  } = options

  const stored = await storage.get([storageKeyPort, storageKeyHost])

  const storedPort = stored[storageKeyPort]
  const ports = uniqueNumbers(
    [storedPort, ...fallbackPorts].filter((value): value is number => typeof value === 'number'),
  )

  const storedHost = stored[storageKeyHost]
  const hostsToTry =
    typeof storedHost === 'string'
      ? [storedHost, ...hosts.filter((host) => host !== storedHost)]
      : hosts

  for (const host of hostsToTry) {
    for (const port of ports) {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const response = await fetchImpl(`http://${host}:${port}/health`, {
          signal: controller.signal,
        })

        if (response.ok) {
          await storage.set({
            [storageKeyPort]: port,
            [storageKeyHost]: host,
          })

          return { host, port }
        }
      } catch {
        // Try next host/port
      } finally {
        clearTimeout(timeoutId)
      }
    }
  }

  return null
}
