#!/usr/bin/env bun
/**
 * Materialize latency, measured as its OWN number.
 *
 * The design's target — a cold materialize under two seconds — was written for
 * an always-on NVMe node. With a container that sleeps when idle the wall-clock
 * a client experiences is machine wake PLUS this, and wake alone was measured
 * at ~1.35 s in the milestone-0 spike. Blending them makes a regression
 * unattributable, so this harness measures the replay half and nothing else:
 * no machine wake, no TLS, no git client.
 *
 * The number is a CONTROL LOOP, not a pass/fail gate. Exceeding it means the
 * WAL is replaying too many entries for the repo's size, and the knob is the
 * compaction threshold — not this code.
 *
 * Output is one JSON object on stdout, so CI can diff two runs:
 *
 *     bun run src/materialize.bench.ts > bench.json
 *     bun run src/materialize.bench.ts --entries 50,200 --runs 30
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { compact } from './compact'
import { indexKey, siblingIdx, walKey } from './keys'
import { materialize } from './materialize'
import { resolveRepo } from './repo'
import { FileStore } from './store'
import { ulid } from './ulid'
import {
  commitIndex,
  emptyIndex,
  loadIndex,
  sha256,
  type WalEntry,
  type WalIndex,
} from './wal-index'

interface Sample {
  entries: number
  bytes: number
  totalMs: number
  fetchMs: number
  refsMs: number
  initMs: number
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}

const sizes = arg('entries', '1,10,50,200').split(',').map(Number)
const runs = Number(arg('runs', '15'))

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-bench-'))
const storeDir = path.join(root, 'store')
const reposDir = path.join(root, 'repos')
const workDir = path.join(root, 'work')
for (const d of [storeDir, reposDir, workDir]) fs.mkdirSync(d, { recursive: true })
const store = new FileStore(storeDir)
process.env.WALGIT_QUIET = '1'

const git = (cwd: string, ...args: string[]) => {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout
}

/**
 * A WAL of `count` entries, each an incremental pack of one commit — the shape
 * a real push history has, and the shape that makes entry COUNT rather than
 * total bytes the thing being varied.
 */
async function buildLog(repoId: string, count: number): Promise<WalIndex> {
  const src = path.join(workDir, repoId)
  fs.mkdirSync(src, { recursive: true })
  git(src, 'init', '--quiet', '--initial-branch=main')
  git(src, 'config', 'user.email', 'bench@example.test')
  git(src, 'config', 'user.name', 'bench')

  let index: WalIndex = emptyIndex(repoId)
  let parent: string | null = null
  for (let i = 0; i < count; i += 1) {
    fs.writeFileSync(path.join(src, 'README'), `commit ${i}\n${'x'.repeat(512)}\n`)
    git(src, 'add', 'README')
    git(src, 'commit', '--quiet', '-m', `commit ${i}`)
    const head = git(src, 'rev-parse', 'HEAD').trim()

    // Only what this commit added, exactly as `pre-receive` would see it.
    const rev = parent ? `${head} --not ${parent}` : head
    const objects = spawnSync('git', ['rev-list', '--objects', ...rev.split(' ')], {
      cwd: src,
      encoding: 'utf8',
    }).stdout
    const packed = spawnSync('git', ['pack-objects', '--stdout', '-q'], {
      cwd: src,
      input: objects,
      maxBuffer: 1 << 28,
    })
    // A `Buffer` already IS a `Uint8Array`; wrapping it would only double the
    // memory the bench holds, which is the one thing a bench should not
    // misreport.
    const pack = packed.stdout

    const seq = i + 1
    const key = walKey(repoId, seq, ulid(Date.now() + i), 'pack')
    await store.put(key, pack)
    const staged = path.join(workDir, `${repoId}-idx-${seq}`)
    fs.mkdirSync(staged, { recursive: true })
    fs.writeFileSync(path.join(staged, 'p.pack'), pack)
    git(staged, 'index-pack', 'p.pack')
    await store.put(siblingIdx(key), fs.readFileSync(path.join(staged, 'p.idx')))

    const entry: WalEntry = {
      seq,
      key,
      kind: 'push',
      size: pack.byteLength,
      sha256: sha256(pack),
      ts: new Date().toISOString(),
    }
    index = { ...index, seq, entries: [...index.entries, entry], refs: { 'refs/heads/main': head } }
    parent = head
  }

  const existing = await store.get(indexKey(repoId))
  await commitIndex(store, index, existing?.etag ?? null)
  return index
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)]!
}

/** `runs` cold restores from one index, each into a directory of its own. */
async function measure(repoId: string, index: WalIndex, tag: string): Promise<Sample[]> {
  const samples: Sample[] = []
  for (let run = 0; run < runs; run += 1) {
    // A fresh directory every run: measuring a warm disk would measure a
    // `readdir`, which is not the operation anyone is waiting on.
    const repo = resolveRepo(reposDir, `${repoId}-${tag}-${run}`)
    const { stats } = await materialize(store, repo, { ...index, repo_id: repo.repoId })
    samples.push({
      entries: stats.fetched,
      bytes: stats.bytes,
      totalMs: stats.totalMs,
      fetchMs: stats.fetchMs,
      refsMs: stats.refsMs,
      initMs: stats.initMs,
    })
    fs.rmSync(repo.dir, { recursive: true, force: true })
  }
  return samples
}

const results: unknown[] = []
for (const count of sizes) {
  const repoId = `bench-${count}`
  const index = await buildLog(repoId, count)
  const samples = await measure(repoId, index, 'raw')

  // The same repository after compaction. This pair is the whole claim of the
  // compaction milestone: the left number grows with push count and the right
  // one does not, because a restore replays one entry either way.
  const primary = resolveRepo(reposDir, repoId)
  const compaction = await compact(store, primary, { force: true, graceMs: 0 })
  const compactedIndex = (await loadIndex(store, repoId)).index
  const compactedSamples = await measure(repoId, compactedIndex, 'compacted')
  fs.rmSync(primary.dir, { recursive: true, force: true })

  const total = samples.map((s) => s.totalMs)
  const compactedTotal = compactedSamples.map((s) => s.totalMs)
  results.push({
    walEntries: count,
    compacted: {
      status: compaction.status,
      entriesToReplay: compactedSamples[0]!.entries,
      bytes: compactedSamples[0]!.bytes,
      totalMs: {
        p50: round(percentile(compactedTotal, 50)),
        p99: round(percentile(compactedTotal, 99)),
      },
    },
    bytes: samples[0]!.bytes,
    runs,
    totalMs: { p50: round(percentile(total, 50)), p99: round(percentile(total, 99)) },
    fetchMs: {
      p50: round(
        percentile(
          samples.map((s) => s.fetchMs),
          50,
        ),
      ),
      p99: round(
        percentile(
          samples.map((s) => s.fetchMs),
          99,
        ),
      ),
    },
    refsMs: {
      p50: round(
        percentile(
          samples.map((s) => s.refsMs),
          50,
        ),
      ),
    },
    initMs: {
      p50: round(
        percentile(
          samples.map((s) => s.initMs),
          50,
        ),
      ),
    },
  })
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

fs.rmSync(root, { recursive: true, force: true })

console.log(
  JSON.stringify(
    {
      what:
        'walgit cold materialize — the WAL replay half only, excluding machine wake. ' +
        'Each size is measured twice: over the raw log, and over the same repository ' +
        'after compaction. The second column is the one that must stay flat.',
      note:
        'A client also pays container cold start (median 1770ms, Containers spike). ' +
        'These numbers are a control loop on the compaction threshold, not a pass/fail gate.',
      store: 'FileStore (local disk) — a real bucket adds one round trip per entry',
      platform: `${process.platform}/${process.arch}`,
      results,
    },
    null,
    2,
  ),
)
