import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

type Implementation = 'rust'
type CaseKind = 'shape' | 'behavior'
type CaseStatus = 'PASS' | 'FAIL' | 'MISSING' | 'N/A'

interface ConformanceCase {
  id: string
  kind: CaseKind
  requiredIn: Implementation[]
}

interface ConformanceManifest {
  protocolVersion: number
  behaviorVersion: number
  cases: ConformanceCase[]
}

interface ParsedAssertion {
  implementation: Implementation
  caseId: string
  status: 'passed' | 'failed'
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
const desktopRoot = resolve(repoRoot, 'desktop')
const contractsPath = resolve(repoRoot, 'contracts', 'native-host-conformance.json')
const rustSafeTitlePattern = /conformance__([a-z0-9_]+(?:__[a-z0-9_]+)*)__impl__(rust)(?:__|$)/

function readManifest(): ConformanceManifest {
  return JSON.parse(readFileSync(contractsPath, 'utf8')) as ConformanceManifest
}

function parseConformanceTitle(
  title: string,
): { caseId: string; implementation: Implementation } | null {
  const rustSafeMatch = rustSafeTitlePattern.exec(title)
  if (!rustSafeMatch) {
    return null
  }
  return {
    caseId: rustSafeMatch[1].replaceAll('__', '.'),
    implementation: rustSafeMatch[2] as Implementation,
  }
}

function runRustNativeHostConformance(): ParsedAssertion[] {
  const testTargets = ['native_messaging', 'profile_scenarios']
  const assertions: ParsedAssertion[] = []

  for (const target of testTargets) {
    console.log(`Running rust native-host conformance suite (${target})...`)
    const result = spawnSync(
      'cargo',
      ['test', '-p', 'jstorrent-host', '--test', target, 'conformance__', '--', '--nocapture'],
      {
        cwd: desktopRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      },
    )

    const output = `${result.stdout}${result.stderr}`
    const targetAssertions = collectRustAssertions(output)
    assertions.push(...targetAssertions)

    if (result.status !== 0 && targetAssertions.length === 0) {
      process.stdout.write(result.stdout)
      process.stderr.write(result.stderr)
      throw new Error(
        `Rust native-host conformance suite ${target} failed with exit code ${result.status ?? 'unknown'}`,
      )
    }
  }

  if (assertions.length === 0) {
    throw new Error('Rust native-host conformance suite completed without tagged test results')
  }

  return assertions
}

function collectRustAssertions(output: string): ParsedAssertion[] {
  const assertions: ParsedAssertion[] = []
  const lines = output.split(/\r?\n/)
  const testLinePattern =
    /^test (conformance__[a-z0-9_]+(?:__[a-z0-9_]+)*__impl__rust) \.\.\. (ok|FAILED)$/i

  for (const line of lines) {
    const match = testLinePattern.exec(line.trim())
    if (!match) {
      continue
    }
    const parsed = parseConformanceTitle(match[1])
    if (!parsed) {
      continue
    }
    assertions.push({
      implementation: parsed.implementation,
      caseId: parsed.caseId,
      status: match[2].toLowerCase() === 'ok' ? 'passed' : 'failed',
      title: match[1],
    })
  }

  return assertions
}

function aggregateByImplementation(
  assertions: ParsedAssertion[],
): Map<Implementation, Map<string, AggregateResult>> {
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

function validateManifestReferences(
  manifest: ConformanceManifest,
  assertions: ParsedAssertion[],
): void {
  const caseIds = new Set(manifest.cases.map((testCase) => testCase.id))
  const unknownCaseIds = [...new Set(assertions.map((assertion) => assertion.caseId))].filter(
    (caseId) => !caseIds.has(caseId),
  )

  if (unknownCaseIds.length > 0) {
    throw new Error(
      `Conformance-tagged tests reference unknown case IDs: ${unknownCaseIds.join(', ')}`,
    )
  }
}

function buildMatrix(
  manifest: ConformanceManifest,
  aggregates: Map<Implementation, Map<string, AggregateResult>>,
): Array<Record<string, string>> {
  return manifest.cases.map((testCase) => {
    const row: Record<string, string> = { case: testCase.id }
    if (!testCase.requiredIn.includes('rust')) {
      row.rust = 'N/A'
      return row
    }
    const aggregate = aggregates.get('rust')?.get(testCase.id)
    row.rust = aggregate?.status ?? 'MISSING'
    return row
  })
}

function formatMarkdownTable(rows: Array<Record<string, string>>): string {
  const lines = [
    '| Case | Rust |',
    '| --- | --- |',
    ...rows.map((row) => `| ${row.case} | ${row.rust} |`),
  ]
  return lines.join('\n')
}

function failIfRequiredCasesMissingOrFailed(rows: Array<Record<string, string>>): void {
  const failures: string[] = []
  for (const row of rows) {
    const status = row.rust
    if (status === 'FAIL' || status === 'MISSING') {
      failures.push(`${row.case} [rust] = ${status}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(`Native-host conformance gate failed:\n${failures.join('\n')}`)
  }
}

function maybeWriteSummary(markdown: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (!summaryPath) {
    return
  }
  writeFileSync(summaryPath, `## Native Host Conformance\n\n${markdown}\n`, { flag: 'a' })
}

function main(): void {
  const manifest = readManifest()
  const assertions = runRustNativeHostConformance()
  validateManifestReferences(manifest, assertions)

  const aggregates = aggregateByImplementation(assertions)
  const rows = buildMatrix(manifest, aggregates)
  const markdown = formatMarkdownTable(rows)

  console.log(markdown)
  maybeWriteSummary(markdown)
  failIfRequiredCasesMissingOrFailed(rows)
}

main()
