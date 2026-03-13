globalThis.jstorrent =
  globalThis.jstorrent ||
  {
    init(config) {
      globalThis.__jstorrent_on_state_update?.(
        JSON.stringify({
          placeholder: true,
          platformType: config?.platformType ?? 'ios-standalone',
        }),
      )
    },
    isInitialized() {
      return false
    },
  }
