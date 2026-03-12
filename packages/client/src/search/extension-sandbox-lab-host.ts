import type {
  SearchPluginDraftRunResult,
  SearchPluginFetchInput,
  SearchPluginFetchPolicy,
  SearchPluginFetchResponse,
  SearchPluginSourceInspection,
  SearchPluginSearchInput,
} from './types'
import { normalizeSearchPluginManifest } from './plugin-utils'

interface SandboxReadyMessage {
  __jstSearchPluginSandbox: true
  type: 'ready'
}

interface SandboxRunResultMessage {
  __jstSearchPluginSandbox: true
  type: 'run-result'
  requestId: number
  result: SearchPluginDraftRunResult
}

interface SandboxInspectResultMessage {
  __jstSearchPluginSandbox: true
  type: 'inspect-result'
  requestId: number
  inspection?: SearchPluginSourceInspection
  error?: {
    name: string
    message: string
    stack?: string
  }
}

interface SandboxFetchRequestMessage {
  __jstSearchPluginSandbox: true
  type: 'fetch-request'
  requestId: number
  fetchRequestId: number
  input: SearchPluginFetchInput
}

type SandboxMessage =
  | SandboxReadyMessage
  | SandboxRunResultMessage
  | SandboxInspectResultMessage
  | SandboxFetchRequestMessage

interface Fetcher {
  fetch(
    input: SearchPluginFetchInput,
    policy?: SearchPluginFetchPolicy,
  ): Promise<SearchPluginFetchResponse>
}

interface PendingRequest {
  resolve: (result: SearchPluginDraftRunResult) => void
  reject: (error: Error) => void
}

interface PendingInspection {
  resolve: (inspection: SearchPluginSourceInspection) => void
  reject: (error: Error) => void
}

const SANDBOX_PATH = 'search-plugin-sandbox.html'

function getChromeRuntimeUrl(path: string): string | null {
  const chromeApi = (globalThis as { chrome?: typeof chrome }).chrome
  if (!chromeApi?.runtime?.id) return null
  return chromeApi.runtime.getURL(path)
}

export class ExtensionSandboxLabHost {
  private iframe: HTMLIFrameElement | null = null
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private nextRequestId = 1
  private pending = new Map<number, PendingRequest>()
  private pendingInspections = new Map<number, PendingInspection>()
  private requestPolicies = new Map<number, SearchPluginFetchPolicy>()
  private readonly handleMessageBound = this.handleMessage.bind(this)

  constructor(private readonly fetcher: Fetcher) {
    window.addEventListener('message', this.handleMessageBound)
  }

  isAvailable(): boolean {
    return getChromeRuntimeUrl(SANDBOX_PATH) !== null
  }

  async fetchSource(url: string): Promise<string> {
    const response = await this.fetcher.fetch({ url, method: 'GET' })
    if (response.statusCode >= 400) {
      throw new Error(`Failed to fetch plugin source: HTTP ${response.statusCode}`)
    }
    return response.bodyText
  }

  async runDraft(
    source: string,
    input: SearchPluginSearchInput,
  ): Promise<SearchPluginDraftRunResult> {
    await this.ensureReady()
    if (!this.iframe?.contentWindow) {
      throw new Error('Sandbox iframe is not available')
    }

    const inspection = await this.inspectSource(source)
    const requestId = this.nextRequestId++
    const result = new Promise<SearchPluginDraftRunResult>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
    })
    this.requestPolicies.set(requestId, { allowedHosts: inspection.manifest.hosts })

    this.iframe.contentWindow.postMessage(
      {
        __jstSearchPluginSandbox: true,
        type: 'run-draft',
        requestId,
        source,
        input,
      },
      '*',
    )

    return result
  }

  async inspectSource(source: string): Promise<SearchPluginSourceInspection> {
    await this.ensureReady()
    if (!this.iframe?.contentWindow) {
      throw new Error('Sandbox iframe is not available')
    }

    const requestId = this.nextRequestId++
    const result = new Promise<SearchPluginSourceInspection>((resolve, reject) => {
      this.pendingInspections.set(requestId, { resolve, reject })
    })

    this.iframe.contentWindow.postMessage(
      {
        __jstSearchPluginSandbox: true,
        type: 'inspect-source',
        requestId,
        source,
      },
      '*',
    )

    return result
  }

  dispose(): void {
    window.removeEventListener('message', this.handleMessageBound)
    for (const { reject } of this.pending.values()) {
      reject(new Error('Sandbox host disposed'))
    }
    this.pending.clear()
    for (const { reject } of this.pendingInspections.values()) {
      reject(new Error('Sandbox host disposed'))
    }
    this.pendingInspections.clear()
    this.requestPolicies.clear()
    this.iframe?.remove()
    this.iframe = null
    this.readyPromise = null
    this.readyResolve = null
  }

  private async ensureReady(): Promise<void> {
    if (!this.isAvailable()) {
      throw new Error('Search plugin lab is only available in the Chrome extension context')
    }

    if (this.readyPromise) {
      return this.readyPromise
    }

    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve
    })

    const iframe = document.createElement('iframe')
    iframe.src = getChromeRuntimeUrl(SANDBOX_PATH)!
    iframe.style.display = 'none'
    iframe.setAttribute('aria-hidden', 'true')
    document.body.appendChild(iframe)
    this.iframe = iframe

    return this.readyPromise
  }

  private handleMessage(event: MessageEvent<SandboxMessage>): void {
    if (event.source !== this.iframe?.contentWindow) return
    const data = event.data
    if (!data || data.__jstSearchPluginSandbox !== true) return

    if (data.type === 'ready') {
      this.readyResolve?.()
      this.readyResolve = null
      return
    }

    if (data.type === 'run-result') {
      const pending = this.pending.get(data.requestId)
      if (!pending) return
      this.pending.delete(data.requestId)
      this.requestPolicies.delete(data.requestId)
      pending.resolve(data.result)
      return
    }

    if (data.type === 'inspect-result') {
      const pending = this.pendingInspections.get(data.requestId)
      if (!pending) return
      this.pendingInspections.delete(data.requestId)
      if (data.error) {
        pending.reject(new Error(data.error.message))
        return
      }
      if (!data.inspection) {
        pending.reject(new Error('Sandbox inspection returned no manifest'))
        return
      }
      pending.resolve({
        manifest: normalizeSearchPluginManifest(data.inspection.manifest),
      })
      return
    }

    if (data.type === 'fetch-request') {
      void this.handleFetchRequest(data)
    }
  }

  private async handleFetchRequest(message: SandboxFetchRequestMessage): Promise<void> {
    if (!this.iframe?.contentWindow) {
      return
    }

    try {
      const response = await this.fetcher.fetch(
        message.input,
        this.requestPolicies.get(message.requestId),
      )
      this.iframe.contentWindow.postMessage(
        {
          __jstSearchPluginSandbox: true,
          type: 'fetch-response',
          requestId: message.requestId,
          fetchRequestId: message.fetchRequestId,
          response,
        },
        '*',
      )
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      this.iframe.contentWindow.postMessage(
        {
          __jstSearchPluginSandbox: true,
          type: 'fetch-response',
          requestId: message.requestId,
          fetchRequestId: message.fetchRequestId,
          error: {
            name: error instanceof Error ? error.name : 'Error',
            message: messageText,
          },
        },
        '*',
      )
    }
  }
}
