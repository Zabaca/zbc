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

function git(cwd: string, args: string[]): string {
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

/** Vendor core at vendor/zbc (squashed). One commit, reversible via git. */
export function subtreeAdd(cwd: string, opts: { url: string; ref: string }): void {
  ensureCleanGitTree(cwd)
  git(cwd, ['subtree', 'add', `--prefix=${VENDOR_PREFIX}`, opts.url, opts.ref, '--squash'])
}

/** Pull a newer core ref into vendor/zbc (squashed merge). */
export function subtreePull(cwd: string, opts: { url: string; ref: string }): void {
  ensureCleanGitTree(cwd)
  git(cwd, ['subtree', 'pull', `--prefix=${VENDOR_PREFIX}`, opts.url, opts.ref, '--squash'])
}
