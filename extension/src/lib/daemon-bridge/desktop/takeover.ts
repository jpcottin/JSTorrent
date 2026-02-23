import type { DaemonInfo } from '../../native-connection'

export interface TakeOverOptions {
  nativePort: chrome.runtime.Port | null
  runtimeId: string
  clientVersion: string
  profileId: string | null
  isDaemonInfoMessage: (msg: unknown) => boolean
  onSuccess: (payload: DaemonInfo) => void
  timeoutMs?: number
}

export async function requestDesktopTakeOver(options: TakeOverOptions): Promise<boolean> {
  const {
    nativePort,
    runtimeId,
    clientVersion,
    profileId,
    isDaemonInfoMessage,
    onSuccess,
    timeoutMs = 15000,
  } = options

  if (!nativePort) return false

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      nativePort.onMessage.removeListener(handler)
      resolve(false)
    }, timeoutMs)

    const handler = (msg: unknown) => {
      if (isDaemonInfoMessage(msg)) {
        clearTimeout(timeout)
        nativePort.onMessage.removeListener(handler)
        const payload = (msg as { payload: DaemonInfo }).payload
        onSuccess(payload)
        resolve(true)
      }
    }

    nativePort.onMessage.addListener(handler)
    nativePort.postMessage({
      op: 'takeOver',
      extensionId: runtimeId,
      profileId,
      clientType: 'extension',
      clientVersion,
      id: crypto.randomUUID(),
    })
  })
}
