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

export type ResolvedRepo = { repoId: string; dir: string }

/**
 * A repo id is one flat segment. Flat because the WAL keys repositories by id
 * (docs/adr/0007), not by a directory tree, and a hierarchy on disk that the
 * log cannot express would drift the moment a repo is rebuilt from the log.
 */
const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function resolveRepo(reposDir: string, requested: string): ResolvedRepo {
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
  run('git', ['--git-dir', repo.dir, 'config', 'receive.unpackLimit', '0'])
  // The hooks ARE the push path. Re-installed on every access for the same
  // reason as the config above: a repo that arrived here by any other route
  // would otherwise accept pushes that never reach the write-ahead log.
  installHooks(repo.dir, repo.repoId)
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
