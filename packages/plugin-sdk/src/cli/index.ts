#!/usr/bin/env node
import { runValidate } from './commands/validate.js'
import { runTest } from './commands/test.js'
import { runInspect } from './commands/inspect.js'

const args = process.argv.slice(2)
const command = args[0]

function usage(): void {
  console.log(`Usage: jstorrent-plugin <command> [options]

Commands:
  validate <plugin.js>                        Validate manifest and module structure
  test <plugin.js> --query "term" [--category cat]  Run a search and print results
  inspect <plugin.js>                         Print manifest details

Options:
  --help  Show this help message`)
}

function getFlag(name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1 || index + 1 >= args.length) return undefined
  return args[index + 1]
}

async function main(): Promise<void> {
  if (!command || command === '--help' || command === '-h') {
    usage()
    return
  }

  const filePath = args[1]
  if (!filePath) {
    console.error(`Error: missing plugin file path\n`)
    usage()
    process.exitCode = 1
    return
  }

  switch (command) {
    case 'validate':
      runValidate(filePath)
      break

    case 'test': {
      const query = getFlag('--query')
      if (!query) {
        console.error('Error: --query is required for the test command\n')
        usage()
        process.exitCode = 1
        return
      }
      const category = getFlag('--category')
      await runTest(filePath, query, category)
      break
    }

    case 'inspect':
      runInspect(filePath)
      break

    default:
      console.error(`Unknown command: ${command}\n`)
      usage()
      process.exitCode = 1
  }
}

void main()
