import type { NodeIoDaemonRoot } from './types'

export class NodeIoDaemonRootStore {
  private readonly roots = new Map<string, NodeIoDaemonRoot>()
  private readonly listeners = new Set<(roots: NodeIoDaemonRoot[]) => void>()

  constructor(initialRoots: NodeIoDaemonRoot[] = []) {
    for (const root of initialRoots) {
      this.roots.set(root.key, { ...root })
    }
  }

  list(): NodeIoDaemonRoot[] {
    return [...this.roots.values()].map((root) => ({ ...root }))
  }

  get(key: string): NodeIoDaemonRoot | null {
    const root = this.roots.get(key)
    return root ? { ...root } : null
  }

  add(root: NodeIoDaemonRoot): void {
    this.roots.set(root.key, { ...root })
    this.emitChange()
  }

  delete(key: string): boolean {
    const deleted = this.roots.delete(key)
    if (deleted) {
      this.emitChange()
    }
    return deleted
  }

  onChange(listener: (roots: NodeIoDaemonRoot[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emitChange(): void {
    const roots = this.list()
    for (const listener of this.listeners) {
      listener(roots)
    }
  }
}
