/**
 * Force local refs to match `index.json`.
 *
 * The index is the source of truth and the disk is a cache, so this is always
 * one-directional: whatever the local repo believes is discarded. It closes the
 * race the push path opens — a compare-and-swap that wins and a local ref
 * update that then dies leaves the published truth invisible on this node until
 * something reasserts it — and it is the same operation a cold materialize ends
 * with, which is why it lands here rather than with the milestone that needs it
 * second.
 *
 * The write is a single `packed-refs` file, not one `git update-ref` per ref: a
 * repository with thousands of refs would otherwise pay thousands of processes,
 * and each of those would fire the `reference-transaction` hook and try to
 * publish the truth it was just told.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { git } from './git'
import type { WalIndex } from './wal-index'

export interface ReconcileResult {
  changed: boolean
  /** Refs written to match the index. */
  updated: string[]
  /** Local refs the index does not have; removed. */
  removed: string[]
  /**
   * Refs in the index whose object is not in this repo's object store. They
   * are NOT written — a ref pointing at a missing object is a broken repo, and
   * a client would see a corrupt clone rather than a stale one. Fetching the
   * WAL entries that carry them is the materialize path's job.
   */
  missing: string[]
}

export function localRefs(gitDir: string): Record<string, string> {
  const res = git(['--git-dir', gitDir, 'for-each-ref', '--format=%(objectname) %(refname)'])
  if (res.status !== 0) throw new Error(`for-each-ref failed: ${res.stderr.trim()}`)
  const refs: Record<string, string> = {}
  for (const line of res.stdout.split('\n')) {
    const match = /^(\S+) (.+)$/.exec(line)
    if (match) refs[match[2]!] = match[1]!
  }
  return refs
}

/** Which of these oids the local object store actually has. One process. */
export function presentObjects(gitDir: string, oids: readonly string[]): Set<string> {
  if (oids.length === 0) return new Set()
  const res = git(['--git-dir', gitDir, 'cat-file', '--batch-check'], {
    input: `${oids.join('\n')}\n`,
  })
  const present = new Set<string>()
  for (const line of res.stdout.split('\n')) {
    const match = /^(\S+) (\S+) \d+$/.exec(line)
    if (match && match[2] !== 'missing') present.add(match[1]!)
  }
  return present
}

export function reconcile(gitDir: string, index: WalIndex): ReconcileResult {
  const local = localRefs(gitDir)
  const desired = index.refs
  const present = presentObjects(gitDir, [...new Set(Object.values(desired))])

  const updated: string[] = []
  const missing: string[] = []
  const removed = Object.keys(local).filter((ref) => !(ref in desired))

  const writable: Record<string, string> = {}
  for (const [ref, oid] of Object.entries(desired)) {
    if (!present.has(oid)) {
      missing.push(ref)
      // Keep whatever the local repo already has for a ref we cannot satisfy:
      // dropping it would turn "stale" into "gone" for a client mid-clone.
      if (local[ref]) writable[ref] = local[ref]!
      continue
    }
    writable[ref] = oid
    if (local[ref] !== oid) updated.push(ref)
  }

  if (updated.length === 0 && removed.length === 0) {
    return { changed: false, updated, removed, missing }
  }

  writePackedRefs(gitDir, writable)
  return { changed: true, updated, removed, missing }
}

/**
 * Replace `packed-refs` wholesale and delete every loose ref, because a loose
 * ref shadows the packed one — leaving them would silently undo the reconcile
 * for exactly the refs that were wrong.
 */
function writePackedRefs(gitDir: string, refs: Record<string, string>): void {
  const lines = ['# pack-refs with: peeled fully-peeled sorted ']
  for (const ref of Object.keys(refs).sort()) lines.push(`${refs[ref]} ${ref}`)

  const target = path.join(gitDir, 'packed-refs')
  const tmp = `${target}.walgit-${process.pid}`
  fs.writeFileSync(tmp, `${lines.join('\n')}\n`)
  fs.renameSync(tmp, target)

  const refsDir = path.join(gitDir, 'refs')
  if (fs.existsSync(refsDir)) {
    for (const entry of fs.readdirSync(refsDir)) {
      fs.rmSync(path.join(refsDir, entry), { recursive: true, force: true })
    }
  }
}
