import * as fs from 'node:fs'
import type { VersionNotes } from './github.js'
import { compareVersions } from './version.js'

/**
 * Persistent append-only store for release notes.
 * Old release notes never change, so they're cached forever.
 * New entries are merged in on each GitHub fetch cycle.
 */
export class NotesStore {
  private notes: Map<string, string> = new Map()

  constructor(private diskPath?: string) {
    if (diskPath) {
      try {
        const raw = fs.readFileSync(diskPath, 'utf-8')
        const entries = JSON.parse(raw) as Record<string, string>
        for (const [version, notes] of Object.entries(entries)) {
          this.notes.set(version, notes)
        }
      } catch {
        // No disk cache yet
      }
    }
  }

  /** Merge new entries. Only adds versions we haven't seen before. */
  merge(entries: VersionNotes[]): void {
    let added = false
    for (const { version, notes } of entries) {
      if (!this.notes.has(version) && notes) {
        this.notes.set(version, notes)
        added = true
      }
    }
    if (added) this.writeToDisk()
  }

  /** Get all notes sorted newest-first. */
  getAll(): VersionNotes[] {
    return Array.from(this.notes.entries())
      .map(([version, notes]) => ({ version, notes }))
      .sort((a, b) => compareVersions(b.version, a.version))
  }

  private writeToDisk(): void {
    if (!this.diskPath) return
    try {
      const obj: Record<string, string> = {}
      for (const [version, notes] of this.notes) {
        obj[version] = notes
      }
      fs.writeFileSync(this.diskPath, JSON.stringify(obj))
    } catch (err) {
      console.error('NotesStore disk write error:', err)
    }
  }
}
