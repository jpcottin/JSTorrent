import * as fs from 'fs/promises'
import * as path from 'path'

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function resolveWithExistingPrefix(targetPath: string): Promise<string> {
  let current = path.resolve(targetPath)
  const missingSegments: string[] = []

  while (true) {
    try {
      const real = await fs.realpath(current)
      return path.join(real, ...missingSegments.reverse())
    } catch (error) {
      if (!isMissingPathError(error)) throw error

      const parent = path.dirname(current)
      if (parent === current) {
        throw error
      }
      missingSegments.push(path.basename(current))
      current = parent
    }
  }
}

function normalizeRelativeSegments(relativePath: string): string[] {
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error(`Invalid root-relative path: ${relativePath}`)
  }

  const normalized = path.posix.normalize(relativePath.replace(/\\/g, '/'))
  if (normalized === '.' || normalized === '') return []
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Invalid root-relative path: ${relativePath}`)
  }

  return normalized.split('/').filter((segment) => segment.length > 0)
}

export async function resolvePathWithinRoot(
  rootPath: string,
  relativePath: string,
): Promise<string> {
  const safeRoot = await resolveWithExistingPrefix(rootPath)
  const segments = normalizeRelativeSegments(relativePath)

  let current = safeRoot
  for (const segment of segments) {
    const candidate = path.join(current, segment)
    try {
      const resolvedCandidate = await fs.realpath(candidate)
      if (!isWithinRoot(safeRoot, resolvedCandidate)) {
        throw new Error(`Path escapes root: ${relativePath}`)
      }
      current = resolvedCandidate
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      current = candidate
    }
  }

  if (!isWithinRoot(safeRoot, current)) {
    throw new Error(`Path escapes root: ${relativePath}`)
  }
  return current
}
