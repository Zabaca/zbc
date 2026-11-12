/**
 * Administering one repository over HTTP — create it (optionally with a first
 * commit), delete it, read what it holds — for a server that has the admin
 * credential and nothing else.
 *
 * The three already existed as operator commands (`walgit delete`, `walgit
 * usage`) that need the object store's own credentials. A host minting one
 * repository per tenant (docs/adr/0021) wants them without holding those, so
 * they are answered here, by the one process that already holds the store.
 * Nothing in this file is a second implementation: delete is `deleteRepo` with
 * its grace semantics, usage is `usageOfIndex`, and a seed is an ordinary push.
 *
 * **A seed is a push, not a write.** The first commit is built in a scratch
 * repository and pushed into the repository's cache over git's local
 * transport, so `pre-receive` and `reference-transaction` judge it exactly as
 * they judge a client's push: the size caps, a Signer List, the WAL publish
 * that makes it durable. Writing the Index and the pack directly would be a
 * second push path, and the one this file must never become is a door around
 * the rules a push is held to.
 *
 * The routing and the credential are `src/http.ts`'s; this is what the routes
 * do once they have been reached.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { indexKey } from '../shared/keys'
import type { ObjectStore } from '../shared/store'
import { emptyIndex, loadIndex } from '../shared/wal-index'
import { deleteRepo, type DeleteResult } from './delete-repo'
import { git, gitOrThrow } from './git'
import type { ResolvedRepo } from './repo'
import { usageOfIndex, type RepoUsage } from './usage'
import { commitIndex } from './wal-index'

/**
 * The largest seed body walgit will read.
 *
 * A seed is a scaffold — a README, a config file, a starter tree — and it
 * arrives as JSON held in memory, so it is bounded here before it is parsed.
 * Anything larger is a real push, which streams.
 */
export const MAX_SEED_BYTES = 1024 * 1024

/** How many files one seed may name. A bound on the work one request does. */
export const MAX_SEED_FILES = 1000

/** The first commit a created repository holds, as the request names it. */
export interface Seed {
  /** Repository path → file content (UTF-8). Every file is mode `100644`. */
  files: Record<string, string>
  message: string
  author: { name: string; email: string }
  /** A branch name, not a ref: `main` becomes `refs/heads/main`. */
  branch: string
}

export type SeedParse = { ok: true; seed: Seed | null } | { ok: false; message: string }

/**
 * Read a create request's body: empty means an empty repository, and anything
 * else must be a well-formed seed.
 *
 * Strict rather than forgiving, because every field ends up in a git object
 * that cannot be edited afterwards — a path git would refuse, an ident with a
 * `<` in it, a branch name that is not one. Each is refused here with what was
 * wrong, before a repository is created at all.
 */
export function parseSeed(text: string): SeedParse {
  if (text.trim() === '') return { ok: true, seed: null }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, message: 'the body is not JSON' }
  }
  if (!isRecord(body)) return { ok: false, message: 'the body must be a JSON object' }

  const files = body.files
  if (!isRecord(files)) {
    return { ok: false, message: '"files" must be an object of path → content' }
  }
  const entries = Object.entries(files)
  if (entries.length === 0) return { ok: false, message: '"files" names no file' }
  if (entries.length > MAX_SEED_FILES) {
    return { ok: false, message: `"files" names more than ${MAX_SEED_FILES} files` }
  }
  const paths = new Set<string>()
  for (const [name, content] of entries) {
    if (typeof content !== 'string') {
      return { ok: false, message: `the content of ${JSON.stringify(name)} must be a string` }
    }
    const why = badPath(name)
    if (why) return { ok: false, message: `${JSON.stringify(name)} ${why}` }
    paths.add(name)
  }
  // A file and a directory of the same name cannot both be in one tree.
  for (const name of paths) {
    const segments = name.split('/')
    for (let i = 1; i < segments.length; i++) {
      const parent = segments.slice(0, i).join('/')
      if (paths.has(parent)) {
        return { ok: false, message: `${JSON.stringify(parent)} is both a file and a directory` }
      }
    }
  }

  const message = body.message
  if (typeof message !== 'string' || message.trim() === '') {
    return { ok: false, message: '"message" must be a non-empty string' }
  }

  const author = body.author
  if (!isRecord(author)) return { ok: false, message: '"author" must be { name, email }' }
  const name = author.name
  const email = author.email
  if (!identPart(name)) {
    return {
      ok: false,
      message: '"author.name" must be a non-empty string without <, > or a newline',
    }
  }
  if (!identPart(email)) {
    return {
      ok: false,
      message: '"author.email" must be a non-empty string without <, > or a newline',
    }
  }

  const branch = body.branch ?? 'main'
  if (typeof branch !== 'string' || !branchNameOk(branch)) {
    return { ok: false, message: '"branch" must be a valid git branch name' }
  }

  return {
    ok: true,
    seed: { files: files as Record<string, string>, message, author: { name, email }, branch },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A git ident half: what `commit-tree` would otherwise strip or choke on. */
function identPart(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim() !== '' && !/[<>]/.test(value) && !hasControl(value)
  )
}

/**
 * Why git would refuse this path in a tree, or `null` when it would not.
 *
 * `.git` in any case is refused as git's own `verify_path` refuses it: a tree
 * entry by that name is how a clone gets its hooks overwritten.
 */
function badPath(name: string): string | null {
  if (name === '') return 'is empty'
  // Control characters, tabs among them, would end the `--index-info` line
  // this path is written on; git refuses NUL in a path anyway.
  if (hasControl(name)) return 'contains a control character'
  if (name.startsWith('/') || name.endsWith('/')) return 'must be relative, with no trailing slash'
  for (const segment of name.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      return 'has an empty, "." or ".." segment'
    }
    if (segment.toLowerCase() === '.git') return 'names a .git directory'
  }
  return null
}

/** A C0 control character or DEL — NUL, tab, CR and LF among them. */
function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function branchNameOk(branch: string): boolean {
  if (branch === '' || branch.startsWith('-')) return false
  return git(['check-ref-format', `refs/heads/${branch}`]).status === 0
}

// ── The operations ──────────────────────────────────────────────────────────

export type CreateResult =
  | { kind: 'created'; repo: string; commit?: string; ref?: string }
  /** The name already has an Index — a repository, or one being deleted. */
  | { kind: 'exists'; repo: string }
  /** The seed push was refused; nothing was left behind. */
  | { kind: 'refused'; repo: string; message: string }

/** What `src/http.ts` is given to answer the admin routes with. */
export interface AdminOps {
  create(repo: ResolvedRepo, seed: Seed | null): Promise<CreateResult>
  delete(repo: ResolvedRepo): Promise<DeleteResult>
  /** `null` when the log holds no Index for this name. */
  usage(repoId: string): Promise<RepoUsage | null>
}

export interface AdminDeps {
  store: ObjectStore
  ensureRepo: (repo: ResolvedRepo) => ResolvedRepo
  syncRepo: (repo: ResolvedRepo) => Promise<unknown>
  /** `WALGIT_DELETE_GRACE_MS`, read once by the caller. */
  graceMs: number
  now?: () => Date
}

export function createAdminOps(deps: AdminDeps): AdminOps {
  return {
    async create(repo, seed) {
      // The name is claimed by the Index, under an if-absent write: of two
      // creates racing for one name exactly one wins, and the other is the
      // same 409 a create of an existing repository gets. Nothing before this
      // line writes anything.
      const claimed = await commitIndex(deps.store, emptyIndex(repo.repoId), null)
      if (!claimed.ok) return { kind: 'exists', repo: repo.repoId }
      if (!seed) return { kind: 'created', repo: repo.repoId }

      try {
        const ensured = deps.ensureRepo(repo)
        await deps.syncRepo(ensured)
        const commit = pushSeed(ensured.dir, seed, (deps.now ?? (() => new Date()))())
        return { kind: 'created', repo: repo.repoId, commit, ref: `refs/heads/${seed.branch}` }
      } catch (err) {
        // A refused seed leaves no repository behind, so the caller can fix the
        // body and ask again instead of meeting its own 409. Only the Index
        // this request wrote is removed, and only while it is still empty —
        // anything a push has published since is somebody's work.
        const { index } = await loadIndex(deps.store, repo.repoId)
        if (index.entries.length === 0 && Object.keys(index.refs).length === 0) {
          await deps.store.delete(indexKey(repo.repoId))
          fs.rmSync(repo.dir, { recursive: true, force: true })
        }
        return { kind: 'refused', repo: repo.repoId, message: (err as Error).message }
      }
    },

    delete(repo) {
      // Not a dry run: an HTTP DELETE is the asking, as the scheduled sweep is.
      // The grace is the one `walgit delete` and expiry use, so the first call
      // tombstones and a call once it has elapsed collects.
      return deleteRepo(deps.store, repo.repoId, {
        dryRun: false,
        graceMs: deps.graceMs,
        dir: repo.dir,
        ...(deps.now ? { now: deps.now } : {}),
      })
    },

    async usage(repoId) {
      const { index, etag } = await loadIndex(deps.store, repoId)
      return etag === null ? null : usageOfIndex(index)
    },
  }
}

/**
 * Build the seed's one commit in a scratch repository and push it into `dir`.
 * Returns the commit id; throws with git's own words when the push is refused.
 *
 * The scratch repository is a separate object database on purpose: nothing is
 * written into the served repository except by `git-receive-pack`, so the
 * hooks see the commit arrive in quarantine exactly as a client's would.
 */
function pushSeed(dir: string, seed: Seed, now: Date): string {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-seed-'))
  try {
    const gitDir = path.join(scratch, 'seed.git')
    gitOrThrow(['init', '--bare', '--quiet'], { operands: [gitDir] })

    const lines: string[] = []
    for (const [name, content] of Object.entries(seed.files)) {
      const oid = gitOrThrow(['hash-object', '-w', '--stdin'], { gitDir, input: content })
      lines.push(`100644 blob ${oid.stdout.trim()}\t${name}`)
    }
    const indexEnv = { GIT_INDEX_FILE: path.join(scratch, 'index') }
    gitOrThrow(['update-index', '--index-info'], {
      gitDir,
      input: `${lines.join('\n')}\n`,
      env: indexEnv,
    })
    const tree = gitOrThrow(['write-tree'], { gitDir, env: indexEnv }).stdout.trim()

    // Author and committer are the one ident the request named: walgit did not
    // write this commit, the caller did, and the commit should say so.
    const date = `${Math.floor(now.getTime() / 1000)} +0000`
    const ident = {
      GIT_AUTHOR_NAME: seed.author.name,
      GIT_AUTHOR_EMAIL: seed.author.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: seed.author.name,
      GIT_COMMITTER_EMAIL: seed.author.email,
      GIT_COMMITTER_DATE: date,
    }
    const commit = gitOrThrow(['commit-tree', tree, '-F', '-'], {
      gitDir,
      input: seed.message.endsWith('\n') ? seed.message : `${seed.message}\n`,
      env: ident,
    }).stdout.trim()

    const pushed = git(
      ['push', '--quiet', '--porcelain', dir, `${commit}:refs/heads/${seed.branch}`],
      {
        gitDir,
      },
    )
    if (pushed.status !== 0) {
      throw new Error(
        `the seed push was refused: ${(pushed.stderr || pushed.stdout).trim().replaceAll(scratch, '<seed>')}`,
      )
    }
    return commit
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}
