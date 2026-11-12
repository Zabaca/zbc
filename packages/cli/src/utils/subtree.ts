import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
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
 * The repository's top level, or null outside a git work tree. A zbc project
 * may be a subfolder of a larger repository (a pnpm monorepo adopting zbc in
 * `deploy/zbc/`), and git's own paths are the top level's, not the project's.
 */
export function gitTopLevel(cwd: string): string | null {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' })
  if (res.status !== 0 || res.error) return null
  return res.stdout.trim() || null
}

/** The project root relative to the top level, posix-style; '' at the top level or outside git. */
export function projectSubdir(projectRoot: string): string {
  const top = gitTopLevel(projectRoot)
  if (top === null) return ''
  // Both sides through realpath: git reports the resolved top level, and a
  // project reached through a symlink (macOS's /tmp) would otherwise climb out.
  const rel = path.relative(fs.realpathSync(top), fs.realpathSync(projectRoot))
  return rel.split(path.sep).join('/')
}

/**
 * Where git sees a project-relative path: `vendor/zbc` in a project at the top
 * level, `deploy/zbc/vendor/zbc` in one at `deploy/zbc/`. Derived on every
 * call, never stored, so a project folder that moves keeps working. Outside a
 * git work tree it is the project-relative path unchanged.
 */
export function gitPrefix(projectRoot: string, prefix: string = VENDOR_PREFIX): string {
  const sub = projectSubdir(projectRoot)
  return sub === '' ? prefix : path.posix.join(sub, prefix)
}

/**
 * Where a subtree lands, relative to the project root. The engine's is
 * `vendor/zbc`, the default; a vendored app names its own (`vendor/space`), so
 * one project can hold several subtrees and each pull only ever touches its own
 * prefix. `git subtree` refuses to run anywhere but the top level, so these
 * resolve the top level and the prefix as git sees it themselves.
 */
interface SubtreeOptions {
  url: string
  ref: string
  prefix?: string
}

function subtree(projectRoot: string, verb: 'add' | 'pull', opts: SubtreeOptions): void {
  ensureCleanGitTree(projectRoot)
  const top = gitTopLevel(projectRoot) ?? projectRoot
  const prefix = gitPrefix(projectRoot, opts.prefix ?? VENDOR_PREFIX)
  git(top, ['subtree', verb, `--prefix=${prefix}`, opts.url, opts.ref, '--squash'])
}

/** Vendor a repository at the prefix (squashed). One commit, reversible via git. */
export function subtreeAdd(projectRoot: string, opts: SubtreeOptions): void {
  subtree(projectRoot, 'add', opts)
}

/** Pull a newer ref into the prefix (squashed merge). */
export function subtreePull(projectRoot: string, opts: SubtreeOptions): void {
  subtree(projectRoot, 'pull', opts)
}

/**
 * The upstream commit a prefix was last pulled at, read from git's own record:
 * every squashed `subtree add` and `subtree pull` writes a commit whose message
 * carries `git-subtree-dir` and `git-subtree-split`. Null when the prefix was
 * never vendored as a subtree in this history. `prefix` is project-relative;
 * git recorded the top-level-relative one.
 */
export function subtreeSplitCommit(projectRoot: string, prefix: string): string | null {
  const escaped = gitPrefix(projectRoot, prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let body: string
  try {
    body = git(projectRoot, ['log', '-1', `--grep=^git-subtree-dir: ${escaped}/*$`, '--format=%B'])
  } catch {
    return null
  }
  return /^git-subtree-split: ([0-9a-f]{7,64})$/m.exec(body)?.[1] ?? null
}
