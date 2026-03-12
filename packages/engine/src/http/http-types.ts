export interface ParsedHttpUrl {
  protocol: 'http:' | 'https:'
  hostname: string
  port: number
  pathname: string
  search: string
  path: string
  isHttps: boolean
}

export type HttpResponseBodyMode = 'none' | 'content-length' | 'chunked' | 'close-delimited'

export interface HttpResponseHead {
  statusCode: number
  statusMessage: string
  headers: Record<string, string>
  bodyMode: HttpResponseBodyMode
  contentLength: number | null
}

export type HttpParserEvent =
  | { type: 'head'; head: HttpResponseHead }
  | { type: 'body'; chunk: Uint8Array }
  | { type: 'end' }

