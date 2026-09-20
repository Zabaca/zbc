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

import { OID, type Commit, type TreeEntry } from '../shared/browse'
import { git, gitBytes } from './git'

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

/**
 * What git knows about `rev`:`path` without reading it — its object id and its
 * size — or `null` when that is not a blob.
 *
 * `--batch-check` rather than `cat-file -s`: one spawn answers both the TYPE
 * and the size, and the type is what makes a directory a `null` here rather
 * than a file of some size. The size is the whole point of asking separately
 * from `readBlob` — it is what the cap is enforced against before any content
 * reaches this process (`BLOB_MAX_BYTES`).
 *
 * The revision goes in on STDIN rather than as an operand, which is where
 * `--batch-check` reads it, so nothing about the reader's spelling reaches a
 * command line at all.
 */
export async function statBlob(
  gitDir: string,
  rev: string,
  path: string,
): Promise<{ oid: string; size: number } | null> {
  if (path === '') return null
  const res = git(['cat-file', '--batch-check'], { gitDir, input: `${rev}:${path}\n` })
  if (res.status !== 0) return null
  // `<oid> <type> <size>`, or `<what was asked> missing`.
  const [oid, type, size] = res.stdout.trim().split(' ')
  if (!oid || type !== 'blob') return null
  const bytes = Number(size)
  return Number.isFinite(bytes) ? { oid, size: bytes } : null
}

/**
 * The bytes of `rev`:`path`, or `null` when there are none to read.
 *
 * Bytes, never a string: see `gitBytes`. The caller has already asked
 * `statBlob` what it is and how big, so this does no checking of its own —
 * `cat-file blob` on a tree fails, and a failure is `null`.
 *
 * One bound the caller does NOT set: a raw read is uncapped by design, but this
 * buffers, so a blob over `MAX_BUFFER` (`src/git.ts`, 64 MiB) fails here and is
 * answered 404. That is above the 250 MiB a deployment lets a whole repository
 * be and well above anything a page offers a link to; a file past it is one to
 * clone. Streaming it would mean handing a subprocess's stdout to a response,
 * which is the shape `git-backend.ts` has and this module deliberately does
 * not.
 */
export async function readBlob(
  gitDir: string,
  rev: string,
  path: string,
): Promise<Uint8Array | null> {
  if (path === '') return null
  const res = gitBytes(['cat-file', 'blob'], { gitDir, operands: [`${rev}:${path}`] })
  return res.status === 0 ? res.stdout : null
}

/**
 * The field separator inside one `git log` record, and the record separator
 * between them.
 *
 * Unit and record separators rather than anything a human types: a commit
 * subject is arbitrary text a pusher chose, and every printable delimiter is
 * one somebody can put in a subject line and split a record with.
 */
const FIELD = '\x1f'
const RECORD = '\x1e'

/**
 * One page of history walking back from `before` when the reader is paging, or
 * from `rev` when they are not. `null` when git cannot walk it.
 *
 * `--no-walk` is deliberately NOT used: this is the first-parent-and-all
 * history a reader expects of a branch. `limit` is the caller's bound
 * (`LOG_PAGE`), because the bound is on what one request may do.
 *
 * The cursor is the LAST oid the previous page showed rather than the first one
 * it did not, so a next page is built only from commits the reader has actually
 * been shown. That makes it inclusive to git and exclusive to a reader, which
 * is reconciled here: one extra commit is asked for and the cursor itself is
 * dropped. It is validated as a full oid before it ever arrives
 * (`src/http.ts`), which is belt to this module's braces — like every other
 * revision it goes in as an operand.
 */
export async function listCommits(
  gitDir: string,
  rev: string,
  before: string | null,
  limit: number,
): Promise<Commit[] | null> {
  // Defence in depth on the one argument that comes from a query parameter:
  // the handler has refused anything but a full oid already, and this refuses
  // it again rather than trusting that it did.
  if (before !== null && !OID.test(before)) return null
  const res = git(
    [
      'log',
      `--max-count=${before === null ? limit : limit + 1}`,
      `--format=%H${FIELD}%an <%ae>${FIELD}%aI${FIELD}%s${RECORD}`,
    ],
    { gitDir, operands: [before ?? rev] },
  )
  if (res.status !== 0) return null
  const commits: Commit[] = []
  for (const record of res.stdout.split(RECORD)) {
    const line = record.trim()
    if (line === '') continue
    const [oid, author, date, subject] = line.split(FIELD)
    if (!oid || author === undefined || date === undefined) continue
    // The cursor commit itself: already shown on the page that named it.
    if (oid === before) continue
    commits.push({ oid, author, date, subject: subject ?? '' })
  }
  return commits
}
