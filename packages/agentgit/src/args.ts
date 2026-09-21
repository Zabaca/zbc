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
  /**
   * Fast-forward the branch onto the fetched work when the tree is clean.
   *
   * The one mode in which this client moves a branch, and off by default: a
   * watcher that moved a branch nobody asked it to move would be a menace. The
   * flag is the owner's decision, made once instead of per event, and it acts
   * only where there is nothing in the tree to lose and nothing to decide.
   */
  ffOnClean: boolean
  /**
   * Also report the Proposals aimed at the branch being watched (docs/adr/0018).
   *
   * Opt-in, and it stays opt-in: the default watch exists to keep a branch
   * current, and a stranger's Proposal must never move a working agent's clone.
   */
  proposals: boolean
  json: boolean
}

/** The three things git ever asks a credential helper to do. */
export type CredentialOperation = 'get' | 'store' | 'erase'

export type Parsed =
  | { kind: 'watch'; options: WatchOptions }
  | { kind: 'credential'; operation: CredentialOperation }
  | { kind: 'setup'; host: string | null; global: boolean }
  | { kind: 'accept'; id: string }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string }

const CREDENTIAL_OPERATIONS = new Set<string>(['get', 'store', 'erase'])

const FLAGS_WITH_VALUES = new Set(['--ref', '--host', '--token', '--on'])

export function parseArgs(argv: readonly string[]): Parsed {
  if (argv.length === 0) return { kind: 'help' }

  const [command, ...rest] = argv
  if (command === '--help' || command === '-h' || command === 'help') return { kind: 'help' }
  if (command === '--version' || command === '-v') return { kind: 'version' }
  // `credential` is not typed by a person: git spawns it with exactly one
  // operation and talks the rest on stdin. An operation git does not have is
  // refused rather than read as `get`, because a helper that answered a
  // misspelled verb with a signature would be signing for a caller nobody
  // recognises.
  if (command === 'credential') {
    const operation = rest[0]
    if (rest.length !== 1 || operation === undefined || !CREDENTIAL_OPERATIONS.has(operation)) {
      return {
        kind: 'error',
        message: `credential takes exactly one of get, store, erase — got ${rest.join(' ') || 'nothing'}`,
      }
    }
    return { kind: 'credential', operation: operation as CredentialOperation }
  }

  if (command === 'setup') {
    let host: string | null = null
    let isGlobal = true
    for (const arg of rest) {
      if (arg === '--local') {
        isGlobal = false
        continue
      }
      if (arg === '--global') {
        isGlobal = true
        continue
      }
      if (arg.startsWith('-')) return { kind: 'error', message: `unknown flag ${arg}` }
      if (host !== null) return { kind: 'error', message: 'setup takes at most one host' }
      host = arg
    }
    return { kind: 'setup', host, global: isGlobal }
  }

  // `accept` takes an id and nothing else. Everything else it needs — the
  // repository, the host, the target — is the clone it is run in, and a flag
  // that overrode one of those would be a way to merge a Proposal onto a branch
  // nobody is standing on.
  if (command === 'accept') {
    const ids: string[] = []
    for (const arg of rest) {
      if (arg === '--help' || arg === '-h') return { kind: 'help' }
      if (arg.startsWith('-')) return { kind: 'error', message: `unknown flag ${arg}` }
      ids.push(arg)
    }
    const id = ids[0]
    if (ids.length !== 1 || id === undefined) {
      return {
        kind: 'error',
        message: `accept takes exactly one Proposal id — got ${ids.join(' ') || 'nothing'}`,
      }
    }
    return { kind: 'accept', id }
  }

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
    ffOnClean: false,
    proposals: false,
    json: false,
  }

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string

    if (FLAGS_WITH_VALUES.has(arg)) {
      const value = rest[i + 1]
      // Three spellings of "nothing": the flag was last, the next word is
      // another flag, or the value is an empty string. The third is the one
      // that used to get through — `--host ''` is not a host, and a null check
      // downstream cannot tell it from one.
      if (value === undefined || value === '' || value.startsWith('-')) {
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
      case '--proposals':
        options.proposals = true
        continue
      case '--once':
        options.once = true
        continue
      case '--no-fetch':
        options.fetch = false
        continue
      case '--ff-on-clean':
        options.ffOnClean = true
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

  // A Proposal ref names the branch it targets, so the namespace to watch is
  // derived from the branch — and `--all-refs` is precisely the mode that has
  // no branch. Refused rather than silently reporting nothing.
  if (options.proposals && options.allRefs) {
    return { kind: 'error', message: '--proposals and --all-refs are mutually exclusive' }
  }
  if (options.allRefs && options.refs.length > 0) {
    return { kind: 'error', message: '--all-refs and --ref are mutually exclusive' }
  }
  // Nothing was fetched, so there is nothing to fast-forward onto. Refused
  // rather than silently doing nothing, because the two flags together read as
  // a request the client cannot honour.
  if (options.ffOnClean && !options.fetch) {
    return {
      kind: 'error',
      message: '--ff-on-clean needs a fetch; it cannot be used with --no-fetch',
    }
  }
  if (options.targets.size > 1 && [...options.targets.values()].some((dir) => dir === '')) {
    return {
      kind: 'error',
      message: 'watching more than one repository needs a directory for each: <repo>=<dir>',
    }
  }

  return { kind: 'watch', options }
}
