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
 * One thing belongs here and is deliberately NOT done yet, because this module
 * arrived as a pure extraction: **ambient configuration is still inherited.** A
 * global or system git config that sets `core.hooksPath` redirects
 * `git-receive-pack` away from `$GIT_DIR/hooks`, so walgit's `pre-receive` and
 * `reference-transaction` never run and a push is acknowledged with nothing
 * written to the log — the one outcome docs/adr/0007 exists to prevent.
 * `e2e/harness.ts` already strips it (`GIT_CONFIG_GLOBAL=/dev/null`) for
 * exactly this class of reason. This module is where that fix becomes one line.
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
  const res = spawnSync('git', [...args], {
    encoding: 'utf8',
    input: opts.input,
    maxBuffer: MAX_BUFFER,
  })
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
}

/** git, where a non-zero exit is a bug rather than an answer. */
export function gitOrThrow(args: readonly string[], opts: GitOptions = {}): GitResult {
  const res = git(args, opts)
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr.trim()}`)
  }
  return res
}
