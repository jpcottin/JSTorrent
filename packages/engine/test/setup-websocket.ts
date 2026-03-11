import { WebSocket as NodeWebSocket } from 'ws'

if (typeof globalThis.WebSocket === 'undefined') {
  Object.defineProperty(globalThis, 'WebSocket', {
    value: NodeWebSocket,
    configurable: true,
    writable: true,
  })
}
