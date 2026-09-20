/**
 * The one place walgit runs a git plumbing command.
 *
 * walgit's whole premise is that vanilla git runs on local disk, so git is
 * spawned constantly — `init --bare`, `config`, `index-pack`, `for-each-ref`,
 * `cat-file --batch-check`, `repack -adf`. Before this module those six lived in
 * four files behind two byte-identical private `run` helpers and two bare
 * `spawnSync` calls, each with its own idea of what a failure looks like.
 *
 * It covers the commands walgit runs and READS. It deliberately does not cover
 * the two places git is not a subprocess to be read but a transport to be
 * handed the socket: `git-backend.ts` runs `git http-backend`
 * with inherited stdio, and `git-backend.ts` streams `git http-backend` as CGI.
 * Both speak the pack protocol on their own stdio and must never be buffered.
 *
 * **Hygiene is this module's job, not the caller's.** Two kinds of input reach
 * git here, and neither is safe left as it arrives:
 *
 *   - **Arguments.** A ref, an oid or a path is DATA, and git reads an argument
 *     beginning with `-` as an option wherever one is allowed. So a caller
 *     never concatenates them into `args`: revisions go in `operands` (placed
 *     after git's own `--end-of-options` fence) and paths go in `paths` (after
 *     `--`). `args` is the subcommand and its flags, which this repository
 *     writes and nobody else supplies.
 *   - **The environment.** Every inherited `GIT_*` variable is dropped at
 *     spawn. A global or system git config that sets `core.hooksPath`
 *     redirects `git-receive-pack` away from `$GIT_DIR/hooks`, so walgit's
 *     `pre-receive` and `reference-transaction` never run and a push is
 *     acknowledged with nothing written to the log — the one outcome
 *     docs/adr/0007 exists to prevent. Dropping `GIT_CONFIG_GLOBAL` would
 *     RE-OPEN that door (`e2e/harness.ts` sets it to `/dev/null` precisely to
 *     close it), so the strip is paired with pinning both config paths at
 *     `/dev/null` here. A caller that needs a variable says so in `env`.
 *
 * It covers the commands walgit runs and READS. It deliberately does not cover
 * the two places git is not a subprocess to be read but a transport to be
 * handed the socket: `git-backend.ts` runs `git http-backend` with inherited
 * stdio, and streams it as CGI. Both speak the pack protocol on their own
 * stdio and must never be buffered — and both are given an explicit
 * environment of their own for the same reason this one is.
 */

import { spawnSync } from 'node:child_process'

export interface GitResult {
  /** git's exit code. `null` from spawnSync (killed by signal) reads as 1. */
  status: number
  stdout: string
  stderr: string
}

export interface GitOptions {
  /** Fed to the command on stdin, e.g. the oid list `cat-file` batches over. */
  input?: string
  /**
   * The repository, named rather than discovered. git's own discovery walks up
   * from the working directory and would find whichever repository the process
   * happens to sit in — which for a hook or a CLI command is not necessarily
   * the one being operated on.
   */
  gitDir?: string
  /**
   * Revisions, oids and other non-path operands. Placed after
   * `--end-of-options`, so `-p` or `--output=x` arriving as a ref name is read
   * as the ref it is.
   */
  operands?: readonly string[]
  /** Pathspecs. Placed after `--`, which is git's fence for exactly this. */
  paths?: readonly string[]
  /**
   * Variables to set on the child on top of the stripped environment. An
   * `undefined` value removes one. This is the only way a `GIT_*` variable
   * reaches git from here.
   */
  env?: Record<string, string | undefined>
  /**
   * Keep the three variables git itself sets so a hook can see the objects a
   * push is offering (`GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
   * `GIT_QUARANTINE_PATH`).
   *
   * Only `pre-receive`'s verdicts need it — they ask git about commits that are
   * still in the quarantine and not yet in the repository — and it is opt-in
   * rather than inherited because for every other caller the variable points at
   * an object store that has nothing to do with the command being run.
   */
  inheritObjects?: boolean
}

/** What git sets for a hook so the pushed objects are readable. */
const QUARANTINE_VARS = [
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
] as const

/**
 * The child's environment: the parent's, minus every `GIT_*`, with ambient
 * config pinned out of the way and the caller's additions last.
 */
function childEnv(opts: GitOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value
  }
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_CONFIG_SYSTEM = '/dev/null'
  if (opts.inheritObjects) {
    for (const name of QUARANTINE_VARS) {
      const value = process.env[name]
      if (value !== undefined) env[name] = value
    }
  }
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

/** The full argument vector, with git's two fences where they belong. */
function argv(args: readonly string[], opts: GitOptions): string[] {
  const operands = opts.operands ?? []
  const paths = opts.paths ?? []
  return [
    ...(opts.gitDir ? ['--git-dir', opts.gitDir] : []),
    ...args,
    ...(operands.length > 0 ? ['--end-of-options', ...operands] : []),
    ...(paths.length > 0 ? ['--', ...paths] : []),
  ]
}

/**
 * Run git and return what it said. A non-zero exit is a VALUE, not a throw —
 * several callers branch on it (`config --get` on an unset key, a `verify` that
 * reports rather than fails), and turning those into exceptions would make the
 * normal case an error path.
 */
/**
 * How much output one git command may produce before it is cut off.
 *
 * Raised from the runtime's 1 MiB default, which `for-each-ref` on a repository
 * with tens of thousands of refs exceeds. Overrunning it is not the clean
 * failure it looks like: the buffer can come back TRUNCATED with a zero exit,
 * so a caller that trusts the exit status reads a shorter answer than git gave.
 * Every caller here reads git's output for meaning, so the cap is set well past
 * anything walgit asks for rather than left where a real repository meets it.
 */
const MAX_BUFFER = 64 * 1024 * 1024

export function git(args: readonly string[], opts: GitOptions = {}): GitResult {
  const res = spawnSync('git', argv(args, opts), {
    encoding: 'utf8',
    input: opts.input,
    maxBuffer: MAX_BUFFER,
    env: childEnv(opts),
  })
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
}

/**
 * git, where the output is BYTES rather than text.
 *
 * One caller: reading a blob (`src/browse.ts`). A repository holds whatever was
 * pushed to it, and decoding a PNG as UTF-8 replaces every byte git actually
 * stored with U+FFFD — which is both the wrong file to hand back and a NUL
 * sniff that says "text". `stderr` stays a string, because a diagnostic is one.
 */
export function gitBytes(
  args: readonly string[],
  opts: GitOptions = {},
): { status: number; stdout: Uint8Array; stderr: string } {
  const res = spawnSync('git', argv(args, opts), {
    input: opts.input,
    maxBuffer: MAX_BUFFER,
    env: childEnv(opts),
  })
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? new Uint8Array(),
    stderr: res.stderr?.toString('utf8') ?? '',
  }
}

/** git, where a non-zero exit is a bug rather than an answer. */
export function gitOrThrow(args: readonly string[], opts: GitOptions = {}): GitResult {
  const res = git(args, opts)
  if (res.status !== 0) {
    throw new Error(`git ${argv(args, opts).join(' ')} failed: ${res.stderr.trim()}`)
  }
  return res
}
