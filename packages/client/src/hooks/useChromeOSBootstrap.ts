import { useCallback } from 'react'
import { useHostChannel } from '../host/HostChannelContext'
import { ChromeExtensionChannel } from '../host/chrome-extension-channel'

/**
 * Hook to provide ChromeOS bootstrap action callbacks.
 *
 * Uses HostChannel from context, type-narrows to ChromeExtensionChannel for ChromeOS methods.
 */
export function useChromeOSBootstrap() {
  const channel = useHostChannel()

  const openIntent = useCallback(() => {
    if (channel instanceof ChromeExtensionChannel) {
      channel.openChromeOSIntent()
    }
  }, [channel])

  const resetPairing = useCallback(() => {
    if (channel instanceof ChromeExtensionChannel) {
      channel.resetChromeOSPairing()
    }
  }, [channel])

  return {
    openIntent,
    resetPairing,
  }
}
