import { spawnSync } from 'node:child_process'
import * as path from 'node:path'

/**
 * Subtree-mode plumbing: consumers vendor the zbc engine + built-in modules as
 * a git subtree of Zabaca/zbc-core at `vendor/zbc`, instead of copying
 * templates. Updates flow with `git subtree pull` (zbc update), contributions
 * with `git subtree push`. Copy mode stays available; the two are told apart
 * by whether vendor/zbc/src/define-module.ts exists.
 */

export const VENDOR_PREFIX = 'vendor/zbc'
export const DEFAULT_CORE_URL = 'https://github.com/Zabaca/zbc-core.git'

/** Core tags mirror the CLI version: zbc-core-v<x.y.z>. */
export function coreRefForVersion(version: string): string {
  return `zbc-core-v${version}`
}

/** Vendored engine present → this project consumes zbc as a subtree. */
export async function isVendorMode(projectRoot: string): Promise<boolean> {
  return Bun.file(path.join(projectRoot, VENDOR_PREFIX, 'src/define-module.ts')).exists()
}

export function git(cwd: string, args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (res.status !== 0 || res.error) {
    const detail = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim()
    throw new Error(`git ${args.join(' ')} failed: ${detail || res.error?.message}`)
  }
  return res.stdout
}

/**
 * `git subtree add/pull` refuse mid-operation on a dirty tree; check up front
 * so the failure is ours, names the problem, and happens before any mutation.
 */
export function ensureCleanGitTree(cwd: string): void {
  const status = git(cwd, ['status', '--porcelain'])
  if (status.trim() !== '') {
    throw new Error(
      `git tree has uncommitted changes — commit or stash first:\n${status.trimEnd()}`,
    )
  }
}

/**
 * Where a subtree lands. The engine's is `vendor/zbc`, the default; a vendored
 * app names its own (`vendor/space`), so one project can hold several subtrees
 * and each pull only ever touches its own prefix.
 */
interface SubtreeOptions {
  url: string
  ref: string
  prefix?: string
}

/** Vendor a repository at the prefix (squashed). One commit, reversible via git. */
export function subtreeAdd(cwd: string, opts: SubtreeOptions): void {
  ensureCleanGitTree(cwd)
  const prefix = opts.prefix ?? VENDOR_PREFIX
  git(cwd, ['subtree', 'add', `--prefix=${prefix}`, opts.url, opts.ref, '--squash'])
}

/** Pull a newer ref into the prefix (squashed merge). */
export function subtreePull(cwd: string, opts: SubtreeOptions): void {
  ensureCleanGitTree(cwd)
  const prefix = opts.prefix ?? VENDOR_PREFIX
  git(cwd, ['subtree', 'pull', `--prefix=${prefix}`, opts.url, opts.ref, '--squash'])
}

/**
 * The upstream commit a prefix was last pulled at, read from git's own record:
 * every squashed `subtree add` and `subtree pull` writes a commit whose message
 * carries `git-subtree-dir` and `git-subtree-split`. Null when the prefix was
 * never vendored as a subtree in this history.
 */
export function subtreeSplitCommit(cwd: string, prefix: string): string | null {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let body: string
  try {
    body = git(cwd, ['log', '-1', `--grep=^git-subtree-dir: ${escaped}/*$`, '--format=%B'])
  } catch {
    return null
  }
  return /^git-subtree-split: ([0-9a-f]{7,64})$/m.exec(body)?.[1] ?? null
}
