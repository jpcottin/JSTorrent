import { it } from 'vitest'

export type DaemonImplementationId = 'node' | 'rust' | 'android'

export function conformanceTitle(
  implementation: DaemonImplementationId,
  caseId: string,
  title: string,
): string {
  return `[conformance:${caseId}][impl:${implementation}] ${title}`
}

export function conformanceCase(
  implementation: DaemonImplementationId,
  caseId: string,
  title: string,
  fn: Parameters<typeof it>[1],
  timeout?: number,
): void {
  if (timeout !== undefined) {
    it(conformanceTitle(implementation, caseId, title), fn, timeout)
    return
  }
  it(conformanceTitle(implementation, caseId, title), fn)
}
