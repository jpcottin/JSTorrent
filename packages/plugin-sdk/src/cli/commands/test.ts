import { readFileSync } from 'node:fs'
import { runPlugin } from '../../runtime/runner.js'
import { formatManifest, formatResults, formatTrace } from '../format.js'

export async function runTest(filePath: string, query: string, category?: string): Promise<void> {
  const source = readFileSync(filePath, 'utf-8')

  const result = await runPlugin({
    source,
    input: { query, category },
    enforceHosts: true,
  })

  if (result.module?.manifest) {
    console.log(formatManifest(result.module.manifest))
    console.log('')
  }

  console.log(formatTrace(result.trace))

  if (result.trace.results.length > 0) {
    console.log('\nResults:')
    console.log(formatResults(result.trace.results))
  }

  if (!result.trace.ok) {
    process.exitCode = 1
  }
}
