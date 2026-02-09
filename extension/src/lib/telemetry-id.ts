const STORAGE_KEY = 'telemetryId'

// Singleton promise to prevent race conditions when multiple callers
// invoke getOrCreateTelemetryId() before storage is populated
let telemetryIdPromise: Promise<string> | null = null

export function getOrCreateTelemetryId(): Promise<string> {
  if (!telemetryIdPromise) {
    telemetryIdPromise = (async () => {
      const result = await chrome.storage.local.get(STORAGE_KEY)
      if (result[STORAGE_KEY]) {
        return result[STORAGE_KEY] as string
      }
      const newId = crypto.randomUUID()
      await chrome.storage.local.set({ [STORAGE_KEY]: newId })
      return newId
    })()
  }
  return telemetryIdPromise
}
