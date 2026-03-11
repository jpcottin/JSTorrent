if (typeof globalThis.WebSocket === 'undefined') {
  const { WebSocket } = await import('ws')

  Object.defineProperty(globalThis, 'WebSocket', {
    value: WebSocket,
    configurable: true,
    writable: true,
  })
}
