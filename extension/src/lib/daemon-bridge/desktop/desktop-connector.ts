import type { DaemonInfo } from '../../native-connection'

export interface DesktopProfileInUseInfo {
  profileId?: string
  clientType?: string
  clientVersion?: string
  browserName?: string
  pid?: number
  started?: number
}

interface ProfileInUseMessage {
  payload?: {
    profileId?: string
    clientType?: string
    clientVersion?: string
    browserName?: string
    pid?: number
    started?: number
  }
}

export interface ConnectDesktopOptions {
  connectNative: () => chrome.runtime.Port
  getDisconnectError: () => string
  runtimeId: string
  clientVersion: string
  storedProfileId: string | null
  isDaemonInfoMessage: (msg: unknown) => boolean
  isProfileInUseMessage: (msg: unknown) => boolean
  onConnected: (port: chrome.runtime.Port, payload: DaemonInfo) => void
  onProfileInUse: (port: chrome.runtime.Port, info: DesktopProfileInUseInfo | null) => void
  onDisconnectedAfterConnected: () => void
  onPostConnectionMessage: (msg: unknown) => void
  onMessageReceived?: (msg: unknown) => void
  onHandshakeBuilt?: (handshake: Record<string, unknown>) => void
  timeoutMs?: number
}

function toProfileInUseInfo(msg: unknown): DesktopProfileInUseInfo | null {
  const response = msg as ProfileInUseMessage
  return response.payload
    ? {
        profileId: response.payload.profileId,
        clientType: response.payload.clientType,
        clientVersion: response.payload.clientVersion,
        browserName: response.payload.browserName,
        pid: response.payload.pid,
        started: response.payload.started,
      }
    : null
}

export async function connectDesktopHandshake(options: ConnectDesktopOptions): Promise<void> {
  const {
    connectNative,
    getDisconnectError,
    runtimeId,
    clientVersion,
    storedProfileId,
    isDaemonInfoMessage,
    isProfileInUseMessage,
    onConnected,
    onProfileInUse,
    onDisconnectedAfterConnected,
    onPostConnectionMessage,
    onMessageReceived,
    onHandshakeBuilt,
    timeoutMs = 10000,
  } = options

  return new Promise((resolve, reject) => {
    const port = connectNative()

    let resolved = false
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        port.disconnect()
        reject(new Error('Handshake timeout'))
      }
    }, timeoutMs)

    port.onDisconnect.addListener(() => {
      const error = getDisconnectError() || 'Disconnected'
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        reject(new Error(error))
      } else {
        onDisconnectedAfterConnected()
      }
    })

    port.onMessage.addListener((msg: unknown) => {
      onMessageReceived?.(msg)

      if (!resolved && isProfileInUseMessage(msg)) {
        resolved = true
        clearTimeout(timeout)
        onProfileInUse(port, toProfileInUseInfo(msg))
        reject(new Error('profile_in_use'))
        return
      }

      if (!resolved && isDaemonInfoMessage(msg)) {
        resolved = true
        clearTimeout(timeout)

        const payload = (msg as { payload: DaemonInfo }).payload
        onConnected(port, payload)
        resolve()
      } else if (resolved) {
        onPostConnectionMessage(msg)
      }
    })

    const handshakeMsg = {
      op: 'handshake',
      extensionId: runtimeId,
      profileId: storedProfileId,
      clientType: 'extension',
      clientVersion,
      id: crypto.randomUUID(),
    }
    onHandshakeBuilt?.(handshakeMsg)
    port.postMessage(handshakeMsg)
  })
}
