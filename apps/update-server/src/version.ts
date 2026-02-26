function parseVersion(v: string): number[] {
  const parts = v.split('.')
  const nums = parts.map((s) => {
    const n = Number(s)
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`Invalid version segment "${s}" in "${v}"`)
    }
    return n
  })
  return nums
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0
    const nb = pb[i] || 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  return 0
}
