import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface NativeHostResponseShape {
  type: string
  requiredPayloadFields: string[]
  optionalPayloadFields?: string[]
  error?: string
}

interface NativeHostOperation {
  name: string
  rustVariant: string
  kind: 'request_response'
  direction: 'client_to_host'
  requestShape: {
    required: string[]
    optional?: string[]
  }
  successResponse: NativeHostResponseShape
  errorResponses?: NativeHostResponseShape[]
}

interface NativeHostProtocolManifest {
  protocolVersion: number
  operations: NativeHostOperation[]
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const engineRoot = resolve(__dirname, '..')
const repoRoot = resolve(engineRoot, '..', '..')
const manifestPath = resolve(repoRoot, 'contracts', 'native-host-protocol.json')
const rustProtocolPath = resolve(repoRoot, 'desktop', 'host', 'src', 'protocol.rs')
const rustMainPath = resolve(repoRoot, 'desktop', 'host', 'src', 'main.rs')

function readManifest(): NativeHostProtocolManifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as NativeHostProtocolManifest
}

function readRustProtocol(): string {
  return readFileSync(rustProtocolPath, 'utf8')
}

function readRustMain(): string {
  return readFileSync(rustMainPath, 'utf8')
}

function extractEnumVariants(source: string, enumName: string): Set<string> {
  const enumStart = source.indexOf(`pub enum ${enumName} {`)
  if (enumStart === -1) {
    throw new Error(`Could not find enum ${enumName} in ${rustProtocolPath}`)
  }

  const enumSource = source.slice(enumStart)
  const matches = [...enumSource.matchAll(/^\s{4}([A-Z][A-Za-z0-9]+)(?:\s*\{|,)/gm)]
  if (matches.length === 0) {
    throw new Error(`Could not parse variants for enum ${enumName}`)
  }
  return new Set(matches.map((match) => match[1]))
}

function extractVariantBlock(source: string, variantName: string): string {
  const index = source.indexOf(`${variantName} {`)
  if (index === -1) {
    const unitVariantPattern = new RegExp(`^\\s*${variantName},$`, 'm')
    if (unitVariantPattern.test(source)) {
      return ''
    }
    throw new Error(`Could not find variant block for ${variantName} in ${rustProtocolPath}`)
  }

  const start = source.indexOf('{', index)
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return source.slice(start + 1, i)
      }
    }
  }

  throw new Error(`Could not determine block end for variant ${variantName}`)
}

function requirePattern(source: string, pattern: RegExp, description: string): void {
  if (!pattern.test(source)) {
    throw new Error(`Missing expected native-host protocol shape in source: ${description}`)
  }
}

function requestFieldPattern(fieldName: string): RegExp {
  const fieldPatterns: Record<string, RegExp> = {
    extensionId: /#\[serde\(rename = "extensionId"\)\][\s\S]*?extension_id: String/,
    installId: /#\[serde\(default, rename = "installId"\)\][\s\S]*?install_id: Option<String>/,
    profileId: /#\[serde\(default, rename = "profileId"\)\][\s\S]*?profile_id: Option<String>/,
    clientType: /#\[serde\(default, rename = "clientType"\)\][\s\S]*?client_type: Option<String>/,
    clientVersion:
      /#\[serde\(default, rename = "clientVersion"\)\][\s\S]*?client_version: Option<String>/,
    path: /\bpath: String\b/,
    key: /\bkey: String\b/,
    value: /\bvalue: String\b/,
  }
  const pattern = fieldPatterns[fieldName]
  if (!pattern) {
    throw new Error(`No native-host request field pattern registered for ${fieldName}`)
  }
  return pattern
}

function responseFieldPattern(fieldName: string): RegExp {
  const fieldPatterns: Record<string, RegExp> = {
    profileId: /#\[serde\(rename = "profileId"[\s\S]*?\)\][\s\S]*?profile_id:/,
    port: /port:\s*u16/,
    token: /token:\s*String/,
    version: /version:\s*String/,
    roots: /roots:\s*Vec<DownloadRoot>/,
    protocolVersion:
      /#\[serde\(rename = "protocolVersion"[\s\S]*?\)\][\s\S]*?protocol_version: Option<u32>/,
    behaviorVersion:
      /#\[serde\(rename = "behaviorVersion"[\s\S]*?\)\][\s\S]*?behavior_version: Option<u32>/,
    addToken: /#\[serde\(rename = "addToken"[\s\S]*?\)\][\s\S]*?add_token: Option<String>/,
    capabilities: /capabilities:\s*Option<DaemonCapabilities>/,
    desktopVersion:
      /#\[serde\(rename = "desktopVersion"[\s\S]*?\)\][\s\S]*?desktop_version: Option<String>/,
    pid: /pid:\s*u32/,
    started: /started:\s*u64/,
    clientType: /#\[serde\(rename = "clientType"[\s\S]*?\)\][\s\S]*?client_type: Option<String>/,
    clientVersion:
      /#\[serde\(rename = "clientVersion"[\s\S]*?\)\][\s\S]*?client_version: Option<String>/,
    browserName: /#\[serde\(rename = "browserName"[\s\S]*?\)\][\s\S]*?browser_name: Option<String>/,
    root: /root:\s*DownloadRoot/,
    key: /key:\s*String/,
    value: /value:\s*Option<String>/,
    name: /name:\s*String/,
    contentsBase64: /#\[serde\(rename = "contentsBase64"\)\][\s\S]*?contents_base64: String/,
  }
  const pattern = fieldPatterns[fieldName]
  if (!pattern) {
    throw new Error(`No native-host response field pattern registered for ${fieldName}`)
  }
  return pattern
}

function validateRequestShapeAgainstSource(
  operation: NativeHostOperation,
  protocolSource: string,
): void {
  const block = extractVariantBlock(protocolSource, operation.rustVariant)
  for (const field of [
    ...operation.requestShape.required,
    ...(operation.requestShape.optional ?? []),
  ]) {
    if (field === 'id' || field === 'op') {
      continue
    }
    requirePattern(block, requestFieldPattern(field), `${operation.name} request field ${field}`)
  }
}

function validateResponseShapeAgainstSource(
  operationName: string,
  response: NativeHostResponseShape,
  protocolSource: string,
  mainSource: string,
  fieldName: string,
): void {
  const block = extractVariantBlock(protocolSource, response.type)
  for (const field of response.requiredPayloadFields) {
    requirePattern(
      block,
      responseFieldPattern(field),
      `${operationName} ${fieldName} field ${field}`,
    )
  }
  for (const field of response.optionalPayloadFields ?? []) {
    requirePattern(
      block,
      responseFieldPattern(field),
      `${operationName} ${fieldName} optional field ${field}`,
    )
  }
  if (response.error) {
    requirePattern(
      mainSource,
      new RegExp(`"${response.error}"`),
      `${operationName} error literal ${response.error}`,
    )
  }
  if (response.type === 'DaemonInfo') {
    requirePattern(
      protocolSource,
      /\broots_manageable: bool\b/,
      `${operationName} DaemonCapabilities roots_manageable`,
    )
    requirePattern(
      protocolSource,
      /\blan_share_urls: bool\b/,
      `${operationName} DaemonCapabilities lan_share_urls`,
    )
    requirePattern(
      protocolSource,
      /\bfree_space: bool\b/,
      `${operationName} DaemonCapabilities free_space`,
    )
    requirePattern(
      protocolSource,
      /\bwrite_atomic: bool\b/,
      `${operationName} DaemonCapabilities write_atomic`,
    )
  }
}

function validateManifest(
  manifest: NativeHostProtocolManifest,
  operationVariants: Set<string>,
  responseVariants: Set<string>,
  protocolSource: string,
  mainSource: string,
): void {
  if (manifest.protocolVersion !== 1) {
    throw new Error(`Unsupported native-host protocolVersion ${manifest.protocolVersion}`)
  }

  const seenNames = new Set<string>()
  for (const operation of manifest.operations) {
    if (seenNames.has(operation.name)) {
      throw new Error(
        `Duplicate operation name in native-host protocol manifest: ${operation.name}`,
      )
    }
    seenNames.add(operation.name)

    if (!operationVariants.has(operation.rustVariant)) {
      throw new Error(
        `Manifest operation ${operation.name} references missing Rust Operation variant ${operation.rustVariant}`,
      )
    }

    validateRequestShape(operation)
    validateRequestShapeAgainstSource(operation, protocolSource)
    validateResponseShape(
      operation.successResponse,
      responseVariants,
      operation.name,
      'successResponse',
    )
    validateResponseShapeAgainstSource(
      operation.name,
      operation.successResponse,
      protocolSource,
      mainSource,
      'successResponse',
    )
    for (const errorResponse of operation.errorResponses ?? []) {
      validateResponseShape(errorResponse, responseVariants, operation.name, 'errorResponses')
      validateResponseShapeAgainstSource(
        operation.name,
        errorResponse,
        protocolSource,
        mainSource,
        'errorResponses',
      )
    }
  }
}

function validateRequestShape(operation: NativeHostOperation): void {
  const required = operation.requestShape.required
  if (!required.includes('id') || !required.includes('op')) {
    throw new Error(`Manifest operation ${operation.name} must require both id and op`)
  }
}

function validateResponseShape(
  response: NativeHostResponseShape,
  responseVariants: Set<string>,
  operationName: string,
  fieldName: string,
): void {
  if (!responseVariants.has(response.type)) {
    throw new Error(
      `Manifest operation ${operationName} ${fieldName} references missing Rust ResponsePayload variant ${response.type}`,
    )
  }
}

function main(): void {
  const manifest = readManifest()
  const rustProtocol = readRustProtocol()
  const rustMain = readRustMain()
  const operationVariants = extractEnumVariants(rustProtocol, 'Operation')
  const responseVariants = extractEnumVariants(rustProtocol, 'ResponsePayload')

  validateManifest(manifest, operationVariants, responseVariants, rustProtocol, rustMain)
  console.log(
    `Validated native-host protocol manifest and selected request/response shapes against Rust sources (${manifest.operations.length} operations)`,
  )
}

main()
