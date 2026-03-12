import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { useEngineManager } from './EngineManagerContext'
import { SearchPluginService } from '../search/search-plugin-service'

const SearchPluginServiceContext = createContext<SearchPluginService | null>(null)

interface SearchPluginServiceProviderProps {
  children: ReactNode
}

export function SearchPluginServiceProvider({ children }: SearchPluginServiceProviderProps) {
  const engineManager = useEngineManager()
  const serviceRef = useRef<SearchPluginService | null>(null)

  if (!serviceRef.current) {
    serviceRef.current = new SearchPluginService(engineManager)
  }

  useEffect(() => {
    return () => {
      serviceRef.current?.dispose()
      serviceRef.current = null
    }
  }, [])

  return (
    <SearchPluginServiceContext.Provider value={serviceRef.current}>
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
