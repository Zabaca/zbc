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
import { git, gitAsync, type GitOptions } from './git'
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
  // Control characters have no business in a scaffold's file names, and NUL
  // is the record separator the path is written to git with.
  if (hasControl(name)) return 'contains a control character'
  if (name.startsWith('/') || name.endsWith('/')) return 'must be relative, with no trailing slash'
  for (const segment of name.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      return 'has an empty, "." or ".." segment'
    }
    // `.git` as git's `verify_path` spells it on every platform a clone may
    // land on: any case, NTFS's trailing dots and spaces, and its 8.3 alias.
    const folded = segment.toLowerCase().replace(/[. ]+$/, '')
    if (folded === '.git' || folded === 'git~1') return 'names a .git directory'
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
  /**
   * The name already has an Index — a repository, or one being deleted, in
   * which case `collectAfter` is when the name frees up.
   */
  | { kind: 'exists'; repo: string; collectAfter?: string }
  /** The seed push was refused; nothing was left behind. */
  | { kind: 'refused'; repo: string; message: string }

/**
 * A seed git itself refused — the hooks turning the push down, or a tree that
 * would not hold the files asked for. The caller's to fix, so a 422; anything
 * else that goes wrong while seeding is walgit's, and is thrown as itself.
 */
export class SeedRefused extends Error {}

/** What `src/http.ts` is given to answer the admin routes with. */
export interface AdminOps {
  create(repo: ResolvedRepo, seed: Seed | null): Promise<CreateResult>
  delete(repo: ResolvedRepo): Promise<DeleteResult>
  /** `null` when the log holds no Index for this name. */
  usage(repoId: string): Promise<AdminUsage | null>
  /**
   * Revoke the repository's scoped tokens issued before `since` (default now)
   * by moving its `tokens_valid_since` forward. `null` when the log holds no
   * Index for this name.
   */
  revokeTokens(repoId: string, since: Date | null): Promise<RevokeResult | null>
}

/** The usage row, with what only the admin surface reports beside it. */
export type AdminUsage = RepoUsage & {
  /** The repository's tokens-valid-since instant, or `null` when none. */
  tokensValidSince: string | null
}

export interface RevokeResult {
  repo: string
  /**
   * The instant in force after this request. Never earlier than it was: an
   * older `since` than the one already stored leaves the stored one standing,
   * because moving it back would quietly make revoked tokens valid again.
   */
  tokensValidSince: string
}

export type RevokeParse = { ok: true; since: Date | null } | { ok: false; message: string }

/**
 * Read a revoke request's body: empty means now, and otherwise
 * `{"since": "<ISO instant>"}` no later than `now`.
 *
 * A future instant is refused rather than clamped: it would revoke tokens that
 * have not been minted yet, which is a different request from the one this
 * endpoint answers.
 */
export function parseRevoke(text: string, now: Date): RevokeParse {
  if (text.trim() === '') return { ok: true, since: null }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, message: 'the body is not JSON' }
  }
  if (!isRecord(body)) return { ok: false, message: 'the body must be a JSON object' }
  const since = body.since
  if (since === undefined) return { ok: true, since: null }
  if (typeof since !== 'string') {
    return { ok: false, message: '"since" must be an ISO 8601 instant' }
  }
  const ms = Date.parse(since)
  if (!Number.isFinite(ms)) return { ok: false, message: '"since" must be an ISO 8601 instant' }
  if (ms > now.getTime()) return { ok: false, message: '"since" must not be later than now' }
  return { ok: true, since: new Date(ms) }
}

export interface AdminDeps {
  store: ObjectStore
  ensureRepo: (repo: ResolvedRepo) => ResolvedRepo
  syncRepo: (repo: ResolvedRepo) => Promise<unknown>
  /** `WALGIT_DELETE_GRACE_MS`, read once by the caller. */
  graceMs: number
  /**
   * Tell the event fan-out a repository's tokens were revoked, so sockets
   * already open on one of them are closed rather than served until `exp`.
   * Absent where no event stream is configured; must never throw.
   */
  announceRevoked?: (repoId: string, since: string) => Promise<void>
  now?: () => Date
}

export function createAdminOps(deps: AdminDeps): AdminOps {
  const now = () => (deps.now ?? (() => new Date()))()
  return {
    async create(repo, seed) {
      // The name is claimed by the Index, under an if-absent write: of two
      // creates racing for one name exactly one wins, and the other is the
      // same 409 a create of an existing repository gets. Nothing before this
      // line writes anything. `created_at` is what expiry dates the
      // repository by until its first push.
      const claimed = await commitIndex(
        deps.store,
        { ...emptyIndex(repo.repoId), created_at: now().toISOString() },
        null,
      )
      if (!claimed.ok) {
        const { index } = await loadIndex(deps.store, repo.repoId)
        return {
          kind: 'exists',
          repo: repo.repoId,
          ...(index.deletion ? { collectAfter: index.deletion.collect_after } : {}),
        }
      }
      if (!seed) return { kind: 'created', repo: repo.repoId }

      try {
        const ensured = deps.ensureRepo(repo)
        await deps.syncRepo(ensured)
        const commit = await pushSeed(ensured.dir, seed, now())
        return { kind: 'created', repo: repo.repoId, commit, ref: `refs/heads/${seed.branch}` }
      } catch (err) {
        // A failed seed leaves no repository behind, so the caller can fix the
        // body (or wait out the outage) and ask again instead of meeting its
        // own 409. Only the Index this request wrote is removed, and only
        // while it is still the object this request wrote: a push that
        // published since changed its etag, and that is somebody's work.
        //
        // The store has no conditional delete, so a push landing between this
        // read and the delete is not excluded — a window of one round trip, on
        // a name created a moment ago by this very request. The cache
        // directory is left alone: it is disposable, holds nothing the hooks
        // published, and another request may be reading it.
        try {
          const current = await deps.store.get(indexKey(repo.repoId))
          if (current?.etag === claimed.etag) await deps.store.delete(indexKey(repo.repoId))
        } catch {
          // The rollback failing leaves an empty repository behind, which is
          // a 409 on retry and an ordinary delete away; the seed's own failure
          // is the thing to report.
        }
        if (err instanceof SeedRefused) {
          return { kind: 'refused', repo: repo.repoId, message: err.message }
        }
        throw err
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
      if (etag === null) return null
      return { ...usageOfIndex(index), tokensValidSince: index.tokens_valid_since ?? null }
    },

    async revokeTokens(repoId, since) {
      const asked = (since ?? now()).toISOString()
      // A compare-and-swap loop rather than `updateIndex`, because an absent
      // Index must stay absent: revoking a name nobody holds would claim it,
      // and creating is the create route's job. To revoke for a name a write
      // token could still create, create it first.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const { index, etag } = await loadIndex(deps.store, repoId)
        if (etag === null) return null
        const existing = index.tokens_valid_since
        const effective =
          existing !== undefined && Date.parse(existing) >= Date.parse(asked) ? existing : asked
        if (effective !== existing) {
          const written = await commitIndex(
            deps.store,
            { ...index, tokens_valid_since: effective },
            etag,
          )
          if (!written.ok) continue
        }
        if (deps.announceRevoked) await deps.announceRevoked(repoId, effective)
        return { repo: repoId, tokensValidSince: effective }
      }
      throw new Error('the Index is contended; try again')
    },
  }
}

/**
 * Build the seed's one commit in a scratch repository and push it into `dir`.
 * Returns the commit id; throws `SeedRefused` with git's own words when the
 * push is refused.
 *
 * The scratch repository is a separate object database on purpose: nothing is
 * written into the served repository except by `git-receive-pack`, so the
 * hooks see the commit arrive in quarantine exactly as a client's would.
 *
 * Every git call is asynchronous and the blobs are written by one process, not
 * one per file: this runs on the request path of the container that is also
 * serving every clone and push, and the push's hooks make network round trips.
 */
async function pushSeed(dir: string, seed: Seed, now: Date): Promise<string> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-seed-'))
  // No message leaving here names the scratch directory.
  const scrub = (text: string) => text.trim().replaceAll(scratch, '<seed>')
  const run = async (args: string[], opts: GitOptions = {}) => {
    const res = await gitAsync(args, opts)
    if (res.status !== 0) {
      throw new Error(`walgit seed: git ${args[0]} failed: ${scrub(res.stderr)}`)
    }
    return res.stdout
  }
  try {
    const gitDir = path.join(scratch, 'seed.git')
    await run(['init', '--bare', '--quiet'], { operands: [gitDir] })

    // The content goes to git through files named by index, so no requested
    // path is ever a file name here or an argument anywhere.
    const names = Object.keys(seed.files)
    const blobs = path.join(scratch, 'blobs')
    fs.mkdirSync(blobs)
    const blobPaths = names.map((name, i) => {
      const file = path.join(blobs, String(i))
      fs.writeFileSync(file, seed.files[name]!)
      return file
    })
    const oids = (
      await run(['hash-object', '-w', '--stdin-paths'], {
        gitDir,
        input: `${blobPaths.join('\n')}\n`,
      })
    )
      .trim()
      .split('\n')
    if (oids.length !== names.length)
      throw new Error('walgit seed: git hashed the wrong number of files')

    // NUL-terminated records: with `-z` git reads each path verbatim, with no
    // C-unquoting of a path that begins with a double quote.
    const indexEnv = { GIT_INDEX_FILE: path.join(scratch, 'index') }
    await run(['update-index', '-z', '--index-info'], {
      gitDir,
      input: names.map((name, i) => `100644 blob ${oids[i]}\t${name}\0`).join(''),
      env: indexEnv,
    })
    const tree = (await run(['write-tree'], { gitDir, env: indexEnv })).trim()

    // `update-index` IGNORES a path it will not carry — a name only some
    // filesystem treats as `.git` — and still exits 0. So the tree is read
    // back, and a seed whose tree is not exactly the files asked for is
    // refused rather than committed short.
    const listed = (await run(['ls-tree', '-r', '-z', '--name-only', tree], { gitDir }))
      .split('\0')
      .filter(Boolean)
    const missing = names.filter((name) => !listed.includes(name))
    if (missing.length > 0 || listed.length !== names.length) {
      throw new SeedRefused(
        `git would not carry ${missing.length > 0 ? missing.map((name) => JSON.stringify(name)).join(', ') : 'these paths as named'} in a tree`,
      )
    }

    // Author and committer are the one ident the request named: walgit did not
    // write this commit, the caller did, and the commit should say so.
    const date = `${Math.floor(now.getTime() / 1000)} +0000`
    const commit = (
      await run(['commit-tree', tree, '-F', '-'], {
        gitDir,
        input: seed.message.endsWith('\n') ? seed.message : `${seed.message}\n`,
        env: {
          GIT_AUTHOR_NAME: seed.author.name,
          GIT_AUTHOR_EMAIL: seed.author.email,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_NAME: seed.author.name,
          GIT_COMMITTER_EMAIL: seed.author.email,
          GIT_COMMITTER_DATE: date,
        },
      })
    ).trim()

    const pushed = await gitAsync(
      ['push', '--quiet', '--porcelain', dir, `${commit}:refs/heads/${seed.branch}`],
      { gitDir },
    )
    if (pushed.status !== 0) {
      throw new SeedRefused(`the seed push was refused: ${scrub(pushed.stderr || pushed.stdout)}`)
    }
    return commit
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}
