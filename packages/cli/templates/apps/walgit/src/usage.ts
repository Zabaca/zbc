/**
 * What is this service holding?
 *
 * The write-ahead log is already a usage ledger. Every entry carries a `size`
 * and a `ts`, and `index.json` carries the whole entry list, so repository
 * count, bytes stored, the largest repositories and push volume over time are
 * all derivable from the store with no instrumentation, no counters to keep in
 * sync and nothing that can drift from the thing it claims to measure. A metric
 * emitted at push time would be a second record of the same fact, and the two
 * would disagree the first time a push failed between them.
 *
 * Read-only, and it matters more here than anywhere else: this is the command
 * an operator runs while worried about the bill or about abuse, which is
 * exactly the moment a command that also repairs things is dangerous. Nothing
 * in this file calls `put` or `delete` — `usage.test.ts` asserts that against a
 * store that throws if either is reached.
 *
 * What it deliberately does NOT report is reads. The log records pushes; a
 * clone leaves no trace in it at all, and an approximation invented here would
 * read as a measurement. That gap is a separate ticket and belongs beside the
 * request path, not here.
 */

import { indexKey, listRepoIds } from './keys'
import type { ObjectStore } from './store'
import type { WalEntry, WalIndex } from './wal-index'

export interface RepoUsage {
  repoId: string
  /**
   * Every entry `index.json` still names. This is what the bucket is billed
   * for under this repository, superseded-but-not-yet-collected entries
   * included — because it still holds them.
   */
  bytes: number
  /**
   * Entries above the compaction frontier: what a restore actually downloads.
   * A large gap between this and `bytes` is a repository waiting on `walgit gc`,
   * not a repository that is genuinely large.
   */
  liveBytes: number
  entries: number
  seq: number
  refs: number
  pushes: number
  /** Bytes pushed, ever — growth, as distinct from what is currently stored. */
  pushBytes: number
  firstPush: string | null
  lastPush: string | null
  /** Pushes and bytes inside the requested window; zero when none was asked for. */
  pushesInWindow: number
  bytesInWindow: number
  /**
   * The repository is scheduled for deletion but still inside its grace period.
   * Its bytes are counted, because the bucket still holds them — but an
   * operator reading a total needs to know which part of it is already leaving.
   */
  deletionPending: boolean
}

/** One slice of the window, for push volume over time. */
export interface UsageBucket {
  /** Inclusive ISO instant this slice starts at. */
  start: string
  pushes: number
  bytes: number
}

/** A `repos/<id>/` prefix whose index could not be read. Named, never silent. */
export interface UnreadableRepo {
  repoId: string
  reason: string
}

export interface UsageWindow {
  since: string
  until: string
  hours: number
  /** Width of each bucket in `buckets`, in hours. */
  bucketHours: number
}

export interface UsageReport {
  generatedAt: string
  window: UsageWindow | null
  /** Repositories the store holds an index for. */
  repos: number
  bytes: number
  /** Bytes belonging to repositories already scheduled for deletion. */
  bytesPendingDeletion: number
  liveBytes: number
  entries: number
  pushes: number
  pushesInWindow: number
  bytesInWindow: number
  /** Sorted by `bytes` descending, truncated to the requested `top`. */
  largest: RepoUsage[]
  buckets: UsageBucket[]
  unreadable: UnreadableRepo[]
}

export interface UsageOptions {
  /** How far back the window reaches. Omit for lifetime totals and no buckets. */
  sinceMs?: number
  /** How many repositories to name. 0 means all of them. Default 10. */
  top?: number
  /** Injected so tests can fix the window. */
  now?: () => Date
  /** How many indexes to read at once. */
  concurrency?: number
}

// ── Enumerating repositories ────────────────────────────────────────────────

/**
 * The repository ids the store holds.
 *
 * `listPrefixes` is the cheap path — one delimited LIST names every repository
 * without naming a single packfile. Stores that do not implement it (the
 * in-memory and filesystem ones) fall back to deriving the ids from a full
 * listing, which is fine at their scale and wrong at a bucket's.
 */
// ── Folding one index ───────────────────────────────────────────────────────

function isInWindow(entry: WalEntry, since: number, until: number): boolean {
  const at = Date.parse(entry.ts)
  // An unparseable timestamp is counted in the lifetime totals (its bytes are
  // real) but never in a window: guessing which slice it belongs to would put
  // a fabricated bar on the chart.
  return Number.isFinite(at) && at >= since && at <= until
}

/**
 * Fold one repository's index into its usage row. Pure — no I/O.
 *
 * `onWindowedPush` is how the caller builds the time series without the fold
 * having to keep every entry alive: each in-window push is offered once, and
 * the report's buckets are the only thing that wants them.
 */
export function usageOfIndex(
  index: WalIndex,
  window?: { since: number; until: number },
  onWindowedPush?: (entry: WalEntry) => void,
): RepoUsage {
  const row: RepoUsage = {
    repoId: index.repo_id,
    bytes: 0,
    liveBytes: 0,
    entries: index.entries.length,
    seq: index.seq,
    refs: Object.keys(index.refs).length,
    pushes: 0,
    pushBytes: 0,
    firstPush: null,
    lastPush: null,
    pushesInWindow: 0,
    bytesInWindow: 0,
    deletionPending: index.deletion !== undefined,
  }

  for (const entry of index.entries) {
    row.bytes += entry.size
    if (entry.seq > index.compaction_frontier) row.liveBytes += entry.size
    // Compaction entries are storage, not traffic: counting a repack as a push
    // would make a quiet repository look busy on the day it was compacted.
    if (entry.kind !== 'push') continue
    row.pushes += 1
    row.pushBytes += entry.size
    if (row.firstPush === null || entry.ts < row.firstPush) row.firstPush = entry.ts
    if (row.lastPush === null || entry.ts > row.lastPush) row.lastPush = entry.ts
    if (window && isInWindow(entry, window.since, window.until)) {
      row.pushesInWindow += 1
      row.bytesInWindow += entry.size
      onWindowedPush?.(entry)
    }
  }
  return row
}

// ── The report ──────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000

/**
 * Bucket width, chosen from the window rather than configured: a day of pushes
 * is legible by the hour and a quarter of them is not, and an operator should
 * not have to pick.
 */
function bucketHoursFor(windowHours: number): number {
  if (windowHours <= 48) return 1
  if (windowHours <= 24 * 14) return 24
  return 24 * 7
}

/** Run `task` over `items` with a bounded number in flight. */
async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await task(items[i]!)
  })
  await Promise.all(workers)
  return results
}

export async function collectUsage(
  store: ObjectStore,
  options: UsageOptions = {},
): Promise<UsageReport> {
  const now = (options.now ?? (() => new Date()))()
  const until = now.getTime()
  const window = options.sinceMs === undefined ? null : { since: until - options.sinceMs, until }

  // Buckets are laid out before anything is read, so the fold can drop each
  // in-window push straight into its slice. Anchored at the window's END, so
  // the last bucket is the hour the operator is standing in rather than an
  // arbitrary one starting whenever the window happened to begin.
  const bucketHours = window ? bucketHoursFor((options.sinceMs ?? 0) / HOUR_MS) : 0
  const bucketMs = bucketHours * HOUR_MS
  const buckets: UsageBucket[] = []
  if (window) {
    const count = Math.max(1, Math.ceil((window.until - window.since) / bucketMs))
    for (let i = count; i >= 1; i -= 1) {
      buckets.push({
        start: new Date(window.until - i * bucketMs).toISOString(),
        pushes: 0,
        bytes: 0,
      })
    }
  }
  const firstBucketAt = buckets.length > 0 ? Date.parse(buckets[0]!.start) : 0
  const record = (entry: WalEntry): void => {
    const slot = Math.floor((Date.parse(entry.ts) - firstBucketAt) / bucketMs)
    const bucket = buckets[Math.min(Math.max(slot, 0), buckets.length - 1)]
    if (!bucket) return
    bucket.pushes += 1
    bucket.bytes += entry.size
  }

  const repoIds = await listRepoIds(store)
  const read = await pooled(repoIds, options.concurrency ?? 8, async (repoId) => {
    try {
      const found = await store.get(indexKey(repoId))
      if (!found) return { repoId, reason: 'no index.json' } as UnreadableRepo
      const index = JSON.parse(new TextDecoder().decode(found.body)) as WalIndex
      // The id in the key is the one the operator sees; an index that disagrees
      // is a routing fault, and reporting it under either name would hide that.
      if (index.repo_id !== repoId) {
        return { repoId, reason: `index declares repo_id "${index.repo_id}"` } as UnreadableRepo
      }
      return usageOfIndex(index, window ?? undefined, window ? record : undefined)
    } catch (error) {
      return {
        repoId,
        reason: error instanceof Error ? error.message : String(error),
      } as UnreadableRepo
    }
  })

  const rows: RepoUsage[] = []
  const unreadable: UnreadableRepo[] = []
  for (const item of read) {
    if ('reason' in item) unreadable.push(item)
    else rows.push(item)
  }

  const report: UsageReport = {
    generatedAt: now.toISOString(),
    window: window
      ? {
          since: new Date(window.since).toISOString(),
          until: new Date(window.until).toISOString(),
          hours: options.sinceMs! / HOUR_MS,
          bucketHours,
        }
      : null,
    repos: rows.length,
    bytes: rows.reduce((n, r) => n + r.bytes, 0),
    bytesPendingDeletion: rows.reduce((n, r) => n + (r.deletionPending ? r.bytes : 0), 0),
    liveBytes: rows.reduce((n, r) => n + r.liveBytes, 0),
    entries: rows.reduce((n, r) => n + r.entries, 0),
    pushes: rows.reduce((n, r) => n + r.pushes, 0),
    pushesInWindow: rows.reduce((n, r) => n + r.pushesInWindow, 0),
    bytesInWindow: rows.reduce((n, r) => n + r.bytesInWindow, 0),
    largest: [...rows].sort(byBytesThenId),
    buckets,
    unreadable,
  }
  const top = options.top ?? 10
  if (top > 0) report.largest = report.largest.slice(0, top)
  return report
}

/** Bytes descending, id ascending — so equal-sized repos have a stable order. */
function byBytesThenId(a: RepoUsage, b: RepoUsage): number {
  return b.bytes - a.bytes || a.repoId.localeCompare(b.repoId)
}

// ── Formatting ──────────────────────────────────────────────────────────────

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const

/** Binary units, because that is what a bucket console reports. */
export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`
}

/**
 * `30m`, `24h`, `7d`, `2w` — and a bare number is hours.
 *
 * Deliberately not a date: an operator asking "what happened lately?" thinks in
 * durations, and a window relative to now is the only one that stays correct
 * between two runs of the command.
 */
export function parseDuration(input: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([mhdw]?)$/.exec(input.trim())
  if (!match) throw new Error(`not a duration: ${JSON.stringify(input)} (try 24h, 7d, 30m)`)
  const scale = { m: 60_000, h: HOUR_MS, d: 24 * HOUR_MS, w: 7 * 24 * HOUR_MS }
  return Number(match[1]) * scale[(match[2] || 'h') as 'm' | 'h' | 'd' | 'w']
}

/** A bar scaled to the busiest bucket, so the shape is readable without a scale. */
function bar(value: number, max: number, width = 24): string {
  if (max <= 0) return ''
  return '#'.repeat(Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width)))
}

export function formatUsage(report: UsageReport): string {
  const lines: string[] = []
  lines.push(
    `${report.repos} ${report.repos === 1 ? 'repository' : 'repositories'}, ` +
      `${formatBytes(report.bytes)} stored, ${report.entries} WAL entries, ` +
      `${report.pushes} pushes`,
  )
  // Worth naming only when it is not the same number: the difference is
  // storage being paid for that no restore reads.
  if (report.liveBytes !== report.bytes) {
    lines.push(
      `  ${formatBytes(report.liveBytes)} live — ${formatBytes(report.bytes - report.liveBytes)} ` +
        'superseded, awaiting `walgit gc`',
    )
  }

  if (report.bytesPendingDeletion > 0) {
    lines.push(
      `  ${formatBytes(report.bytesPendingDeletion)} belongs to repositories scheduled for deletion`,
    )
  }

  if (report.largest.length > 0) {
    lines.push('', 'Largest repositories')
    const width = Math.max(...report.largest.map((r) => r.repoId.length))
    for (const row of report.largest) {
      lines.push(
        `  ${row.repoId.padEnd(width)}  ${formatBytes(row.bytes).padStart(9)}  ` +
          `${String(row.pushes).padStart(5)} ${row.pushes === 1 ? 'push ' : 'pushes'}  ` +
          `${row.refs} ${row.refs === 1 ? 'ref ' : 'refs'}  ` +
          `last push ${row.lastPush ?? 'never'}${row.deletionPending ? '  (deleting)' : ''}`,
      )
    }
  }

  if (report.window) {
    const w = report.window
    lines.push(
      '',
      `Pushes in the last ${w.hours}h: ${report.pushesInWindow} ` +
        `(${formatBytes(report.bytesInWindow)}), by ${w.bucketHours}h`,
    )
    const max = Math.max(0, ...report.buckets.map((b) => b.pushes))
    for (const bucket of report.buckets) {
      lines.push(
        `  ${bucket.start.slice(0, 16).replace('T', ' ')}  ` +
          `${String(bucket.pushes).padStart(4)}  ${bar(bucket.pushes, max)}`.trimEnd(),
      )
    }
    if (max === 0) lines.push('  (no pushes in this window)')
  }

  // Named, not counted: a prefix without a readable index is either an orphan
  // left by a rejected first push or a routing fault, and both need the name.
  if (report.unreadable.length > 0) {
    lines.push('', 'Not counted')
    for (const skipped of report.unreadable) {
      lines.push(`  ${skipped.repoId}: ${skipped.reason}`)
    }
  }

  lines.push(
    '',
    'Reads are not in the log and are not reported here — this counts pushes and storage only.',
  )
  return lines.join('\n')
}
