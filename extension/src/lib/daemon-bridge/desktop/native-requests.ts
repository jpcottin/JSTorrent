export interface NativePortLike {
  onMessage: {
    addListener: (listener: (msg: unknown) => void) => void
  }
  postMessage: (msg: unknown) => void
}

export async function sendNativeRequest(
  nativePort: NativePortLike | null,
  op: string,
  params: Record<string, unknown>,
  timeoutMs = 10000,
): Promise<{ ok: boolean; error?: string }> {
  const response = await sendNativeRequestFull(nativePort, op, params, timeoutMs)
  return { ok: (response.ok as boolean) ?? false, error: response.error as string | undefined }
}

export async function sendNativeRequestFull(
  nativePort: NativePortLike | null,
  op: string,
  params: Record<string, unknown>,
  timeoutMs = 10000,
): Promise<Record<string, unknown>> {
  if (!nativePort) {
    return { ok: false, error: 'Not connected' }
  }

  return new Promise((resolve) => {
    const requestId = crypto.randomUUID()
    let resolved = false

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        resolve({ ok: false, error: 'Request timed out' })
      }
    }, timeoutMs)

    const handler = (msg: unknown) => {
      if (resolved) return
      if (typeof msg !== 'object' || msg === null) return
      const response = msg as Record<string, unknown>

      if (response.id !== requestId) return

      resolved = true
      clearTimeout(timeout)
      resolve(response)
    }

    nativePort.onMessage.addListener(handler)
    nativePort.postMessage({ op, ...params, id: requestId })
  })
}
