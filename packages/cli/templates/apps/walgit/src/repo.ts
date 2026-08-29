/**
 * The repo-addressing seam.
 *
 * SSH has no SNI: one front door serves every repository, and the repository is
 * named in the client's own command (`git@host:<repo_id>.git`) or in the
 * smart-HTTP URL path. That makes the repo name attacker-controlled on every
 * entry point, so exactly one function turns it into a path — this one — and
 * both entry points funnel through it.
 *
 * Nothing here touches the disk or the log: it is string in, path out, and it
 * imports nothing. Provisioning the bare repo that path names is `cache.ts`.
 */

import * as path from 'node:path'

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
