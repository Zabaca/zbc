/**
 * The command line, parsed without touching anything.
 *
 * Kept separate from the process for one reason: every flag here changes what
 * an agent's background watcher does, and the cost of getting one wrong is a
 * clone that silently stops updating. Parsing is the part that can be tested
 * exhaustively, so it is the part that is pure.
 */

export interface WatchOptions {
  /** `repo` → working directory to fetch into. Empty means "discover from cwd". */
  targets: Map<string, string>
  /** Full ref names. Empty means "whatever HEAD is on". */
  refs: string[]
  /** Watch every ref in each repository, rather than a named list. */
  allRefs: boolean
  host: string | null
  token: string | null
  /** Exit 0 after the first ref moves — the "wait for the handoff" mode. */
  once: boolean
  fetch: boolean
  /** Run after a fetch that changed something. */
  onChange: string | null
  json: boolean
}

export type Parsed =
  | { kind: 'watch'; options: WatchOptions }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string }

const FLAGS_WITH_VALUES = new Set(['--ref', '--host', '--token', '--on'])

export function parseArgs(argv: readonly string[]): Parsed {
  if (argv.length === 0) return { kind: 'help' }

  const [command, ...rest] = argv
  if (command === '--help' || command === '-h' || command === 'help') return { kind: 'help' }
  if (command === '--version' || command === '-v') return { kind: 'version' }
  if (command !== 'watch') {
    return { kind: 'error', message: `unknown command ${JSON.stringify(command)}` }
  }

  const options: WatchOptions = {
    targets: new Map(),
    refs: [],
    allRefs: false,
    host: null,
    token: null,
    once: false,
    fetch: true,
    onChange: null,
    json: false,
  }

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string

    if (FLAGS_WITH_VALUES.has(arg)) {
      const value = rest[i + 1]
      if (value === undefined || value.startsWith('-')) {
        return { kind: 'error', message: `${arg} needs a value` }
      }
      i += 1
      if (arg === '--ref') options.refs.push(value)
      else if (arg === '--host') options.host = value
      else if (arg === '--token') options.token = value
      else options.onChange = value
      continue
    }

    switch (arg) {
      case '--all-refs':
        options.allRefs = true
        continue
      case '--once':
        options.once = true
        continue
      case '--no-fetch':
        options.fetch = false
        continue
      case '--json':
        options.json = true
        continue
      case '--help':
      case '-h':
        return { kind: 'help' }
    }

    if (arg.startsWith('-')) return { kind: 'error', message: `unknown flag ${arg}` }

    // A bare `name` watches that repository and fetches into the current
    // directory's clone; `name=dir` says where instead. The second form is what
    // one process watching several checkouts needs.
    const split = arg.indexOf('=')
    if (split === 0)
      return { kind: 'error', message: `expected <repo> or <repo>=<dir>, got ${arg}` }
    if (split < 0) options.targets.set(arg, '')
    else options.targets.set(arg.slice(0, split), arg.slice(split + 1))
  }

  if (options.allRefs && options.refs.length > 0) {
    return { kind: 'error', message: '--all-refs and --ref are mutually exclusive' }
  }
  if (options.targets.size > 1 && [...options.targets.values()].some((dir) => dir === '')) {
    return {
      kind: 'error',
      message: 'watching more than one repository needs a directory for each: <repo>=<dir>',
    }
  }

  return { kind: 'watch', options }
}
