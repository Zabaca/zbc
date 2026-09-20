/**
 * One level of one directory, read off the Cache.
 *
 * This is the whole reason a browse is answered by the container rather than at
 * the edge like the repository list: the Index carries the full ref state and
 * not a single object, so the only thing that can say what is inside a tree is
 * git, on the disk the log was Materialized onto (docs/adr/0007).
 *
 * ── one level, never recursive ──────────────────────────────────────────────
 *
 * `ls-tree` without `-r`. A recursive read of a large repository is unbounded
 * work on the request path, in the one container that is also serving pushes,
 * for a page that shows one directory. Clicking into a directory is another
 * request, which is what pagination looks like when the tree is the index.
 *
 * ── every argument is data ──────────────────────────────────────────────────
 *
 * The revision goes in `operands` and the directory in `paths`, so git's own
 * `--end-of-options` and `--` fences stand between an untrusted URL and a
 * command line (`src/git.ts`). Nothing here concatenates either into `args`.
 */

import { type TreeEntry } from '../shared/browse'
import { git } from './git'

/** git's modes, as the four kinds a reader can actually see apart. */
const SYMLINK_MODE = '120000'
const GITLINK_MODE = '160000'

/**
 * One level of the tree at `rev`:`dir`, or `null` when that is not a directory.
 *
 * `null` for a blob, for a path that is not there and for a revision this Cache
 * does not hold — all three are "there is no directory to show", and git has no
 * empty tree, so empty output is the absence rather than an empty listing.
 *
 * Async because the caller is (`src/http.ts` awaits it beside two store reads),
 * not because git is: `spawnSync` is what every other git call here uses, and a
 * browse is one command.
 */
export async function listTree(
  gitDir: string,
  rev: string,
  dir: string,
): Promise<TreeEntry[] | null> {
  // The trailing slash is what makes this list a directory's CONTENTS rather
  // than print the directory's own entry — git's own spelling, and the
  // difference between a page and a one-row page.
  const paths = dir === '' ? [] : [`${dir}/`]
  const res = git(['ls-tree', '--long', '-z'], { gitDir, operands: [rev], paths })
  if (res.status !== 0) return null

  const records = res.stdout.split('\0').filter((record) => record !== '')
  if (records.length === 0) return null

  const entries: TreeEntry[] = []
  for (const record of records) {
    const entry = parseRecord(record, dir)
    if (entry) entries.push(entry)
  }
  // Directories first, then by name — the order a reader expects of a file
  // browser, and one `ls-tree` does not make (it is in tree order, which is
  // git's own byte ordering with a trailing slash on directory names).
  entries.sort((a, b) => {
    if ((a.kind === 'tree') !== (b.kind === 'tree')) return a.kind === 'tree' ? -1 : 1
    return a.name < b.name ? -1 : 1
  })

  for (const entry of entries) {
    if (entry.kind !== 'symlink') continue
    // One `cat-file` per symlink rather than a batch: a symlink's target is its
    // whole content, symlinks are a handful per directory at most, and batching
    // would put an object-id list on a subprocess's stdin to save a spawn on a
    // page that already spawned one.
    const target = git(['cat-file', 'blob'], { gitDir, operands: [entry.oid] })
    if (target.status === 0) entry.target = target.stdout
  }

  return entries
}

/**
 * One `--long -z` record: `<mode> <type> <oid> <size>\t<path>`.
 *
 * The size column is `-` for everything git does not weigh (a tree, a gitlink),
 * and the path is FULL — relative to the repository root, not to the directory
 * asked for — so the prefix comes back off here rather than at the renderer.
 */
function parseRecord(record: string, dir: string): TreeEntry | null {
  const tab = record.indexOf('\t')
  if (tab === -1) return null
  const fields = record.slice(0, tab).split(/\s+/)
  const [mode, type, oid, size] = fields
  if (!mode || !type || !oid) return null

  const full = record.slice(tab + 1)
  const name = dir === '' ? full : full.slice(dir.length + 1)
  if (name === '' || name.includes('/')) return null

  const kind =
    mode === SYMLINK_MODE
      ? 'symlink'
      : mode === GITLINK_MODE
        ? 'submodule'
        : type === 'tree'
          ? 'tree'
          : 'blob'
  const bytes = Number(size)
  return {
    name,
    kind,
    oid,
    // Only a blob has one. `-` and anything unparseable read as "git did not
    // say", which is what `null` means here and never zero.
    size: kind === 'blob' && Number.isFinite(bytes) ? bytes : null,
  }
}
