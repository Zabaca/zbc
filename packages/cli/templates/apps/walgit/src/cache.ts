/**
 * The disk cache: bringing a bare repo into existence on this machine.
 *
 * ADR-0007's sentence is that object storage holds the write-ahead log and is
 * the source of truth, and the bare repo on local disk is a disposable cache.
 * This is the file that provisions that cache — `git init --bare`, the three
 * config keys walgit cannot run without, the hooks that ARE the push path, and
 * a sweep of hand-off records left by a `git-receive-pack` that died.
 *
 * It is separate from `repo.ts` because that file answers a different question.
 * `repo.ts` turns an attacker-controlled name into a path and does nothing
 * else; it has no imports and touches no disk. Everything that writes to the
 * disk is here. Keeping them together meant `http.ts`, which wants only
 * `resolveRepo`, transitively depended on the hooks, the object store and the
 * write-ahead log.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { appendOnlyEnabled } from './append-only'
import { limitsFromEnv } from './limits'
import { git, gitOrThrow } from './git'
import { installHooks } from './hooks'
import { sweepPending } from './pending'
import type { ResolvedRepo } from './repo'

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
  const res = git(['--git-dir', gitDir, 'config', key, value])
  if (res.status === 0) return
  if (readConfig(gitDir, key) === value) return
  throw new Error(`git config ${key} ${value} failed: ${res.stderr.trim()}`)
}

/** Remove a config key, if it is set. Losing the lock race is not fatal here. */
function clearConfig(gitDir: string, key: string): void {
  if (readConfig(gitDir, key) === undefined) return
  git(['--git-dir', gitDir, 'config', '--unset', key])
}

/** The configured value, or undefined when the key is unset. */
function readConfig(gitDir: string, key: string): string | undefined {
  const res = git(['--git-dir', gitDir, 'config', '--get', key])
  return res.status === 0 ? res.stdout.trim() : undefined
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
export function ensureBareRepo(repo: ResolvedRepo): ResolvedRepo {
  if (!fs.existsSync(path.join(repo.dir, 'HEAD'))) {
    fs.mkdirSync(repo.dir, { recursive: true })
    // `main` as the default HEAD, because HEAD on a bare repo is what a clone
    // checks out: created as `master` and pushed to as `main`, a clone succeeds
    // and leaves an empty working tree, which reads as data loss.
    gitOrThrow(['init', '--bare', '--quiet', '--initial-branch=main', repo.dir])
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
  // The backstop under `pre-receive`'s append-only check. git enforces these
  // AFTER the hook, so they never produce the message a client reads in
  // practice — they are here so a bug in the hook cannot cost anyone history.
  // Written on every access rather than at creation, because the instance can
  // turn the flag on over repositories that already exist.
  if (appendOnlyEnabled()) {
    ensureConfig(repo.dir, 'receive.denyNonFastForwards', 'true')
    ensureConfig(repo.dir, 'receive.denyDeletes', 'true')
  }
  // The backstop under `pre-receive`'s size check — but deliberately NOT set to
  // the cap itself. git hands `receive.maxInputSize` to `index-pack`, which
  // fails while the pack is still being read, i.e. BEFORE `pre-receive` runs:
  // set to the cap, it would win every race and every client would read
  // `fatal: pack exceeds maximum allowed size` instead of the message
  // src/limits.ts exists to write. So it is set with headroom: the hook owns
  // every refusal a real client can provoke, and this only bounds a pack so far
  // past the cap that a bug in the hook is the likelier explanation.
  // Cleared when the cap is, because a stale limit on a repository whose
  // instance no longer sets one would refuse pushes nothing documents.
  const { maxPushBytes } = limitsFromEnv()
  if (maxPushBytes === null) {
    clearConfig(repo.dir, 'receive.maxInputSize')
  } else {
    ensureConfig(repo.dir, 'receive.maxInputSize', String(Math.floor(maxPushBytes) * 2))
  }
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
