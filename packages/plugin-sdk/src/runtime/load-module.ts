import type { SearchPluginModule } from '../types.js'
import { transformModuleSource } from './transform.js'

export function loadPlugin(source: string): SearchPluginModule {
  const transformed = transformModuleSource(source)
  const exportsObject = Object.create(null) as SearchPluginModule
  return new Function('exports', transformed)(exportsObject) as SearchPluginModule
}
