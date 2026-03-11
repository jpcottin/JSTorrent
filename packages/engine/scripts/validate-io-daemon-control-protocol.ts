import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type Implementation = 'node' | 'rust' | 'android'

interface OpcodeEntry {
  opcode: number
  hex: string
  name: string
  implementedIn?: Implementation[]
  requestShape?: {
    required: string[]
  }
  responseShape?: {
    required: string[]
    nestedRequired?: Record<string, string[]>
  }
}

interface OpcodeManifest {
  protocolVersion: number
  opcodes: OpcodeEntry[]
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const engineRoot = resolve(__dirname, '..')
const repoRoot = resolve(engineRoot, '..', '..')

const manifestPath = resolve(repoRoot, 'contracts', 'io-daemon-control-opcodes.json')
const nodeProtocolPath = resolve(repoRoot, 'packages', 'engine', 'src', 'node-io-daemon', 'control-protocol.ts')
const nodeRuntimePath = resolve(repoRoot, 'packages', 'engine', 'src', 'node-io-daemon', 'daemon-runtime.ts')
const nodeIoSessionPath = resolve(repoRoot, 'packages', 'engine', 'src', 'node-io-daemon', 'io-session.ts')
const rustControlStreamPath = resolve(repoRoot, 'desktop', 'io-daemon', 'src', 'control_stream.rs')
const rustMediaPath = resolve(repoRoot, 'desktop', 'io-daemon', 'src', 'media.rs')
const rustWsPath = resolve(repoRoot, 'desktop', 'io-daemon', 'src', 'ws.rs')
const androidProtocolPath = resolve(repoRoot, 'android', 'io-core', 'src', 'main', 'java', 'com', 'jstorrent', 'io', 'protocol', 'Protocol.kt')
const androidControlHandlerPath = resolve(
  repoRoot,
  'android',
  'companion-server',
  'src',
  'main',
  'java',
  'com',
  'jstorrent',
  'companion',
  'server',
  'ControlWebSocketHandler.kt',
)

const nodeNameToConst: Record<string, string> = {
  ROOTS_CHANGED: 'CONTROL_OP_ROOTS_CHANGED',
  EVENT: 'CONTROL_OP_EVENT',
  OPEN_FOLDER_PICKER: 'CONTROL_OP_OPEN_FOLDER_PICKER',
  OPEN_FILE: 'CONTROL_OP_OPEN_FILE',
  REVEAL_IN_FOLDER: 'CONTROL_OP_REVEAL_IN_FOLDER',
  POWER_HINT: 'CONTROL_OP_POWER_HINT',
  REGISTER_HTTP_STREAM: 'CONTROL_OP_REGISTER_HTTP_STREAM',
  GET_CAPABILITIES: 'CONTROL_OP_GET_CAPABILITIES',
  OPEN_HTTP_STREAM_SESSION: 'CONTROL_OP_OPEN_HTTP_STREAM_SESSION',
  WAIT_FOR_HTTP_STREAM_RANGE: 'CONTROL_OP_WAIT_FOR_HTTP_STREAM_RANGE',
  CANCEL_HTTP_STREAM_RANGE_WAIT: 'CONTROL_OP_CANCEL_HTTP_STREAM_RANGE_WAIT',
  CLOSE_HTTP_STREAM_SESSION: 'CONTROL_OP_CLOSE_HTTP_STREAM_SESSION',
  REVOKE_TORRENT_HTTP_STREAMS: 'CONTROL_OP_REVOKE_TORRENT_HTTP_STREAMS',
}

const rustNameToConst: Record<string, string> = {
  REGISTER_HTTP_STREAM: 'OP_CTRL_REGISTER_HTTP_STREAM',
  GET_CAPABILITIES: 'OP_CTRL_GET_CAPABILITIES',
  OPEN_HTTP_STREAM_SESSION: 'OP_CTRL_OPEN_HTTP_STREAM_SESSION',
  WAIT_FOR_HTTP_STREAM_RANGE: 'OP_CTRL_WAIT_FOR_HTTP_STREAM_RANGE',
  CANCEL_HTTP_STREAM_RANGE_WAIT: 'OP_CTRL_CANCEL_HTTP_STREAM_RANGE_WAIT',
  CLOSE_HTTP_STREAM_SESSION: 'OP_CTRL_CLOSE_HTTP_STREAM_SESSION',
  REVOKE_TORRENT_HTTP_STREAMS: 'OP_CTRL_REVOKE_TORRENT_HTTP_STREAMS',
}

const androidNameToConst: Record<string, string> = {
  ROOTS_CHANGED: 'OP_CTRL_ROOTS_CHANGED',
  EVENT: 'OP_CTRL_EVENT',
  OPEN_FOLDER_PICKER: 'OP_CTRL_OPEN_FOLDER_PICKER',
  OPEN_FILE: 'OP_CTRL_OPEN_FILE',
  REVEAL_IN_FOLDER: 'OP_CTRL_OPEN_FOLDER',
  POWER_HINT: 'OP_CTRL_POWER_HINT',
  REGISTER_HTTP_STREAM: 'OP_CTRL_REGISTER_HTTP_STREAM',
  GET_CAPABILITIES: 'OP_CTRL_GET_CAPABILITIES',
  OPEN_HTTP_STREAM_SESSION: 'OP_CTRL_OPEN_HTTP_STREAM_SESSION',
  WAIT_FOR_HTTP_STREAM_RANGE: 'OP_CTRL_WAIT_FOR_HTTP_STREAM_RANGE',
  CANCEL_HTTP_STREAM_RANGE_WAIT: 'OP_CTRL_CANCEL_HTTP_STREAM_RANGE_WAIT',
  CLOSE_HTTP_STREAM_SESSION: 'OP_CTRL_CLOSE_HTTP_STREAM_SESSION',
  REVOKE_TORRENT_HTTP_STREAMS: 'OP_CTRL_REVOKE_TORRENT_HTTP_STREAMS',
}

function readManifest(): OpcodeManifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as OpcodeManifest
}

function parseImplementationConstants(source: string, regex: RegExp): Map<string, number> {
  const constants = new Map<string, number>()
  for (const match of source.matchAll(regex)) {
    const name = match[1]
    const literal = match[2]
    constants.set(name, parseNumericLiteral(literal))
  }
  return constants
}

function parseNumericLiteral(value: string): number {
  const normalized = value.replace(/\.toByte\(\)$/u, '').trim()
  if (normalized.startsWith('0x') || normalized.startsWith('0X')) {
    return Number.parseInt(normalized.slice(2), 16)
  }
  return Number.parseInt(normalized, 10)
}

function validateUniqueManifestEntries(manifest: OpcodeManifest): void {
  const seenOpcodes = new Set<number>()
  const seenNames = new Set<string>()
  for (const entry of manifest.opcodes) {
    if (seenOpcodes.has(entry.opcode)) {
      throw new Error(`Duplicate opcode in io-daemon control manifest: ${entry.opcode}`)
    }
    if (seenNames.has(entry.name)) {
      throw new Error(`Duplicate opcode name in io-daemon control manifest: ${entry.name}`)
    }
    seenOpcodes.add(entry.opcode)
    seenNames.add(entry.name)
  }
}

function requirePattern(source: string, pattern: RegExp, description: string): void {
  if (!pattern.test(source)) {
    throw new Error(`Missing expected control protocol shape in source: ${description}`)
  }
}

function validateNodeShapes(entries: OpcodeEntry[], runtimeSource: string, ioSessionSource: string): void {
  for (const entry of entries) {
    if (entry.name === 'REGISTER_HTTP_STREAM') {
      for (const field of entry.requestShape?.required ?? []) {
        requirePattern(runtimeSource, new RegExp(`\\bbody\\.${field}\\b`), `node REGISTER_HTTP_STREAM request field ${field}`)
      }
      for (const field of entry.responseShape?.required ?? []) {
        requirePattern(
          runtimeSource + ioSessionSource,
          new RegExp(`\\b${field}\\b`),
          `node REGISTER_HTTP_STREAM response field ${field}`,
        )
      }
    }

    if (entry.name === 'GET_CAPABILITIES') {
      for (const field of entry.responseShape?.required ?? []) {
        requirePattern(ioSessionSource, new RegExp(`\\b${field}\\b`), `node GET_CAPABILITIES response field ${field}`)
      }
      for (const nestedField of entry.responseShape?.nestedRequired?.capabilities ?? []) {
        requirePattern(
          ioSessionSource + runtimeSource,
          new RegExp(`\\b${nestedField}\\b`),
          `node GET_CAPABILITIES capability ${nestedField}`,
        )
      }
    }
  }
}

function validateRustShapes(entries: OpcodeEntry[], mediaSource: string, wsSource: string): void {
  for (const entry of entries) {
    if (entry.name === 'REGISTER_HTTP_STREAM') {
      const rustFieldMap: Record<string, string> = {
        streamToken: 'stream_token',
        torrentId: 'torrent_id',
        fileIndex: 'file_index',
        rootKey: 'root_key',
        path: 'path',
        fileSize: 'file_size',
        mimeType: 'mime_type',
      }
      for (const field of entry.requestShape?.required ?? []) {
        const rustField = rustFieldMap[field]
        requirePattern(mediaSource, new RegExp(`pub\\(crate\\) ${rustField}:`), `rust REGISTER_HTTP_STREAM request field ${field}`)
      }
      for (const field of entry.responseShape?.required ?? []) {
        const rustField = field === 'mediaPort' ? 'media_port' : field
        requirePattern(mediaSource + wsSource, new RegExp(`\\b${rustField}\\b`), `rust REGISTER_HTTP_STREAM response field ${field}`)
      }
    }

    if (entry.name === 'GET_CAPABILITIES') {
      for (const field of entry.responseShape?.required ?? []) {
        requirePattern(wsSource, new RegExp(`"${field}"`), `rust GET_CAPABILITIES response field ${field}`)
      }
      for (const nestedField of entry.responseShape?.nestedRequired?.capabilities ?? []) {
        requirePattern(wsSource, new RegExp(`"${nestedField}"`), `rust GET_CAPABILITIES capability ${nestedField}`)
      }
    }
  }
}

function validateAndroidShapes(entries: OpcodeEntry[], controlHandlerSource: string): void {
  for (const entry of entries) {
    if (entry.name === 'REGISTER_HTTP_STREAM') {
      for (const field of entry.requestShape?.required ?? []) {
        requirePattern(
          controlHandlerSource,
          new RegExp(`request\\["${field}"\\]`),
          `android REGISTER_HTTP_STREAM request field ${field}`,
        )
      }
      for (const field of entry.responseShape?.required ?? []) {
        requirePattern(
          controlHandlerSource,
          new RegExp(`"${field}"`),
          `android REGISTER_HTTP_STREAM response field ${field}`,
        )
      }
    }

    if (entry.name === 'GET_CAPABILITIES') {
      for (const field of entry.responseShape?.required ?? []) {
        requirePattern(
          controlHandlerSource,
          new RegExp(`"${field}"`),
          `android GET_CAPABILITIES response field ${field}`,
        )
      }
      for (const nestedField of entry.responseShape?.nestedRequired?.capabilities ?? []) {
        requirePattern(
          controlHandlerSource,
          new RegExp(`"${nestedField}"`),
          `android GET_CAPABILITIES capability ${nestedField}`,
        )
      }
    }
  }
}

function validateImplementation(
  implementation: Implementation,
  entries: OpcodeEntry[],
  constants: Map<string, number>,
  nameMap: Record<string, string>,
): void {
  for (const entry of entries) {
    const constantName = nameMap[entry.name]
    if (!constantName) {
      throw new Error(`No ${implementation} constant mapping for manifest opcode ${entry.name}`)
    }
    const actual = constants.get(constantName)
    if (actual == null) {
      throw new Error(`Missing ${implementation} control constant ${constantName} for opcode ${entry.name}`)
    }
    if (actual !== entry.opcode) {
      throw new Error(
        `${implementation} control constant ${constantName} expected 0x${entry.opcode.toString(16).toUpperCase()} but found 0x${actual.toString(16).toUpperCase()}`,
      )
    }
  }
}

function main(): void {
  const manifest = readManifest()
  if (manifest.protocolVersion !== 1) {
    throw new Error(`Unsupported io-daemon control protocolVersion ${manifest.protocolVersion}`)
  }
  validateUniqueManifestEntries(manifest)

  const nodeSource = readFileSync(nodeProtocolPath, 'utf8')
  const nodeRuntimeSource = readFileSync(nodeRuntimePath, 'utf8')
  const nodeIoSessionSource = readFileSync(nodeIoSessionPath, 'utf8')
  const rustSource = readFileSync(rustControlStreamPath, 'utf8')
  const rustMediaSource = readFileSync(rustMediaPath, 'utf8')
  const rustWsSource = readFileSync(rustWsPath, 'utf8')
  const androidSource = readFileSync(androidProtocolPath, 'utf8')
  const androidControlHandlerSource = readFileSync(androidControlHandlerPath, 'utf8')

  const nodeConstants = parseImplementationConstants(
    nodeSource,
    /^\s*export const (CONTROL_OP_[A-Z0-9_]+) = (0x[0-9a-f]+|\d+)$/gim,
  )
  const rustConstants = parseImplementationConstants(
    rustSource,
    /^\s*pub\(crate\) const (OP_CTRL_[A-Z0-9_]+): u8 = (0x[0-9A-Fa-f]+|\d+);$/gim,
  )
  const androidConstants = parseImplementationConstants(
    androidSource,
    /^\s*const val (OP_CTRL_[A-Z0-9_]+): Byte = (0x[0-9A-Fa-f]+(?:\.toByte\(\))?|\d+)$/gim,
  )

  for (const implementation of ['node', 'rust', 'android'] as const) {
    const entries = manifest.opcodes.filter((entry) => (entry.implementedIn ?? ['node', 'rust', 'android']).includes(implementation))
    if (implementation === 'node') {
      validateImplementation(implementation, entries, nodeConstants, nodeNameToConst)
      validateNodeShapes(entries, nodeRuntimeSource, nodeIoSessionSource)
    } else if (implementation === 'rust') {
      validateImplementation(implementation, entries, rustConstants, rustNameToConst)
      validateRustShapes(entries, rustMediaSource, rustWsSource)
    } else {
      validateImplementation(implementation, entries, androidConstants, androidNameToConst)
      validateAndroidShapes(entries, androidControlHandlerSource)
    }
  }

  console.log(
    `Validated IO daemon control opcode manifest and selected request/response shapes against Node, Rust, and Android sources (${manifest.opcodes.length} opcodes)`,
  )
}

main()
