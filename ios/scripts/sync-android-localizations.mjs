#!/usr/bin/env node

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '../..')
const androidResDir = path.join(repoRoot, 'android/app/src/main/res')
const iosLocalizationDir = path.join(repoRoot, 'ios/JSTorrent/Resources/Localization')

const XML_ENTITIES = new Map([
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&apos;', "'"],
])

function decodeXmlEntities(value) {
  let decoded = value
  for (const [entity, replacement] of XML_ENTITIES) {
    decoded = decoded.replaceAll(entity, replacement)
  }

  decoded = decoded.replace(/&#(\d+);/g, (_, codePoint) =>
    String.fromCodePoint(Number.parseInt(codePoint, 10)),
  )
  decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (_, codePoint) =>
    String.fromCodePoint(Number.parseInt(codePoint, 16)),
  )

  return decoded
}

function normalizeFormatSpecifiers(value) {
  return value.replace(/%([1-9]\d*\$)?s/g, (_, position = '') => `%${position}@`)
}

function normalizeAndroidEscapes(value) {
  return value
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\\\/g, '\\')
}

function normalizeStringValue(rawValue) {
  const collapsed = rawValue.replace(/\r\n/g, '\n').trim()
  return normalizeFormatSpecifiers(normalizeAndroidEscapes(decodeXmlEntities(collapsed)))
}

function androidDirToLocaleTag(directoryName) {
  if (directoryName === 'values') {
    return 'en'
  }

  if (!directoryName.startsWith('values-')) {
    return null
  }

  const qualifier = directoryName.slice('values-'.length)
  const regionMatch = qualifier.match(/^([a-z]{2,3})-r([A-Z]{2})$/)
  if (regionMatch) {
    return `${regionMatch[1]}-${regionMatch[2]}`
  }

  return qualifier
}

async function parseStringsXml(filePath) {
  const xml = await fs.readFile(filePath, 'utf8')
  const entries = {}
  const stringPattern = /<string\b([^>]*)name="([^"]+)"([^>]*)>([\s\S]*?)<\/string>/g

  for (const match of xml.matchAll(stringPattern)) {
    const attrs = `${match[1]} ${match[3]}`
    if (attrs.includes('translatable="false"')) {
      continue
    }

    const key = match[2]
    const value = normalizeStringValue(match[4])
    entries[key] = value
  }

  return entries
}

async function main() {
  const directoryEntries = await fs.readdir(androidResDir, { withFileTypes: true })
  const localeEntries = []

  for (const entry of directoryEntries) {
    if (!entry.isDirectory()) {
      continue
    }

    const localeTag = androidDirToLocaleTag(entry.name)
    if (!localeTag) {
      continue
    }

    const stringsPath = path.join(androidResDir, entry.name, 'strings.xml')
    try {
      await fs.access(stringsPath)
    } catch {
      continue
    }

    const strings = await parseStringsXml(stringsPath)
    localeEntries.push({ localeTag, strings })
  }

  const baseEntry = localeEntries.find((entry) => entry.localeTag === 'en')
  if (!baseEntry) {
    throw new Error('Missing Android base strings at values/strings.xml')
  }

  await fs.mkdir(iosLocalizationDir, { recursive: true })
  const existingOutput = await fs.readdir(iosLocalizationDir, { withFileTypes: true })
  for (const entry of existingOutput) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      await fs.unlink(path.join(iosLocalizationDir, entry.name))
    }
  }

  for (const entry of localeEntries.sort((a, b) => a.localeTag.localeCompare(b.localeTag))) {
    const merged = { ...baseEntry.strings, ...entry.strings }
    const outputPath = path.join(iosLocalizationDir, `${entry.localeTag}.json`)
    await fs.writeFile(outputPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  }

  console.log(`Generated ${localeEntries.length} localization file(s) in ${iosLocalizationDir}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
