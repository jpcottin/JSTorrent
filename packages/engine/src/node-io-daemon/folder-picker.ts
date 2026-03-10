import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { NodeIoDaemonRoot } from './types'

export async function createTestFolderPickerRoot(sequence: number): Promise<NodeIoDaemonRoot> {
  const rootPath = path.join(os.tmpdir(), 'jstorrent-node-io-daemon', `picked-root-${sequence}`)
  await fs.mkdir(rootPath, { recursive: true })

  return {
    key: `picked-root-${sequence}`,
    uri: `file://${rootPath}`,
    display_name: `Picked Root ${sequence}`,
    removable: true,
    last_stat_ok: true,
    last_checked: Date.now(),
  }
}
