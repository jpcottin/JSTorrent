import type { DownloadRoot } from '../../native-connection'

export interface CompanionRoot {
  key: string
  uri?: string
  path?: string
  displayName?: string
  display_name?: string
  removable: boolean
  lastStatOk?: boolean
  last_stat_ok?: boolean
  lastChecked?: number
  last_checked?: number
  diskId?: string
  disk_id?: string
}

export function mapCompanionRoot(root: CompanionRoot): DownloadRoot {
  return {
    key: root.key,
    path: root.uri || root.path || '',
    display_name: root.displayName || root.display_name || '',
    removable: root.removable,
    last_stat_ok: root.lastStatOk ?? root.last_stat_ok ?? true,
    last_checked: root.lastChecked ?? root.last_checked ?? Date.now(),
    disk_id: root.diskId ?? root.disk_id ?? '',
  }
}

export function mapCompanionRoots(roots: CompanionRoot[] | null | undefined): DownloadRoot[] {
  if (!roots?.length) return []
  return roots.map(mapCompanionRoot)
}
