/**
 * Size limits: refuse an oversized push in the first second, not the fortieth.
 *
 * Without this, the edge is the only thing enforcing a size, and the edge
 * enforces it in the worst possible way. `http.postBuffer` defaults to 1 MiB,
 * so every real push is chunked — and a chunked body is uploaded IN FULL before
 * the proxy answers. Measured against Fly: with `Content-Length` the edge 413s
 * at 101 MiB after ~2 MB in 1.4 s, but chunked, 99 MiB passes and 100 MiB is
 * refused only AFTER all 104,879,625 bytes have gone up — 37 s of upload to
 * learn the answer, reported as `RPC failed; HTTP 413` and `unexpected
 * disconnect`. That reads like a dropped network, so an agent retries it.
 *
 * So walgit enforces its own caps, and it does so in `pre-receive`: the pack is
 * sitting in the quarantine, its size is known exactly, and nothing has been
 * written to the object store yet. The refusal therefore costs one local stat
 * and one index read, and leaves no orphan behind for `findOrphans` to reclaim.
 *
 * Two caps, because they fail differently. A single huge push is one client
 * sending too much at once; a repository creeping over its total is many small
 * pushes that were each individually fine. Telling an agent "your push is too
 * big" when the push was 2 MiB would send it looking in the wrong place, so the
 * two messages say different things.
 *
 * Both are UNSET by default. A cap this file does not enforce is one `GET /`
 * must not claim, which is why `instructions.ts` renders from the same env vars
 * read here rather than from a copy of them.
 */

import type { WalIndex } from './wal-index'

export interface Limits {
  /** Largest single push, in bytes. `null` means unlimited. */
  maxPushBytes: number | null
  /** Largest live size of one repository, in bytes. `null` means unlimited. */
  maxRepoBytes: number | null
}

export const NO_LIMITS: Limits = { maxPushBytes: null, maxRepoBytes: null }

/**
 * The caps this instance enforces.
 *
 * An unparseable or non-positive value reads as unset rather than as zero. Zero
 * would refuse every push, and a typo in a deployment env var must not silently
 * become "this host accepts nothing".
 */
export function limitsFromEnv(env: Record<string, string | undefined> = process.env): Limits {
  return {
    maxPushBytes: positiveNumber(env.WALGIT_MAX_PUSH_BYTES),
    maxRepoBytes: positiveNumber(env.WALGIT_MAX_REPO_BYTES),
  }
}

function positiveNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Is there anything to check? Nothing is read from the store when there isn't. */
export function limitsEnforced(limits: Limits): boolean {
  return limits.maxPushBytes !== null || limits.maxRepoBytes !== null
}

/**
 * What this repository costs right now, in bytes.
 *
 * Entries at or below the compaction frontier are superseded: their objects are
 * tombstoned and `gc.ts` deletes them a grace period later, so counting them
 * would charge a repository twice for history it holds once — and would make a
 * repository that compacted itself look like it had grown. This is the same set
 * `pendingEntries` (compact.ts) names for restore, for the same reason: it is
 * what the log actually still holds, and the same number `usage.ts` reports as
 * a repository's `liveBytes` — a cap and a usage report that disagreed would be
 * unexplainable to whoever hit it. The filter is repeated rather than
 * imported so this file stays dependency-free — `instructions.ts` shares its
 * byte formatting, and dragging git and the materializer into the HTTP server
 * to do it would be a poor trade.
 */
export function liveBytes(index: WalIndex): number {
  return index.entries
    .filter((entry) => entry.seq > index.compaction_frontier)
    .reduce((total, entry) => total + entry.size, 0)
}

export type SizeVerdict = { ok: true } | { ok: false; kind: 'push' | 'repo'; message: string }

export interface SizeCheck {
  repoId: string
  /** Bytes this push would add: the quarantine packfile's size. */
  pushBytes: number
  /** Bytes the repository already holds live — see `liveBytes`. */
  repoBytes: number
  limits: Limits
}

/**
 * Judge a push against both caps.
 *
 * Per-push is checked first. When a single push exceeds both caps at once, the
 * per-push message is the actionable one: splitting the push is something the
 * client can do, whereas "this repository is full" would send it to a new name
 * for a push that would be refused there too.
 */
export function checkSize(check: SizeCheck): SizeVerdict {
  const { maxPushBytes, maxRepoBytes } = check.limits

  if (maxPushBytes !== null && check.pushBytes > maxPushBytes) {
    return { ok: false, kind: 'push', message: pushTooLarge(check, maxPushBytes) }
  }
  if (maxRepoBytes !== null && check.repoBytes + check.pushBytes > maxRepoBytes) {
    return { ok: false, kind: 'repo', message: repoTooLarge(check, maxRepoBytes) }
  }
  return { ok: true }
}

/**
 * Product copy, not a debug string. `unexpected disconnect` is what this
 * replaces: a message that reads like a transport fault gets retried, and the
 * retry costs the same forty seconds. So the message states a number the client
 * can compare its own pack against, and one concrete thing to do next.
 */
function pushTooLarge(check: SizeCheck, cap: number): string {
  return [
    `walgit: refused — this push is larger than ${describeBytes(cap)}.`,
    '',
    `You sent ${describeBytes(check.pushBytes)}; the limit for a single push is ${describeBytes(cap)}.`,
    'This is a walgit limit, not a network failure. Retrying the same push will',
    'be refused again in the same way.',
    '',
    'What you can do instead:',
    '  - push your history in stages:  git push origin <an-older-commit>:refs/heads/main',
    '    then push the rest, so no single push carries everything at once',
    '  - or leave large files out of the repository entirely — walgit stores git',
    '    objects, and a binary blob costs the same on every clone forever',
    '',
    'Nothing was uploaded; the repository is unchanged.',
  ].join('\n')
}

function repoTooLarge(check: SizeCheck, cap: number): string {
  const total = check.repoBytes + check.pushBytes
  return [
    `walgit: refused — ${check.repoId} would exceed its ${describeBytes(cap)} total.`,
    '',
    `The repository already holds ${describeBytes(check.repoBytes)} and this push adds`,
    `${describeBytes(check.pushBytes)}, for ${describeBytes(total)}.`,
    'The push itself is within the per-push limit — it is the repository that is full.',
    'This is a walgit limit, not a network failure.',
    '',
    'What you can do instead:',
    '  - start a fresh repository: git remote set-url origin <same-host>/<new-name>.git',
    '',
    'Nothing was uploaded; the repository is unchanged.',
  ].join('\n')
}

/**
 * Both a unit and the raw byte count, so an agent comparing its own pack size
 * against this number never has to guess our rounding. `GET /` prints the caps
 * through this same function: an agent reads the limit there and the refusal
 * here, and two roundings would look like two different limits.
 */
export function describeBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3
  const mib = bytes / 1024 ** 2
  if (gib >= 1) return `${round(gib)} GiB (${bytes} bytes)`
  if (mib >= 1) return `${round(mib)} MiB (${bytes} bytes)`
  return `${bytes} bytes`
}

const round = (n: number) => String(Math.round(n * 100) / 100)
