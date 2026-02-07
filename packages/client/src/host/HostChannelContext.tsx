import { createContext, useContext } from 'react'
import type { HostChannel } from './host-channel'

const HostChannelCtx = createContext<HostChannel | null>(null)

export function HostChannelProvider({
  channel,
  children,
}: {
  channel: HostChannel
  children: React.ReactNode
}) {
  return <HostChannelCtx.Provider value={channel}>{children}</HostChannelCtx.Provider>
}

export function useHostChannel(): HostChannel {
  const ctx = useContext(HostChannelCtx)
  if (!ctx) throw new Error('useHostChannel must be used within HostChannelProvider')
  return ctx
}
