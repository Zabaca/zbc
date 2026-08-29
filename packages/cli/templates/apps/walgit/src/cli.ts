#!/usr/bin/env bun
/**
 * `walgit` — the operator front door.
 *
 * Everything here is a THIN front over the functions the server already calls:
 * `materialize`, `reconcile`, `findOrphans`, `verifyRepo`. That is not tidiness,
 * it is the only way `verify` can be trusted — a command-line reimplementation
 * of "is this disk current?" would answer for itself rather than for the server,
 * and would drift silently the first time the real path changed.
 *
 * Credentials come from `store-env.ts`, the same reader the smart-HTTP server
 * and both hook processes use. There is deliberately no `~/.walgit/config`: a
 * second configuration path is a second thing to be wrong about, and the
 * environment is what a shell inside the container already has.
 *
 * Run it inside the container, where that environment exists — or anywhere the
 * same WALGIT_* variables are set:
 *
 *     bun src/cli.ts verify myrepo
 *
 * Exit codes are meant to be branched on: 0 success, 1 a divergence or failure
 * the command was asked to detect, 2 misuse (unknown command, bad arguments,
 * missing configuration).
 */

import * as path from 'node:path'

import { compact, configuredGraceMs, type CompactResult } from './compact'
import { configuredDeleteGraceMs, deleteRepo } from './delete-repo'
import { configuredExpiryMs, expireRepos } from './expire'
import { collectGarbage } from './gc'
import { materialize, round } from './materialize'
import { normalizeRepoId, resolveRepo } from './repo'
import { requireStore } from './store-env'
import { collectUsage, formatUsage, parseDuration } from './usage'
import { formatVerify, verifyRepo } from './verify'

const OK = 0
const DIVERGED = 1
const MISUSE = 2

export interface ParsedArgs {
  command: string
  positional: string[]
  flags: Record<string, string | true>
}

/**
 * `--flag`, `--flag=value`, `--flag value`, and everything else positional.
 *
 * `KNOWN_VALUE_FLAGS` is what makes `--min-age 30` work without making
 * `gc myrepo --yes myotherrepo` swallow a repo id: a flag takes the next token
 * only when it is declared to want one.
 */
const KNOWN_VALUE_FLAGS = new Set(['min-age', 'repos-dir', 'grace', 'after', 'since', 'top'])

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const body = arg.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1)
    } else if (KNOWN_VALUE_FLAGS.has(body) && i + 1 < argv.length) {
      i += 1
      flags[body] = argv[i]!
    } else {
      flags[body] = true
    }
  }
  return { command: positional.shift() ?? '', positional, flags }
}

const USAGE = `walgit — operator CLI for a WAL-backed git host

  walgit serve                          run the git front end (smart-HTTP)
  walgit materialize <repo_id> [path]   rebuild a repo from the write-ahead log
  walgit verify <repo_id> [path]        check local state against index.json
  walgit gc <repo_id...>                reclaim orphaned WAL objects (dry run)
  walgit compact <repo_id> [path]       repack the log into one entry, now
  walgit delete <repo_id...>            remove repositories entirely (dry run)
  walgit usage                          what the log says this service holds
  walgit expire [repo_id...]            collect repos idle past the window (dry run)

Options
  --repos-dir <dir>   where bare repos live (default: $WALGIT_REPOS_DIR)
  --json              machine-readable output
  --yes               gc/delete/expire: actually delete (else they only report)
  --force=false       compact: respect the entry-count threshold instead of forcing
  --min-age <minutes> gc: never collect an object younger than this (default 60)
  --grace <minutes>   delete/expire: how long a repo is tombstoned first (default 60)
  --after <hours>     expire: idle window (default $WALGIT_RETENTION_HOURS; unset = off)
  --since <duration>  usage: push window, e.g. 24h, 7d, 30m (default 24h)
  --top <n>           usage: how many repositories to name (0 = all, default 10)

The object store is read from the environment the app itself uses:
WALGIT_S3_ENDPOINT / _BUCKET / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY, or
WALGIT_STORE_DIR for local use. Exit codes: 0 ok, 1 divergence, 2 misuse.`

function reposDirOf(args: ParsedArgs, env: NodeJS.ProcessEnv): string {
  const flag = args.flags['repos-dir']
  if (typeof flag === 'string') return flag
  return env.WALGIT_REPOS_DIR ?? '/srv/walgit/repos'
}

/** The repo the operator named, at the path they named, or at the default one. */
function repoAt(args: ParsedArgs, env: NodeJS.ProcessEnv, requested: string, dir?: string) {
  if (dir) return { repoId: normalizeRepoId(requested), dir: path.resolve(dir) }
  return resolveRepo(reposDirOf(args, env), requested)
}

function emit(args: ParsedArgs, payload: unknown, text: string): void {
  if (args.flags.json) console.log(JSON.stringify(payload, null, 2))
  else console.log(text)
}

// ── Commands ────────────────────────────────────────────────────────────────

/**
 * `serve` delegates to `src/server.ts` by importing it — that module starts the
 * server as a side effect of loading. The container entrypoint still calls that
 * file directly, so there is exactly one server with one startup sequence, and
 * this is a convenience over it rather than a second way to boot.
 */
async function serve(): Promise<number> {
  await import('./server')
  // The server holds the process open; returning is unreachable in practice.
  return OK
}

async function materializeCommand(args: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const [requested, target] = args.positional
  if (!requested) {
    console.error('walgit materialize: usage: walgit materialize <repo_id> [path]')
    return MISUSE
  }
  const store = requireStore(env)
  const repo = repoAt(args, env, requested, target)

  const result = await materialize(store, repo)
  emit(
    args,
    { ...round(result.stats), dir: repo.dir, refs: Object.keys(result.index.refs).length },
    `materialized ${repo.repoId} into ${repo.dir}\n` +
      `  ${result.stats.fetched} entries fetched, ${result.stats.skipped} already present, ` +
      `${result.stats.superseded} superseded\n` +
      `  ${Object.keys(result.index.refs).length} refs, ${Math.round(result.stats.totalMs)} ms`,
  )

  // A ref the log names but no downloaded object satisfies means the log itself
  // is incomplete — reporting success here would hand back a repo that clones
  // short, which is the one outcome this whole design exists to prevent.
  if (result.reconciled.missing.length > 0) {
    console.error(
      `walgit: ${result.reconciled.missing.length} refs could not be restored: ` +
        result.reconciled.missing.join(', '),
    )
    return DIVERGED
  }
  return OK
}

async function verifyCommand(args: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const [requested, target] = args.positional
  if (!requested) {
    console.error('walgit verify: usage: walgit verify <repo_id> [path]')
    return MISUSE
  }
  const store = requireStore(env)
  const repo = repoAt(args, env, requested, target)

  const report = await verifyRepo(store, repo)
  emit(args, report, formatVerify(report))
  return report.ok ? OK : DIVERGED
}

async function gcCommand(args: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  if (args.positional.length === 0) {
    // No "collect everything" mode on purpose: a `LIST` of the whole bucket
    // would name repos this node has never served, and the blast radius of a
    // wrong guess is objects deleted from the source of truth.
    console.error('walgit gc: usage: walgit gc <repo_id...> [--yes] [--min-age <minutes>]')
    return MISUSE
  }
  const store = requireStore(env)
  const minAgeFlag = args.flags['min-age']
  const graceMs =
    typeof minAgeFlag === 'string' ? Number(minAgeFlag) * 60_000 : configuredGraceMs(env)
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    console.error(`walgit gc: --min-age must be a number of minutes, got ${String(minAgeFlag)}`)
    return MISUSE
  }

  // Dry run is the default. An operator reaching for `gc` on a bad day should
  // be able to look before anything is gone, so deleting takes an extra word.
  const dryRun = args.flags.yes !== true
  const results = []
  for (const requested of args.positional) {
    const repoId = normalizeRepoId(requested)
    results.push({ repoId, ...(await collectGarbage(store, repoId, { graceMs, dryRun })) })
  }

  const lines: string[] = []
  let total = 0
  for (const result of results) {
    const reclaimable = [...result.collected, ...result.orphansCollected]
    total += reclaimable.length
    const verb = dryRun ? 'would collect' : 'collected'
    lines.push(`${result.repoId}: ${verb} ${reclaimable.length} objects`)
    for (const key of result.collected)
      lines.push(`  ${dryRun ? '-' : 'deleted'} ${key} (superseded)`)
    for (const key of result.orphansCollected)
      lines.push(`  ${dryRun ? '-' : 'deleted'} ${key} (orphan)`)
    // Held objects are named rather than counted: "why is this still here" is
    // the question an operator actually arrives with.
    for (const key of result.retained) lines.push(`  kept (in grace) ${key}`)
    for (const key of result.orphansHeld) lines.push(`  kept (too young or undatable) ${key}`)
  }
  if (
    results.every(
      (r) =>
        r.collected.length +
          r.orphansCollected.length +
          r.retained.length +
          r.orphansHeld.length ===
        0,
    )
  ) {
    lines.push('nothing to collect')
  }
  if (dryRun && total > 0) lines.push('nothing was deleted — re-run with --yes')
  emit(args, results, lines.join('\n'))
  return OK
}

/**
 * Remove repositories entirely — index, WAL objects, and the cached bare repo.
 *
 * Deferred in two steps by design: the first `--yes` run tombstones, and a
 * later one collects once the grace period has elapsed. See `delete-repo.ts`
 * for why the wait is not optional and why the index goes first.
 */
async function deleteCommand(args: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  if (args.positional.length === 0) {
    console.error('walgit delete: usage: walgit delete <repo_id...> [--yes] [--grace <minutes>]')
    return MISUSE
  }
  const store = requireStore(env)
  const graceFlag = args.flags.grace
  const graceMs =
    typeof graceFlag === 'string' ? Number(graceFlag) * 60_000 : configuredDeleteGraceMs(env)
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    console.error(`walgit delete: --grace must be a number of minutes, got ${String(graceFlag)}`)
    return MISUSE
  }

  // Dry run is the default, as it is for `gc`, and more emphatically: this
  // command deletes objects the index still names.
  const dryRun = args.flags.yes !== true
  const results = []
  for (const requested of args.positional) {
    const repo = repoAt(args, env, requested)
    results.push(await deleteRepo(store, repo.repoId, { graceMs, dryRun, dir: repo.dir }))
  }

  const lines: string[] = []
  for (const result of results) {
    if (result.status === 'absent') {
      lines.push(`${result.repoId}: nothing to delete`)
    } else if (result.status === 'tombstoned') {
      lines.push(
        `${result.repoId}: ${dryRun ? 'would be scheduled' : 'scheduled'} for deletion, ` +
          `collectable after ${result.collectAfter}`,
      )
    } else if (result.status === 'retained') {
      lines.push(
        `${result.repoId}: already scheduled — nothing may be deleted before ` +
          `${result.collectAfter}`,
      )
    } else {
      const verb = dryRun ? 'would delete' : 'deleted'
      lines.push(`${result.repoId}: ${verb} ${result.deleted.length} objects`)
    }
    for (const key of result.deleted) lines.push(`  ${dryRun ? '-' : 'deleted'} ${key}`)
    for (const kept of result.retained) lines.push(`  kept ${kept.key} (${kept.reason})`)
    if (result.cacheRemoved) lines.push(`  removed cache ${result.cacheRemoved}`)
  }
  if (dryRun && results.some((r) => r.status !== 'absent')) {
    lines.push('nothing was changed — re-run with --yes')
  }
  emit(args, results, lines.join('\n'))
  return OK
}

/**
 * Collect repositories nobody has pushed to for longer than the window.
 *
 * Named repositories may be given, but the point of the command is the bare
 * form: it enumerates every repository in the store, which is exactly what `gc`
 * refuses to do. The difference is what a wrong answer costs. `gc` deletes
 * objects `index.json` does not name, so guessing the repo set there risks
 * deleting a live repository's packs; expiry deletes only what the log itself
 * dates as idle, and every case it cannot date resolves toward keeping.
 *
 * Off unless `WALGIT_RETENTION_HOURS` (or `--after`) says otherwise, because an
 * instance that has not been told to expire anything must not.
 */
async function expireCommand(args: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const afterFlag = args.flags.after
  const windowMs =
    typeof afterFlag === 'string' ? Number(afterFlag) * 3_600_000 : configuredExpiryMs(env)
  if (windowMs !== null && (!Number.isFinite(windowMs) || windowMs <= 0)) {
    console.error(
      `walgit expire: --after must be a positive number of hours, got ${String(afterFlag)}`,
    )
    return MISUSE
  }
  const graceFlag = args.flags.grace
  const graceMs =
    typeof graceFlag === 'string' ? Number(graceFlag) * 60_000 : configuredDeleteGraceMs(env)
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    console.error(`walgit expire: --grace must be a number of minutes, got ${String(graceFlag)}`)
    return MISUSE
  }

  if (windowMs === null) {
    // Not an error: an instance with no retention window is a valid instance,
    // and the timer calling this should not start failing because of it.
    emit(
      args,
      { collected: [], retained: [], windowMs: null, dryRun: true },
      'expiry is not configured — set WALGIT_RETENTION_HOURS or pass --after <hours>',
    )
    return OK
  }

  const store = requireStore(env)
  const dryRun = args.flags.yes !== true
  const result = await expireRepos(store, {
    windowMs,
    graceMs,
    dryRun,
    reposDir: reposDirOf(args, env),
    repoIds:
      args.positional.length > 0 ? args.positional.map((r) => normalizeRepoId(r)) : undefined,
  })

  const lines: string[] = [
    `window ${windowMs / 3_600_000}h — ${result.collected.length} collected, ` +
      `${result.retained.length} retained`,
  ]
  for (const outcome of result.collected) {
    const status = outcome.deletion?.status ?? 'collected'
    lines.push(
      `  ${dryRun ? 'would collect' : status} ${outcome.repoId} (${outcome.decision.reason})`,
    )
  }
  // Retentions are named with their reason rather than counted: a repository
  // that should have gone and did not is only debuggable if the run says why.
  for (const outcome of result.retained) {
    lines.push(`  kept ${outcome.repoId} (${outcome.decision.reason})`)
  }
  if (dryRun && result.collected.length > 0) lines.push('nothing was changed — re-run with --yes')
  emit(args, result, lines.join('\n'))
  return OK
}

/**
 * Force a compaction, bypassing the entry-count threshold.
 *
 * The threshold exists so compaction happens on its own after enough pushes;
 * this command is for the case that has already gone wrong — a repo whose
 * restore is slow because its log is long, and an operator who wants it short
 * now rather than after the next N pushes.
 */
async function compactCommand(args: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const [requested] = args.positional
  if (!requested) {
    console.error('walgit compact: usage: walgit compact <repo_id> [path] [--force]')
    return MISUSE
  }
  const store = requireStore(env)
  const repo = repoAt(args, env, requested)
  // Forcing is the default here and nowhere else: someone typing `compact` has
  // already decided, whereas the automatic path must respect the threshold.
  // `--force=false` opts back into it, which is how an operator asks "would
  // this compact on its own yet?" without making it happen.
  const result = await compact(store, repo, { force: args.flags.force !== 'false' })

  const lines: Record<CompactResult['status'], () => string> = {
    compacted: () => {
      const r = result as Extract<CompactResult, { status: 'compacted' }>
      return (
        `${repo.repoId}: compacted into seq ${r.seq}, superseding through ` +
        `${r.supersedes_through} (${r.tombstoned.length} objects tombstoned, ` +
        `${(r.bytes / 1024).toFixed(0)} KiB, ${r.ms.toFixed(0)}ms)\n` +
        'Tombstoned objects are deleted by `walgit gc` once their grace period elapses.'
      )
    },
    'not-due': () =>
      `${repo.repoId}: not due — ${(result as { pending: number }).pending} entries pending`,
    held: () =>
      `${repo.repoId}: another node holds the compaction lease (${(result as { holder: string }).holder})`,
    empty: () => `${repo.repoId}: nothing to compact`,
  }
  emit(args, result, lines[result.status]())
  // `held` is not a failure: the work is being done, just not by this process.
  return OK
}

/**
 * `usage` reads and only reads. It needs no repos directory, no local cache and
 * no running server — bucket credentials are the whole requirement, so it can
 * be run from a laptop while the service is on fire.
 */
async function usageCommand(args: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  if (args.positional.length > 0) {
    console.error('walgit usage: usage: walgit usage [--since 24h] [--top 10] [--json]')
    return MISUSE
  }
  const since = args.flags.since
  const top = args.flags.top
  const topN = typeof top === 'string' ? Number(top) : 10
  if (!Number.isInteger(topN) || topN < 0) {
    console.error(`walgit usage: --top expects a non-negative integer, got ${String(top)}`)
    return MISUSE
  }
  const store = requireStore(env)

  const report = await collectUsage(store, {
    // A window is the default because "what is happening now" is the question
    // that brings someone here; `--since 0` asks for lifetime totals only.
    sinceMs: parseDuration(typeof since === 'string' ? since : '24h') || undefined,
    top: topN,
  })
  emit(args, report, formatUsage(report))
  return OK
}

// ── Entry point ─────────────────────────────────────────────────────────────

export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const args = parseArgs(argv)
  if (args.command === '' || args.flags.help || args.command === 'help') {
    console.log(USAGE)
    return args.command === '' && !args.flags.help ? MISUSE : OK
  }

  try {
    switch (args.command) {
      case 'serve':
        return await serve()
      case 'materialize':
        return await materializeCommand(args, env)
      case 'verify':
        return await verifyCommand(args, env)
      case 'gc':
        return await gcCommand(args, env)
      case 'compact':
        return await compactCommand(args, env)
      case 'delete':
        return await deleteCommand(args, env)
      case 'usage':
        return await usageCommand(args, env)
      case 'expire':
        return await expireCommand(args, env)
      default:
        console.error(`walgit: unknown command "${args.command}"\n\n${USAGE}`)
        return MISUSE
    }
  } catch (error) {
    // One message, no stack: the failures an operator hits here are a missing
    // credential, a bad repo name, or an unreachable bucket, and a stack trace
    // buries all three.
    console.error(`walgit: ${error instanceof Error ? error.message : String(error)}`)
    return MISUSE
  }
}

// `import.meta.main` is false when the test suite imports this file, so the
// exported `main` stays callable without the process exiting under it.
if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2))
}
