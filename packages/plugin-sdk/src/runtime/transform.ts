export function transformModuleSource(source: string): string {
  const exportedNames: string[] = []
  let transformed = source

  transformed = transformed.replace(/export\s+const\s+([A-Za-z_$][\w$]*)\s*=/g, (_, name) => {
    exportedNames.push(name)
    return `const ${name} =`
  })

  transformed = transformed.replace(
    /export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    (_, asyncKeyword, name) => {
      exportedNames.push(name)
      return `${asyncKeyword || ''}function ${name}(`
    },
  )

  if (/\bexport\s+default\b/.test(transformed)) {
    throw new Error('export default is not supported yet')
  }

  if (/\bexport\s+/.test(transformed)) {
    throw new Error('Unsupported export syntax in plugin source')
  }

  const exportLines = exportedNames
    .map((name) => `exports.${name} = typeof ${name} !== 'undefined' ? ${name} : undefined;`)
    .join('\n')

  return `${transformed}\n${exportLines}\nreturn exports;`
}
