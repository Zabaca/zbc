/**
 * The repo-addressing seam.
 *
 * The repository a request means is named in the smart-HTTP URL path, so the
 * repo name is attacker-controlled on the way in. Exactly one function turns it
 * into a path — this one — and every entry point funnels through it.
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
  // Strip the address forms a client can send: a URL path yields a leading
  // slash, and `.git` is a suffix the client chooses, not part of the id.
  const repoId = requested.replace(/^\//, '').replace(/\.git$/, '')
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
