/**
 * Platform-aware external URL opener.
 *
 * In Tauri desktop apps, `window.open()` is a no-op — we need to use the
 * Tauri opener plugin to launch the system browser. In browser/extension
 * contexts, `window.open()` works normally.
 *
 * The Tauri plugin is dynamically imported so `@jstorrent/client` doesn't
 * need it as a dependency; it only resolves inside the Tauri app where
 * `@tauri-apps/plugin-opener` is installed.
 */

function isTauriContext(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Open a URL in the user's default browser.
 *
 * - Tauri: delegates to `@tauri-apps/plugin-opener` → system browser
 * - Browser/extension: delegates to `window.open(url, '_blank')`
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauriContext()) {
    // Variable specifier bypasses compile-time module resolution.
    // This module only exists at runtime in the Tauri app.
    const mod = '@tauri-apps/plugin-opener'
    const { openUrl }: { openUrl: (url: string) => Promise<void> } = await import(
      /* @vite-ignore */ mod
    )
    await openUrl(url)
  } else {
    window.open(url, '_blank')
  }
}
