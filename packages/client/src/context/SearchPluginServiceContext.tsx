import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useEngineManager } from './EngineManagerContext'
import { SearchPluginService } from '../search/search-plugin-service'

const SearchPluginServiceContext = createContext<SearchPluginService | null>(null)

interface SearchPluginServiceProviderProps {
  children: ReactNode
}

export function SearchPluginServiceProvider({ children }: SearchPluginServiceProviderProps) {
  const engineManager = useEngineManager()
  const [service] = useState(() => new SearchPluginService(engineManager))

  useEffect(() => {
    return () => {
      service.dispose()
    }
  }, [service])

  return (
    <SearchPluginServiceContext.Provider value={service}>
      {children}
    </SearchPluginServiceContext.Provider>
  )
}

export function useSearchPluginService(): SearchPluginService {
  const ctx = useContext(SearchPluginServiceContext)
  if (!ctx) {
    throw new Error('useSearchPluginService must be used within SearchPluginServiceProvider')
  }
  return ctx
}
