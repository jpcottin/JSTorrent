import type { DownloadRoot } from '../../native-connection'
import { sendNativeRequestFull, type NativePortLike } from './native-requests'

export interface RemoveRootResult {
  ok: boolean
  reason?: 'not_connected' | 'timeout' | 'unexpected'
  response?: Record<string, unknown>
}

export async function pickDownloadFolderDesktop(
  nativePort: NativePortLike | null,
): Promise<DownloadRoot | null> {
  const response = await sendNativeRequestFull(nativePort, 'pickDownloadDirectory', {})

  if (response.ok && response.type === 'RootAdded') {
    const payload = response.payload as { root?: DownloadRoot } | undefined
    if (payload?.root) {
      return payload.root
    }
  }

  return null
}

export async function removeDownloadRootDesktop(
  nativePort: NativePortLike | null,
  key: string,
): Promise<RemoveRootResult> {
  const response = await sendNativeRequestFull(nativePort, 'deleteDownloadRoot', { key })

  if (response.ok && response.type === 'RootRemoved') {
    return { ok: true, response }
  }

  if (response.error === 'Not connected') {
    return { ok: false, reason: 'not_connected', response }
  }

  if (response.error === 'Request timed out') {
    return { ok: false, reason: 'timeout', response }
  }

  return { ok: false, reason: 'unexpected', response }
}
