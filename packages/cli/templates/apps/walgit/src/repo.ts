/**
 * The repo-addressing seam.
 *
 * SSH has no SNI: one front door serves every repository, and the repository is
 * named in the client's own command (`git@host:<repo_id>.git`) or in the
 * smart-HTTP URL path. That makes the repo name attacker-controlled on every
 * entry point, so exactly one function turns it into a path — this one — and
 * both entry points funnel through it.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { installHooks } from './hooks'
import { sweepPending } from './push'

export type ResolvedRepo = { repoId: string; dir: string }

/**
 * A repo id is one flat segment. Flat because the WAL keys repositories by id
 * (docs/adr/0007), not by a directory tree, and a hierarchy on disk that the
 * log cannot express would drift the moment a repo is rebuilt from the log.
 */
const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * The repo id a request names, validated. Split out from `resolveRepo` because
 * the operator CLI materializes into a path the operator chose rather than into
 * `reposDir` — the id still has to pass the same gate, and there must not be a
 * second copy of it to drift.
 */
export function normalizeRepoId(requested: string): string {
  // Strip the address forms a client can send: ssh://host/alpha.git yields a
  // leading slash, and OpenSSH passes `~/alpha.git` through unexpanded.
  const repoId = requested
    .replace(/^~\//, '')
    .replace(/^\//, '')
    .replace(/\.git$/, '')
  // A trailing newline is not a formality: JavaScript's `$` matches before one,
  // so `alpha\n` would otherwise pass validation and reach a shell-free but
  // still surprising path.
  if (/[\r\n]/.test(repoId) || !REPO_ID.test(repoId)) {
    throw new Error(`invalid repository name: ${JSON.stringify(requested)}`)
  }
  return repoId
}

export function resolveRepo(reposDir: string, requested: string): ResolvedRepo {
  const repoId = normalizeRepoId(requested)
  return { repoId, dir: path.join(reposDir, `${repoId}.git`) }
}

/**
 * Create the bare repo if it is missing, and return it either way.
 *
 * Auto-creation on first contact is deliberate: a walgit repository has no
 * lifecycle of its own on this machine — the disk is a cache, and a push to a
 * name nobody has used yet is how a repo comes into existence.
 *
 * "Empty" is the right starting point even for a repo the log already knows
 * about: `syncRepo` runs on every access, and an empty repo is one whose refs
 * are all missing, which is precisely the signal that materializes it. Creating
 * and restoring are therefore the same code path with different amounts of log.
 */
/**
 * Set one git config key, but only when it does not already hold that value.
 *
 * The read is not an optimisation. `git config <key> <value>` takes an
 * exclusive `config.lock`, and git does NOT retry when it cannot: it prints
 * `could not lock config file …: File exists` and exits non-zero. Two
 * processes calling `ensureBareRepo` at the same moment is not exotic here —
 * it is the normal case, because compaction materializes (materialize.ts calls
 * ensureBareRepo) in a detached process while the front door is still serving
 * pushes into the same repository. The loser's throw reaches
 * `createHttpHandler`, which cannot tell a repo that failed to open from one
 * that does not exist and answers `404 not found`, so a healthy push dies with
 * `fatal: repository '…' not found`.
 *
 * Reading first makes the steady state lock-free: after the first call these
 * three keys already hold their values and nothing is written at all. When a
 * write is genuinely needed and loses the race, the value the winner wrote is
 * the value this call wanted — identical arguments from identical code — so a
 * re-read that finds it is success, not a papered-over error. Anything else
 * still throws.
 */
function ensureConfig(gitDir: string, key: string, value: string): void {
  if (readConfig(gitDir, key) === value) return
  const res = spawnSync('git', ['--git-dir', gitDir, 'config', key, value], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  if (res.status === 0) return
  if (readConfig(gitDir, key) === value) return
  throw new Error(`git config ${key} ${value} failed: ${res.stderr?.toString().trim()}`)
}

/** The configured value, or undefined when the key is unset. */
function readConfig(gitDir: string, key: string): string | undefined {
  const res = spawnSync('git', ['--git-dir', gitDir, 'config', '--get', key], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return res.status === 0 ? res.stdout.toString().trim() : undefined
}

export function ensureBareRepo(repo: ResolvedRepo): ResolvedRepo {
  if (!fs.existsSync(path.join(repo.dir, 'HEAD'))) {
    fs.mkdirSync(repo.dir, { recursive: true })
    // `main` as the default HEAD, because HEAD on a bare repo is what a clone
    // checks out: created as `master` and pushed to as `main`, a clone succeeds
    // and leaves an empty working tree, which reads as data loss.
    run('git', ['init', '--bare', '--quiet', '--initial-branch=main', repo.dir])
  }
  // Re-applied on every call, not just at creation: `receive.unpackLimit=0`
  // is what makes a small push arrive as a packfile rather than exploding into
  // loose objects, and there is no packfile to upload if it does.
  ensureConfig(repo.dir, 'receive.unpackLimit', '0')
  // git's own housekeeping is turned OFF, and that is not a performance
  // choice. `receive.autogc` runs `git gc --auto` after a push, which on a repo
  // holding one pack per WAL entry fires almost immediately (gc.autoPackLimit
  // is 50) and does two things walgit cannot allow:
  //
  //   - It repacks concurrently with `compact`, whose `git repack -adf` expects
  //     to be the only writer. gc leaves a main pack AND a cruft pack for the
  //     unreachable objects, so compaction finds two and refuses to publish
  //     rather than risk a partial one.
  //   - It renames what it repacks. `materialize` decides "do I already have
  //     this entry?" from the pack's filename, derived from the WAL key, so a
  //     repo gc has touched re-downloads the entire log on next access.
  //
  // Packing on this disk belongs to compaction, which publishes the result to
  // the log. A cache that repacks itself behind the log's back is a cache that
  // disagrees with it.
  ensureConfig(repo.dir, 'receive.autogc', 'false')
  ensureConfig(repo.dir, 'gc.auto', '0')
  // The hooks ARE the push path. Re-installed on every access for the same
  // reason as the config above: a repo that arrived here by any other route
  // would otherwise accept pushes that never reach the write-ahead log.
  installHooks(repo.dir, repo.repoId)
  // A `git-receive-pack` killed between its hooks leaves a hand-off record
  // behind. Keyed by pid, it is unreadable by any other push — but it should
  // not accumulate either, and a recycled pid must never resurrect it.
  sweepPending(repo.dir)
  return repo
}

function run(cmd: string, args: string[]): void {
  const res = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${res.stderr?.toString().trim()}`)
  }
}

export type GitService = 'git-upload-pack' | 'git-receive-pack'
export type SshRequest = { service: GitService; requested: string }

/**
 * Parse `SSH_ORIGINAL_COMMAND` under the forced command.
 *
 * This is the whole of the SSH attack surface: the key's `command=` option
 * means the client's command line is never executed, only read here, so the
 * grammar is a strict allow-list of the two transport verbs and one
 * single-quoted argument. `git-upload-archive` is excluded on purpose — it is
 * a third verb clients rarely need and one more code path to reason about.
 */
export function parseSshCommand(original: string | undefined): SshRequest {
  const match = /^git[- ](upload-pack|receive-pack) '([^']*)'$/.exec(original ?? '')
  if (!match) {
    throw new Error(`refused: only git-upload-pack and git-receive-pack are permitted`)
  }
  return { service: `git-${match[1]}` as GitService, requested: match[2]! }
}
