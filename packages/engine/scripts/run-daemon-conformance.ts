import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

type Implementation = 'node' | 'rust' | 'android'
type CaseKind = 'shape' | 'behavior'
type CaseStatus = 'PASS' | 'FAIL' | 'MISSING' | 'N/A'

interface ConformanceCase {
  id: string
  kind: CaseKind
  requiredIn: Implementation[]
  requiresCapability?: string
}

interface ConformanceManifest {
  behaviorVersion: number
  cases: ConformanceCase[]
}

interface VitestAssertionResult {
  title: string
  fullName: string
  status: string
  failureMessages?: string[]
}

interface VitestTestResult {
  name: string
  assertionResults: VitestAssertionResult[]
}

interface VitestJsonReport {
  success: boolean
  testResults: VitestTestResult[]
}

interface ParsedAssertion {
  implementation: Implementation
  caseId: string
  status: string
  title: string
}

interface AggregateResult {
  status: CaseStatus
  assertions: ParsedAssertion[]
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const engineRoot = resolve(__dirname, '..')
const repoRoot = resolve(engineRoot, '..', '..')
const contractsPath = resolve(repoRoot, 'contracts', 'io-daemon-conformance.json')
const titlePattern = /\[conformance:([^\]]+)\]\[impl:(node|rust|android)\]/

function parseImplementations(argv: string[]): Implementation[] {
  const arg = argv.find(value => value.startsWith('--implementations='))
  if (!arg) {
    return ['node', 'rust']
  }
  const values = arg
    .slice('--implementations='.length)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  if (values.length === 0) {
    throw new Error('No implementations provided to --implementations')
  }
  const implementations = values.map(value => {
    if (value !== 'node' && value !== 'rust' && value !== 'android') {
      throw new Error(`Unsupported implementation "${value}"`)
    }
    return value
  })
  return implementations
}

function readManifest(): ConformanceManifest {
  return JSON.parse(readFileSync(contractsPath, 'utf8')) as ConformanceManifest
}

function runVitestForImplementation(implementation: Implementation, outputFile: string): VitestJsonReport {
  if (implementation === 'android') {
    throw new Error(
      'Android conformance is not wired into the Node runner yet. Tag the instrumented tests and add an Android adapter before gating it here.',
    )
  }

  if (implementation === 'rust') {
    console.log('Building Rust IO daemon binary...')
    const buildResult = spawnSync('cargo', ['build', '-p', 'jstorrent-io-daemon'], {
      cwd: resolve(repoRoot, 'desktop'),
      encoding: 'utf8',
      stdio: 'pipe',
    })
    if (buildResult.status !== 0) {
      process.stdout.write(buildResult.stdout)
      process.stderr.write(buildResult.stderr)
      throw new Error(`Rust daemon build failed with exit code ${buildResult.status ?? 'unknown'}`)
    }
  }

  const args =
    implementation === 'node'
      ? ['exec', 'vitest', 'run', 'test/node-io-daemon', '-t', 'conformance:', '--reporter=json', '--outputFile', outputFile]
      : [
          'exec',
          'vitest',
          'run',
          '--config',
          'vitest.daemon.config.ts',
          'integration/daemon',
          '-t',
          'conformance:',
          '--reporter=json',
          '--outputFile',
          outputFile,
        ]

  console.log(`Running ${implementation} conformance suite...`)
  const result = spawnSync('pnpm', args, {
    cwd: engineRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  })

  if (result.status !== 0) {
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    throw new Error(`${implementation} conformance suite failed with exit code ${result.status ?? 'unknown'}`)
  }

  const report = JSON.parse(readFileSync(outputFile, 'utf8')) as VitestJsonReport
  if (!report.success) {
    throw new Error(`${implementation} conformance suite completed without a successful Vitest report`)
  }

  return report
}

function collectAssertions(report: VitestJsonReport): ParsedAssertion[] {
  const assertions: ParsedAssertion[] = []

  for (const suite of report.testResults) {
    for (const assertion of suite.assertionResults) {
      const match = titlePattern.exec(assertion.title)
      if (!match) {
        continue
      }
      const [, caseId, implementation] = match
      assertions.push({
        implementation: implementation as Implementation,
        caseId,
        status: assertion.status,
        title: assertion.title,
      })
    }
  }

  return assertions
}

function aggregateByImplementation(assertions: ParsedAssertion[]): Map<Implementation, Map<string, AggregateResult>> {
  const byImplementation = new Map<Implementation, Map<string, AggregateResult>>()

  for (const assertion of assertions) {
    let byCase = byImplementation.get(assertion.implementation)
    if (!byCase) {
      byCase = new Map()
      byImplementation.set(assertion.implementation, byCase)
    }

    const existing = byCase.get(assertion.caseId)
    if (existing) {
      existing.assertions.push(assertion)
      if (assertion.status !== 'passed') {
        existing.status = 'FAIL'
      }
      continue
    }

    byCase.set(assertion.caseId, {
      status: assertion.status === 'passed' ? 'PASS' : 'FAIL',
      assertions: [assertion],
    })
  }

  return byImplementation
}

function validateManifestReferences(manifest: ConformanceManifest, assertions: ParsedAssertion[]): void {
  const caseIds = new Set(manifest.cases.map(testCase => testCase.id))
  const unknownCaseIds = [...new Set(assertions.map(assertion => assertion.caseId))].filter(caseId => !caseIds.has(caseId))

  if (unknownCaseIds.length > 0) {
    throw new Error(`Conformance-tagged tests reference unknown case IDs: ${unknownCaseIds.join(', ')}`)
  }
}

function buildMatrix(
  manifest: ConformanceManifest,
  implementations: Implementation[],
  aggregates: Map<Implementation, Map<string, AggregateResult>>,
): Array<Record<string, string>> {
  return manifest.cases.map(testCase => {
    const row: Record<string, string> = { case: testCase.id }
    for (const implementation of implementations) {
      if (!testCase.requiredIn.includes(implementation)) {
        row[implementation] = 'N/A'
        continue
      }
      const aggregate = aggregates.get(implementation)?.get(testCase.id)
      row[implementation] = aggregate?.status ?? 'MISSING'
    }
    return row
  })
}

function formatMarkdownTable(implementations: Implementation[], rows: Array<Record<string, string>>): string {
  const headers = ['Case', ...implementations.map(value => value[0].toUpperCase() + value.slice(1))]
  const separator = headers.map(() => '---')
  const body = rows.map(row => [row.case, ...implementations.map(implementation => row[implementation])])
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...body.map(columns => `| ${columns.join(' | ')} |`),
  ]
  return lines.join('\n')
}

function failIfRequiredCasesMissingOrFailed(
  rows: Array<Record<string, string>>,
  implementations: Implementation[],
): void {
  const failures: string[] = []
  for (const row of rows) {
    for (const implementation of implementations) {
      const status = row[implementation]
      if (status === 'FAIL' || status === 'MISSING') {
        failures.push(`${row.case} [${implementation}] = ${status}`)
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`Conformance gate failed:\n${failures.join('\n')}`)
  }
}

function maybeWriteSummary(markdown: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (!summaryPath) {
    return
  }
  writeFileSync(summaryPath, `## IO Daemon Conformance\n\n${markdown}\n`, { flag: 'a' })
}

function main(): void {
  const implementations = parseImplementations(process.argv.slice(2))
  const manifest = readManifest()
  const tempDir = mkdtempSync(join(tmpdir(), 'io-daemon-conformance-'))

  try {
    const allAssertions: ParsedAssertion[] = []
    for (const implementation of implementations) {
      const outputFile = join(tempDir, `${implementation}.json`)
      const report = runVitestForImplementation(implementation, outputFile)
      const assertions = collectAssertions(report)
      allAssertions.push(...assertions)
    }

    validateManifestReferences(manifest, allAssertions)

    const aggregates = aggregateByImplementation(allAssertions)
    const rows = buildMatrix(manifest, implementations, aggregates)
    const markdown = formatMarkdownTable(implementations, rows)

    console.log(markdown)
    maybeWriteSummary(markdown)
    failIfRequiredCasesMissingOrFailed(rows, implementations)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

main()
