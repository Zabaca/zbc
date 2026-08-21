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
 * Credentials come from `store-env.ts`, the same reader the smart-HTTP server,
 * the SSH forced command and both hook processes use. There is deliberately no
 * `~/.walgit/config`: a second configuration path is a second thing to be wrong
 * about, and the environment is what a `fly ssh console` session already has.
 *
 * Run it inside the container, where that environment exists:
 *
 *     fly ssh console -C "bun /app/src/cli.ts verify myrepo"
 *
 * Exit codes are meant to be branched on: 0 success, 1 a divergence or failure
 * the command was asked to detect, 2 misuse (unknown command, bad arguments,
 * missing configuration).
 */

import * as path from 'node:path'

import { collectOrphans, DEFAULT_MIN_AGE_MS } from './gc'
import { materialize, round } from './materialize'
import { normalizeRepoId, resolveRepo } from './repo'
import { requireStore } from './store-env'
import { formatVerify, verifyRepo } from './verify'
import { loadIndex } from './wal-index'

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
const KNOWN_VALUE_FLAGS = new Set(['min-age', 'repos-dir'])

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
  walgit compact <repo_id>              force a compaction

Options
  --repos-dir <dir>   where bare repos live (default: $WALGIT_REPOS_DIR)
  --json              machine-readable output
  --yes               gc: actually delete (without it, gc only reports)
  --min-age <minutes> gc: never collect an orphan younger than this (default 60)

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
  const minAgeMs = typeof minAgeFlag === 'string' ? Number(minAgeFlag) * 60_000 : DEFAULT_MIN_AGE_MS
  if (!Number.isFinite(minAgeMs) || minAgeMs < 0) {
    console.error(`walgit gc: --min-age must be a number of minutes, got ${String(minAgeFlag)}`)
    return MISUSE
  }

  const collect = args.flags.yes === true
  const results = []
  for (const requested of args.positional) {
    results.push(await collectOrphans(store, normalizeRepoId(requested), { collect, minAgeMs }))
  }

  const lines: string[] = []
  for (const result of results) {
    const verb = result.dryRun ? 'would collect' : 'collected'
    lines.push(`${result.repoId}: ${verb} ${result.collectable.length} orphaned objects`)
    for (const key of result.collectable) lines.push(`  ${result.dryRun ? '-' : 'deleted'} ${key}`)
    for (const held of result.retained) lines.push(`  kept (${held.reason}) ${held.key}`)
  }
  if (results.every((r) => r.collectable.length === 0 && r.retained.length === 0)) {
    lines.push('no orphaned objects')
  }
  if (collect === false && results.some((r) => r.collectable.length > 0)) {
    lines.push('nothing was deleted — re-run with --yes')
  }
  emit(args, results, lines.join('\n'))
  return OK
}

/**
 * Compaction is the next milestone's, and this command exists so the surface is
 * settled before it lands: it is one function call away from working, and an
 * operator who reaches for it learns what the system can actually do today
 * rather than finding an unknown command and guessing.
 */
async function compactCommand(args: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const [requested] = args.positional
  if (!requested) {
    console.error('walgit compact: usage: walgit compact <repo_id>')
    return MISUSE
  }
  const store = requireStore(env)
  const repoId = normalizeRepoId(requested)
  const { index } = await loadIndex(store, repoId)
  console.error(
    `walgit compact: not implemented yet — ${repoId} has ${index.entries.length} WAL entries ` +
      `at frontier ${index.compaction_frontier} (seq ${index.seq}).\n` +
      'Compaction rewrites the log into one entry and advances the frontier; it lands with the\n' +
      'compaction milestone. `walgit gc` already reclaims the packs rejected pushes leave behind.',
  )
  return MISUSE
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
