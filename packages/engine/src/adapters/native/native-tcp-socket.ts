/**
 * Native TCP Socket
 *
 * Implements ITcpSocket using native bindings.
 */

import type { ITcpSocket } from '../../interfaces/socket'
import { callbackManager } from './callback-manager'
import './bindings.d.ts'

export class NativeTcpSocket implements ITcpSocket {
  private onDataCb: ((data: Uint8Array) => void) | null = null
  private onCloseCb: ((hadError: boolean) => void) | null = null
  private onErrorCb: ((err: Error) => void) | null = null
  private closed = false
  private closeFired = false

  // Buffer data that arrives before onData() is called (race condition fix)
  private pendingData: Uint8Array[] = []
  private pendingClose: { hadError: boolean } | null = null

  // Track pending connect promise for cancellation
  private pendingConnectReject: ((err: Error) => void) | null = null
  // Track pending secure promise for cancellation
  private pendingSecureReject: ((err: Error) => void) | null = null

  public remoteAddress?: string
  public remotePort?: number
  public isEncrypted?: boolean
  public isSecure?: boolean

  constructor(
    private readonly id: number,
    options?: { remoteAddress?: string; remotePort?: number },
  ) {
    if (options) {
      this.remoteAddress = options.remoteAddress
      this.remotePort = options.remotePort
    }

    console.log(`[NativeTcpSocket] Creating socket ${this.id}`)

    callbackManager.registerTcp(id, {
      onData: (data) => {
        if (this.onDataCb) {
          this.onDataCb(data)
        } else {
          // Buffer data until onData() is called (race condition with pending reader)
          this.pendingData.push(data)
        }
      },
      onClose: (hadError) => {
        if (this.closeFired) return
        this.closeFired = true
        this.closed = true
        console.log(`[NativeTcpSocket ${this.id}] onClose: hadError=${hadError}`)
        if (this.onCloseCb) {
          this.onCloseCb(hadError)
        } else {
          // Buffer close event until onClose() is called
          this.pendingClose = { hadError }
        }
        callbackManager.unregisterTcp(this.id)
      },
      onError: (err) => {
        console.log(`[NativeTcpSocket ${this.id}] onError: ${err.message}`)
        this.onErrorCb?.(err)
      },
    })
  }

  /**
   * Connect to a remote host and port.
   * Returns a promise that resolves when connected or rejects on error.
   */
  async connect(port: number, host: string): Promise<void> {
    if (this.closed) {
      throw new Error('Socket is closed')
    }

    console.log(`[NativeTcpSocket ${this.id}] Connecting to ${host}:${port}`)

    return new Promise((resolve, reject) => {
      // Store reject for cancellation on close()
      this.pendingConnectReject = reject

      callbackManager.updateTcpHandler(this.id, 'onConnect', (success, errorMessage) => {
        // Clear pending reject - promise is settling normally
        this.pendingConnectReject = null

        console.log(
          `[NativeTcpSocket ${this.id}] Connect result: success=${success}, error=${errorMessage}`,
        )
        if (success) {
          this.remoteAddress = host
          this.remotePort = port
          resolve()
        } else {
          reject(new Error(errorMessage || 'Connection failed'))
        }
      })
      __jstorrent_tcp_connect(this.id, host, port)
    })
  }

  /**
   * Send data to the remote peer.
   */
  send(data: Uint8Array): void {
    if (this.closed) return
    // Optimization: avoid ArrayBuffer.slice() copy when possible
    // If the Uint8Array covers the entire underlying buffer, pass it directly
    let buffer: ArrayBuffer
    if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
      buffer = data.buffer as ArrayBuffer
    } else {
      // Need to extract the relevant portion (Uint8Array is a view into larger buffer)
      buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    }
    __jstorrent_tcp_send(this.id, buffer)
  }

  /**
   * Register a callback for incoming data.
   * Flushes any data that arrived before this callback was registered.
   */
  onData(cb: (data: Uint8Array) => void): void {
    this.onDataCb = cb
    // Flush any buffered data (race condition with pending reader)
    if (this.pendingData.length > 0) {
      for (const data of this.pendingData) {
        cb(data)
      }
      this.pendingData = []
    }
  }

  /**
   * Register a callback for connection close.
   * Fires immediately if close already happened before this callback was registered.
   */
  onClose(cb: (hadError: boolean) => void): void {
    this.onCloseCb = cb
    // Fire buffered close event if it already happened
    if (this.pendingClose) {
      cb(this.pendingClose.hadError)
      this.pendingClose = null
    }
  }

  /**
   * Register a callback for errors.
   */
  onError(cb: (err: Error) => void): void {
    this.onErrorCb = cb
  }

  /**
   * Close the connection.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    __jstorrent_tcp_close(this.id)

    // Reject any pending connect promise so it doesn't hang
    if (this.pendingConnectReject) {
      console.log(`[NativeTcpSocket ${this.id}] Rejecting pending connect promise (socket closed)`)
      this.pendingConnectReject(new Error('Socket closed'))
      this.pendingConnectReject = null
    }

    // Reject any pending secure promise so it doesn't hang
    if (this.pendingSecureReject) {
      console.log(`[NativeTcpSocket ${this.id}] Rejecting pending secure promise (socket closed)`)
      this.pendingSecureReject(new Error('Socket closed'))
      this.pendingSecureReject = null
    }

    // Fire close callback if not already fired
    if (!this.closeFired) {
      this.closeFired = true
      this.onCloseCb?.(false)
      callbackManager.unregisterTcp(this.id)
    }
  }

  /**
   * Upgrade the connection to TLS.
   */
  async secure(hostname?: string): Promise<void> {
    if (this.closed) {
      throw new Error('Socket is closed')
    }

    const host = hostname || this.remoteAddress || ''
    console.log(`[NativeTcpSocket ${this.id}] Upgrading to TLS for ${host}`)

    return new Promise((resolve, reject) => {
      // Store reject for cancellation on close()
      this.pendingSecureReject = reject

      callbackManager.updateTcpHandler(this.id, 'onSecured', (success) => {
        // Clear pending reject - promise is settling normally
        this.pendingSecureReject = null

        console.log(`[NativeTcpSocket ${this.id}] TLS upgrade result: success=${success}`)
        if (success) {
          this.isSecure = true
          this.isEncrypted = true
          resolve()
        } else {
          reject(new Error('TLS upgrade failed'))
        }
      })
      __jstorrent_tcp_secure(this.id, host)
    })
  }
}
