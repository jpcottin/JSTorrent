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

function readManifest(): NativeHostProtocolManifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as NativeHostProtocolManifest
}

function readRustProtocol(): string {
  return readFileSync(rustProtocolPath, 'utf8')
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

function validateManifest(manifest: NativeHostProtocolManifest, operationVariants: Set<string>, responseVariants: Set<string>): void {
  if (manifest.protocolVersion !== 1) {
    throw new Error(`Unsupported native-host protocolVersion ${manifest.protocolVersion}`)
  }

  const seenNames = new Set<string>()
  for (const operation of manifest.operations) {
    if (seenNames.has(operation.name)) {
      throw new Error(`Duplicate operation name in native-host protocol manifest: ${operation.name}`)
    }
    seenNames.add(operation.name)

    if (!operationVariants.has(operation.rustVariant)) {
      throw new Error(
        `Manifest operation ${operation.name} references missing Rust Operation variant ${operation.rustVariant}`,
      )
    }

    validateRequestShape(operation)
    validateResponseShape(operation.successResponse, responseVariants, operation.name, 'successResponse')
    for (const errorResponse of operation.errorResponses ?? []) {
      validateResponseShape(errorResponse, responseVariants, operation.name, 'errorResponses')
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
  const operationVariants = extractEnumVariants(rustProtocol, 'Operation')
  const responseVariants = extractEnumVariants(rustProtocol, 'ResponsePayload')

  validateManifest(manifest, operationVariants, responseVariants)
  console.log(
    `Validated native-host protocol manifest against Rust protocol source (${manifest.operations.length} operations)`,
  )
}

main()
