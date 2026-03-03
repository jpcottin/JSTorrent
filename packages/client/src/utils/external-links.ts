/**
 * Platform-aware external URL opener.
 *
 * In Tauri desktop apps, `window.open()` is a no-op — we need to use the
 * Tauri opener plugin to launch the system browser. In browser/extension
 * contexts, `window.open()` works normally.
 *
 * The Tauri app registers its opener at startup via `registerExternalUrlOpener`,
 * so `@jstorrent/client` doesn't need `@tauri-apps/plugin-opener` as a dependency.
 */

let registeredOpener: ((url: string) => Promise<void>) | null = null

export function registerExternalUrlOpener(opener: (url: string) => Promise<void>) {
  registeredOpener = opener
}

/**
 * Open a URL in the user's default browser.
 *
 * - Tauri: uses the opener registered at startup (plugin-opener)
 * - Browser/extension: delegates to `window.open(url, '_blank')`
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (registeredOpener) {
    await registeredOpener(url)
  } else {
    window.open(url, '_blank')
  }
}
