import type { HttpResponseHead } from './http-types'

export interface HttpRequest {
  method: string
  url: string
  headers?: Record<string, string>
  signal?: AbortSignal
}

export interface HttpBodyReader {
  read(): Promise<Uint8Array | null>
  cancel(reason?: string): void
}

export interface HttpTransportResponse {
  head: HttpResponseHead
  body: HttpBodyReader
  remoteAddress?: string
  finalUrl: string
}

export interface HttpTransport {
  request(request: HttpRequest): Promise<HttpTransportResponse>
}

