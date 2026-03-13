import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type PlatformId = 'android' | 'ios'
type Availability = 'required' | 'capability_gated'
type Direction = 'js_calls_native' | 'native_calls_js' | 'js_internal_callback_store'
type SymbolKind = 'function' | 'callback_store'
type ArgKind = 'string' | 'number' | 'boolean' | 'arraybuffer' | 'json_string' | 'callback'
type ReturnKind =
  | 'void'
  | 'string'
  | 'number'
  | 'boolean'
  | 'arraybuffer'
  | 'json_string'
  | 'callback_store'
type DeliveryKind = 'direct_return' | 'callback_registration' | 'callback_dispatch'

interface BindingCapability {
  id: string
  description: string
}

interface PackedFrame {
  direction: Exclude<Direction, 'js_internal_callback_store'>
  format: string
}

interface BindingSymbolBase {
  name: string
  kind: SymbolKind
  domain: string
  direction: Direction
  availability: Availability
  requiredIn: PlatformId[]
  capability?: string
}

interface BindingFunction extends BindingSymbolBase {
  kind: 'function'
  argKinds: ArgKind[]
  returnKind: Exclude<ReturnKind, 'callback_store'>
  delivery: DeliveryKind
  asyncResultSymbols?: string[]
  transportCompat?: string
}

interface BindingCallbackStore extends BindingSymbolBase {
  kind: 'callback_store'
  itemArgKinds: Exclude<ArgKind, 'callback'>[]
  returnKind: 'callback_store'
}

type BindingSymbol = BindingFunction | BindingCallbackStore

interface NativeBindingsContract {
  contractVersion: number
  behaviorVersion: number
  platforms: PlatformId[]
  availabilityKinds: Availability[]
  directionKinds: Direction[]
  argKinds: ArgKind[]
  returnKinds: ReturnKind[]
  deliveryKinds: DeliveryKind[]
  capabilities: BindingCapability[]
  sharedCodes: Record<string, Record<string, number>>
  packedFrames: Record<string, PackedFrame>
  symbols: BindingSymbol[]
}

interface ConformanceCase {
  id: string
  kind: 'shape' | 'behavior'
  availability: Availability
  requiredIn: PlatformId[]
  capability?: string
  symbols: string[]
}

interface NativeBindingsConformance {
  contractVersion: number
  behaviorVersion: number
  cases: ConformanceCase[]
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const engineRoot = resolve(__dirname, '..')
const repoRoot = resolve(engineRoot, '..', '..')

const contractPath = resolve(repoRoot, 'contracts', 'native-bindings-contract.json')
const conformancePath = resolve(repoRoot, 'contracts', 'native-bindings-conformance.json')
const bindingsPath = resolve(
  repoRoot,
  'packages',
  'engine',
  'src',
  'adapters',
  'native',
  'bindings.d.ts',
)

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function extractBindingNames(source: string): string[] {
  return [...source.matchAll(/(?:function|var)\s+(__jstorrent_[A-Za-z0-9_]+)/g)].map(
    (match) => match[1],
  )
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function validateRequiredPlatforms(platforms: PlatformId[], allowed: Set<PlatformId>, name: string): void {
  assert(platforms.length > 0, `${name} must declare at least one required platform`)
  for (const platform of platforms) {
    assert(allowed.has(platform), `${name} references unknown platform ${platform}`)
  }
}

function validateContract(contract: NativeBindingsContract, declaredSymbols: Set<string>): void {
  assert(contract.contractVersion === 1, `Unsupported native bindings contractVersion ${contract.contractVersion}`)
  assert(contract.behaviorVersion === 1, `Unsupported native bindings behaviorVersion ${contract.behaviorVersion}`)

  const allowedPlatforms = new Set(contract.platforms)
  const allowedCapabilities = new Set(contract.capabilities.map((capability) => capability.id))
  const seenNames = new Set<string>()

  assert(contract.capabilities.length > 0, 'Native bindings contract must declare capabilities')
  assert(Object.keys(contract.sharedCodes).length > 0, 'Native bindings contract must declare sharedCodes')
  assert(Object.keys(contract.packedFrames).length > 0, 'Native bindings contract must declare packedFrames')

  for (const symbol of contract.symbols) {
    assert(!seenNames.has(symbol.name), `Duplicate native binding symbol ${symbol.name}`)
    seenNames.add(symbol.name)

    assert(declaredSymbols.has(symbol.name), `Contract symbol ${symbol.name} is missing from bindings.d.ts`)
    validateRequiredPlatforms(symbol.requiredIn, allowedPlatforms, `Symbol ${symbol.name}`)

    if (symbol.availability === 'capability_gated') {
      assert(symbol.capability, `Capability-gated symbol ${symbol.name} must declare capability`)
      assert(
        allowedCapabilities.has(symbol.capability),
        `Symbol ${symbol.name} references unknown capability ${symbol.capability}`,
      )
    } else {
      assert(!symbol.capability, `Required symbol ${symbol.name} must not declare capability`)
    }

    if (symbol.kind === 'function') {
      if (symbol.asyncResultSymbols) {
        for (const asyncResultSymbol of symbol.asyncResultSymbols) {
          assert(
            asyncResultSymbol.startsWith('__jstorrent_'),
            `Symbol ${symbol.name} references invalid asyncResultSymbol ${asyncResultSymbol}`,
          )
        }
      }
    } else {
      assert(
        symbol.direction === 'js_internal_callback_store',
        `Callback store ${symbol.name} must use js_internal_callback_store direction`,
      )
      assert(symbol.itemArgKinds.length > 0, `Callback store ${symbol.name} must declare itemArgKinds`)
    }
  }

  for (const declaredSymbol of declaredSymbols) {
    assert(seenNames.has(declaredSymbol), `bindings.d.ts symbol ${declaredSymbol} missing from contract`)
  }

  for (const [frameName, frame] of Object.entries(contract.packedFrames)) {
    assert(frame.format.length > 0, `Packed frame ${frameName} must declare format`)
    assert(
      frame.direction === 'js_calls_native' || frame.direction === 'native_calls_js',
      `Packed frame ${frameName} must use cross-boundary direction`,
    )
  }

  const sharedCodeNames = Object.keys(contract.sharedCodes)
  assert(sharedCodeNames.includes('writeResultCode'), 'sharedCodes.writeResultCode is required')
  assert(sharedCodeNames.includes('readResultCode'), 'sharedCodes.readResultCode is required')
  assert(sharedCodeNames.includes('verifyChunkResultByte'), 'sharedCodes.verifyChunkResultByte is required')
}

function validateConformance(
  conformance: NativeBindingsConformance,
  contract: NativeBindingsContract,
): void {
  assert(
    conformance.contractVersion === contract.contractVersion,
    'Conformance contractVersion must match native bindings contractVersion',
  )
  assert(
    conformance.behaviorVersion === contract.behaviorVersion,
    'Conformance behaviorVersion must match native bindings behaviorVersion',
  )

  const allowedPlatforms = new Set(contract.platforms)
  const symbolNames = new Set(contract.symbols.map((symbol) => symbol.name))
  const capabilityIds = new Set(contract.capabilities.map((capability) => capability.id))
  const seenCaseIds = new Set<string>()

  for (const testCase of conformance.cases) {
    assert(!seenCaseIds.has(testCase.id), `Duplicate conformance case ${testCase.id}`)
    seenCaseIds.add(testCase.id)

    validateRequiredPlatforms(testCase.requiredIn, allowedPlatforms, `Conformance case ${testCase.id}`)
    assert(testCase.symbols.length > 0, `Conformance case ${testCase.id} must reference at least one symbol`)

    if (testCase.availability === 'capability_gated') {
      assert(testCase.capability, `Capability-gated conformance case ${testCase.id} must declare capability`)
      assert(
        capabilityIds.has(testCase.capability),
        `Conformance case ${testCase.id} references unknown capability ${testCase.capability}`,
      )
    } else {
      assert(!testCase.capability, `Required conformance case ${testCase.id} must not declare capability`)
    }

    for (const symbol of testCase.symbols) {
      assert(symbolNames.has(symbol), `Conformance case ${testCase.id} references unknown symbol ${symbol}`)
    }
  }
}

function main(): void {
  const contract = readJson<NativeBindingsContract>(contractPath)
  const conformance = readJson<NativeBindingsConformance>(conformancePath)
  const bindingsSource = readFileSync(bindingsPath, 'utf8')
  const declaredSymbols = new Set(extractBindingNames(bindingsSource))

  validateContract(contract, declaredSymbols)
  validateConformance(conformance, contract)

  console.log(
    `Validated native bindings contract: ${contract.symbols.length} symbols, ${conformance.cases.length} cases`,
  )
}

main()
