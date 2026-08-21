/**
 * Does this disk agree with the log?
 *
 * Read-only, and that is the whole point. `sync.ts` answers the same question on
 * every access and immediately repairs what it finds, which makes it useless for
 * an operator asking "was this node serving the wrong thing?" — by the time the
 * answer arrives the evidence is gone. This asks and does not touch.
 *
 * It reports four independent disagreements rather than one boolean, because
 * they have different causes and different repairs:
 *
 *   - **Diverged refs** — the disk and `index.json` name different oids for a
 *     ref, or one has a ref the other does not. Repaired by `reconcile`.
 *   - **Missing objects** — the log names an oid this repo does not have. The
 *     WAL has to be replayed; `reconcile` deliberately refuses to write such a
 *     ref, so a node in this state serves a stale ref rather than a broken one.
 *   - **Missing packs** — a WAL entry above `compaction_frontier` is not on
 *     disk. Usually the same fault as above, seen from the log's side; it can
 *     also stand alone, when the absent entry carried only objects some other
 *     entry also carries.
 *   - **A partial marker** — a materialize died partway. The refs may look
 *     perfect and the repo still be truncated, which is exactly why the marker
 *     exists and why it is checked here rather than inferred.
 *
 * Refs the CACHE has and the log does not are reported as divergence too. The
 * log is the source of truth, so a local-only ref is not "extra" — it is a ref
 * that will vanish on the next access, and an operator chasing "my branch
 * disappeared" needs to see it named here.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { isPartial, neededEntries, packBasename } from './materialize'
import { localRefs, presentObjects } from './reconcile'
import type { ResolvedRepo } from './repo'
import type { ObjectStore } from './store'
import { loadIndex, type WalIndex } from './wal-index'

export interface RefDivergence {
  ref: string
  /** Oid on this disk, or `null` when the ref is only in the log. */
  local: string | null
  /** Oid in `index.json`, or `null` when the ref is only on this disk. */
  log: string | null
}

export interface MissingPack {
  seq: number
  key: string
}

export interface VerifyReport {
  repoId: string
  dir: string
  /** False when there is no bare repo here at all — a cold node, not a broken one. */
  exists: boolean
  /** A materialize died partway; the repo may be truncated however good the refs look. */
  partial: boolean
  seq: number
  entries: number
  compactionFrontier: number
  diverged: RefDivergence[]
  /** Refs the log names whose object this repo does not have. */
  missingObjects: string[]
  /** WAL entries above the frontier whose pack is absent from `objects/pack`. */
  missingPacks: MissingPack[]
  ok: boolean
}

/** True when the directory holds a git repository, without running git to find out. */
export function repoExists(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'HEAD'))
}

export async function verifyRepo(
  store: ObjectStore,
  repo: ResolvedRepo,
  known?: WalIndex,
): Promise<VerifyReport> {
  const index = known ?? (await loadIndex(store, repo.repoId)).index
  const base = {
    repoId: repo.repoId,
    dir: repo.dir,
    seq: index.seq,
    entries: index.entries.length,
    compactionFrontier: index.compaction_frontier,
  }

  if (!repoExists(repo.dir)) {
    // Not a failure of agreement — there is nothing here to disagree. An
    // operator who wanted a repo here reads `exists: false` and materializes;
    // one who is checking a node that never served this repo reads it and moves
    // on. Reporting it as divergence would drown the real ones.
    return {
      ...base,
      exists: false,
      partial: false,
      diverged: [],
      missingObjects: [],
      missingPacks: [],
      ok: index.seq === 0,
    }
  }

  const local = localRefs(repo.dir)
  const desired = index.refs
  const present = presentObjects(repo.dir, [...new Set(Object.values(desired))])

  const diverged: RefDivergence[] = []
  for (const ref of [...new Set([...Object.keys(local), ...Object.keys(desired)])].sort()) {
    if (local[ref] !== desired[ref]) {
      diverged.push({ ref, local: local[ref] ?? null, log: desired[ref] ?? null })
    }
  }

  const missingObjects = Object.entries(desired)
    .filter(([, oid]) => !present.has(oid))
    .map(([ref]) => ref)
    .sort()

  const packDir = path.join(repo.dir, 'objects', 'pack')
  const onDisk = new Set(
    fs.existsSync(packDir) ? fs.readdirSync(packDir).filter((f) => f.endsWith('.pack')) : [],
  )
  const missingPacks = neededEntries(index)
    .filter((entry) => !onDisk.has(`${packBasename(entry)}.pack`))
    .map((entry) => ({ seq: entry.seq, key: entry.key }))

  const partial = isPartial(repo.dir)
  return {
    ...base,
    exists: true,
    partial,
    diverged,
    missingObjects,
    missingPacks,
    ok:
      !partial && diverged.length === 0 && missingObjects.length === 0 && missingPacks.length === 0,
  }
}

/** One operator-readable block. Every disagreement names the refs it is about. */
export function formatVerify(report: VerifyReport): string {
  const lines: string[] = []
  lines.push(
    `${report.repoId}: seq ${report.seq}, ${report.entries} WAL ${
      report.entries === 1 ? 'entry' : 'entries'
    }, frontier ${report.compactionFrontier}`,
  )
  lines.push(`  disk: ${report.dir}`)

  if (!report.exists) {
    lines.push('  no local repo — nothing cached here (materialize to build one)')
    return lines.join('\n')
  }
  if (report.ok) {
    lines.push('  OK — local state agrees with index.json')
    return lines.join('\n')
  }

  if (report.partial) lines.push('  PARTIAL — a previous materialize did not finish')
  for (const d of report.diverged) {
    lines.push(`  DIVERGED ${d.ref}: local ${d.local ?? '(absent)'} log ${d.log ?? '(absent)'}`)
  }
  for (const ref of report.missingObjects) {
    lines.push(`  MISSING OBJECT ${ref}: the log's oid is not in this repo`)
  }
  for (const pack of report.missingPacks) {
    lines.push(`  MISSING PACK seq ${pack.seq}: ${pack.key}`)
  }
  return lines.join('\n')
}
