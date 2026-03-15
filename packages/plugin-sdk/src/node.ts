// Node-only runtime exports (depends on happy-dom)
// Import from '@jstorrent/plugin-sdk/node' — NOT from the main entry.

export { transformModuleSource } from './runtime/transform.js'
export { loadPlugin } from './runtime/load-module.js'
export { runPlugin } from './runtime/runner.js'
export { initParseHtml, parseHtml } from './runtime/node-html.js'
export type { RunPluginOptions, RunPluginResult } from './runtime/runner.js'
