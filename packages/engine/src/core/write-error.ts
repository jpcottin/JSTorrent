/**
 * Unified write error classification for both daemon (Rust/Android) and native platforms.
 *
 * Errors are classified by recoverability to enable intelligent retry logic:
 * - Fatal errors: Stop immediately, user intervention required
 * - Transient errors: Retry with exponential backoff
 * - Hash mismatch: Re-request piece from different peers (existing logic)
 */

/** Classification of write errors by recoverability */
export enum WriteErrorType {
  // === Fatal errors - stop immediately, user must intervene ===

  /** Disk is full (ENOSPC). User must free space. */
  DISK_FULL = 'disk_full',

  /** Permission denied (EACCES). User must fix permissions or choose different location. */
  PERMISSION_DENIED = 'permission_denied',

  // === Recoverable via re-request from peers ===

  /** Hash verification failed. Piece is corrupt, re-request from different peers. */
  HASH_MISMATCH = 'hash_mismatch',

  // === Transient errors - retry with backoff ===

  /** Network error (fetch failed, WebSocket disconnected). Connection may recover. */
  NETWORK_ERROR = 'network_error',

  /** Generic I/O error that might be transient (file handle exhaustion, brief lock, etc). */
  IO_ERROR_TRANSIENT = 'io_transient',

  // === Bugs - don't retry, log loudly ===

  /** Invalid arguments passed to write operation. This is a bug. */
  INVALID_ARGS = 'invalid_args',

  /** Unknown error type. Treat as transient but log for investigation. */
  UNKNOWN = 'unknown',
}

/** Result codes from Android companion and native platforms */
export const WriteResultCode = {
  SUCCESS: 0,
  HASH_MISMATCH: 1,
  IO_ERROR: 2,
  INVALID_ARGS: 3,
  DISK_FULL: 4,
  PERMISSION_DENIED: 5,
} as const

export type WriteResultCodeValue = (typeof WriteResultCode)[keyof typeof WriteResultCode]

/** Custom error class that carries error classification */
export class WriteError extends Error {
  constructor(
    message: string,
    public readonly errorType: WriteErrorType,
    public readonly path?: string,
    public readonly cause?: Error,
  ) {
    super(message)
    this.name = 'WriteError'
  }

  /** Whether this error is fatal and should stop the torrent immediately */
  get isFatal(): boolean {
    return (
      this.errorType === WriteErrorType.DISK_FULL ||
      this.errorType === WriteErrorType.PERMISSION_DENIED
    )
  }

  /** Whether this error should trigger a retry */
  get isRetryable(): boolean {
    return (
      this.errorType === WriteErrorType.NETWORK_ERROR ||
      this.errorType === WriteErrorType.IO_ERROR_TRANSIENT ||
      this.errorType === WriteErrorType.UNKNOWN
    )
  }

  /** Whether this is a hash mismatch (handled by re-requesting piece) */
  get isHashMismatch(): boolean {
    return this.errorType === WriteErrorType.HASH_MISMATCH
  }
}

/** Retry configuration for transient errors */
export interface RetryConfig {
  maxRetries: number
  backoffMs: number[]
}

/** Default retry configurations by error type */
export const RETRY_CONFIG: Partial<Record<WriteErrorType, RetryConfig>> = {
  [WriteErrorType.NETWORK_ERROR]: {
    maxRetries: 5,
    backoffMs: [500, 1000, 2000, 4000, 8000],
  },
  [WriteErrorType.IO_ERROR_TRANSIENT]: {
    maxRetries: 3,
    backoffMs: [1000, 2000, 4000],
  },
  [WriteErrorType.UNKNOWN]: {
    maxRetries: 2,
    backoffMs: [1000, 2000],
  },
}

/**
 * Map result code from daemon to error type.
 * Used by both Android companion and Rust io-daemon.
 */
export function resultCodeToErrorType(code: number): WriteErrorType {
  switch (code) {
    case WriteResultCode.HASH_MISMATCH:
      return WriteErrorType.HASH_MISMATCH
    case WriteResultCode.IO_ERROR:
      return WriteErrorType.IO_ERROR_TRANSIENT
    case WriteResultCode.INVALID_ARGS:
      return WriteErrorType.INVALID_ARGS
    case WriteResultCode.DISK_FULL:
      return WriteErrorType.DISK_FULL
    case WriteResultCode.PERMISSION_DENIED:
      return WriteErrorType.PERMISSION_DENIED
    default:
      return WriteErrorType.UNKNOWN
  }
}

/**
 * Map HTTP status code to error type.
 * Used by Rust io-daemon HTTP responses.
 */
export function httpStatusToErrorType(status: number): WriteErrorType {
  switch (status) {
    case 409: // Conflict - hash mismatch
      return WriteErrorType.HASH_MISMATCH
    case 403: // Forbidden - permission denied
      return WriteErrorType.PERMISSION_DENIED
    case 507: // Insufficient Storage - disk full
      return WriteErrorType.DISK_FULL
    case 400: // Bad Request - invalid args
      return WriteErrorType.INVALID_ARGS
    case 500: // Internal Server Error
    case 502: // Bad Gateway
    case 503: // Service Unavailable
    case 504: // Gateway Timeout
      return WriteErrorType.IO_ERROR_TRANSIENT
    default:
      return WriteErrorType.UNKNOWN
  }
}

/**
 * Classify a caught error (from fetch or other sources) into WriteError.
 * Detects network errors, timeouts, and wraps unknown errors.
 */
export function classifyError(error: unknown, path?: string): WriteError {
  if (error instanceof WriteError) {
    return error
  }

  const message = error instanceof Error ? error.message : String(error)
  const cause = error instanceof Error ? error : undefined

  // Network errors from fetch
  if (
    message.includes('Failed to fetch') ||
    message.includes('NetworkError') ||
    message.includes('Network request failed') ||
    message.includes('net::ERR_') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ECONNRESET') ||
    message.includes('ETIMEDOUT') ||
    message.includes('ENETUNREACH') ||
    message.includes('WebSocket') ||
    message.includes('socket hang up')
  ) {
    return new WriteError(message, WriteErrorType.NETWORK_ERROR, path, cause)
  }

  // Disk full
  if (
    message.includes('ENOSPC') ||
    message.includes('No space') ||
    message.includes('disk full') ||
    message.includes('Disk full')
  ) {
    return new WriteError(message, WriteErrorType.DISK_FULL, path, cause)
  }

  // Permission denied
  if (
    message.includes('EACCES') ||
    message.includes('Permission denied') ||
    message.includes('EPERM')
  ) {
    return new WriteError(message, WriteErrorType.PERMISSION_DENIED, path, cause)
  }

  // Timeout (treat as transient network issue)
  if (message.includes('timeout') || message.includes('Timeout') || message.includes('timed out')) {
    return new WriteError(message, WriteErrorType.NETWORK_ERROR, path, cause)
  }

  // Default to transient I/O error (benefit of the doubt)
  return new WriteError(message, WriteErrorType.IO_ERROR_TRANSIENT, path, cause)
}

/**
 * Get retry delay for the given attempt number and error type.
 * Returns undefined if no more retries should be attempted.
 */
export function getRetryDelay(
  errorType: WriteErrorType,
  attemptNumber: number,
): number | undefined {
  const config = RETRY_CONFIG[errorType]
  if (!config) return undefined
  if (attemptNumber >= config.maxRetries) return undefined
  return config.backoffMs[Math.min(attemptNumber, config.backoffMs.length - 1)]
}
