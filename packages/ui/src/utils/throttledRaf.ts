/** Interval in ms when idle (no active torrents) - uses setTimeout instead of RAF */
const IDLE_INTERVAL_MS = 500

/**
 * Creates a throttled requestAnimationFrame loop that respects a max FPS setting.
 * Supports idle detection to reduce CPU when nothing is active.
 *
 * When idle, switches from RAF to setTimeout to completely stop RAF overhead.
 *
 * @param callback - Function to call on each frame
 * @param getMaxFps - Function returning current max FPS (0 = unlimited)
 * @param isIdle - Optional function returning true when idle (uses setTimeout instead of RAF)
 * @returns Object with start() and stop() methods
 */
export function createThrottledRaf(
  callback: () => void,
  getMaxFps: () => number,
  isIdle?: () => boolean,
): { start: () => void; stop: () => void } {
  let rafId: number | undefined
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let lastFrameTime = 0
  let stopped = true

  const scheduleNext = (idle: boolean) => {
    if (stopped) return

    if (idle) {
      // Use setTimeout when idle - no RAF overhead
      timeoutId = setTimeout(loop, IDLE_INTERVAL_MS)
    } else {
      // Use RAF when active for smooth updates
      rafId = requestAnimationFrame(loop)
    }
  }

  const loop = () => {
    if (stopped) return

    const idle = isIdle?.() ?? false
    const maxFps = getMaxFps()
    const now = performance.now()

    if (idle) {
      // When idle, always run callback (setTimeout already handles timing)
      callback()
    } else if (maxFps === 0) {
      // Unlimited - run every frame
      callback()
    } else {
      const minInterval = 1000 / maxFps
      if (now - lastFrameTime >= minInterval) {
        lastFrameTime = now
        callback()
      }
    }

    scheduleNext(idle)
  }

  return {
    start: () => {
      stopped = false
      lastFrameTime = 0
      rafId = requestAnimationFrame(loop)
    },
    stop: () => {
      stopped = true
      if (rafId !== undefined) {
        cancelAnimationFrame(rafId)
        rafId = undefined
      }
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
        timeoutId = undefined
      }
    },
  }
}
