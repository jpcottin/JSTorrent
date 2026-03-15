export interface SourceValidationResult {
  valid: boolean
  errors: string[]
  exportedNames: string[]
}

export function validateModuleSource(source: string): SourceValidationResult {
  const errors: string[] = []
  const exportedNames: string[] = []

  const constMatches = source.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*=/g)
  for (const match of constMatches) {
    exportedNames.push(match[1])
  }

  const funcMatches = source.matchAll(/export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)
  for (const match of funcMatches) {
    exportedNames.push(match[2])
  }

  if (/\bexport\s+default\b/.test(source)) {
    errors.push('`export default` is not supported; use `export const` or `export function`')
  }

  if (!exportedNames.includes('manifest')) {
    errors.push('Plugin must export `manifest`')
  }

  if (!exportedNames.includes('search')) {
    errors.push('Plugin must export `search`')
  }

  // Check for unsupported export syntax after stripping known exports
  let stripped = source
  stripped = stripped.replace(/export\s+const\s+[A-Za-z_$][\w$]*\s*=/g, '')
  stripped = stripped.replace(/export\s+(async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/g, '')
  stripped = stripped.replace(/\bexport\s+default\b/g, '')
  if (/\bexport\s+/.test(stripped)) {
    errors.push(
      'Unsupported export syntax detected; only `export const` and `export function` are allowed',
    )
  }

  return {
    valid: errors.length === 0,
    errors,
    exportedNames,
  }
}
