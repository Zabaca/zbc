/**
 * git, as this client uses it: read-only about the checkout, and additive about
 * the clone.
 *
 * The one invariant worth stating out loud, because a watcher that broke it
 * would be a menace: nothing here moves a branch, touches the working tree, or
 * writes to the stash list. `fetch` advances `origin/<ref>` and stops. Merging
 * or rebasing stays a decision its owner makes, after being told there is one
 * to make.
 */

import { spawnSync } from 'node:child_process'

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

export function git(dir: string | null, args: readonly string[]): GitResult {
  const full = dir ? ['-C', dir, ...args] : [...args]
  const run = spawnSync('git', full, { encoding: 'utf8' })
  if (run.error) return { code: 127, stdout: '', stderr: String(run.error.message) }
  return {
    code: run.status ?? 1,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
  }
}

/** The root of the checkout `cwd` is in, or `null` if it is not in one. */
export function toplevel(cwd: string): string | null {
  const result = git(cwd, ['rev-parse', '--show-toplevel'])
  return result.code === 0 ? result.stdout.trim() : null
}

export function remoteList(dir: string): string {
  return git(dir, ['remote', '-v']).stdout
}

export function symbolicHead(dir: string): string {
  return git(dir, ['symbolic-ref', '--quiet', 'HEAD']).stdout
}

/** `refs/heads/main` → `main`. Anything else is passed through untouched. */
export function shortRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, '')
}
