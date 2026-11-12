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

import {
  OID,
  type Commit,
  type CompareFile,
  type CompareStatus,
  type Comparison,
  type TreeEntry,
} from '../shared/browse'
import { git, gitBounded, gitBytes } from './git'

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

/** The bounds one compare works under. The handler's, like `LOG_PAGE`. */
export interface CompareLimits {
  maxFiles: number
  maxDiffBytes: number
  /** Wall-clock budget for every git command of one compare, together. */
  timeoutMs: number
}

/** A comparison, with the two commits it was read at. */
export type CompareResult = Comparison & { peeled: { base: string; head: string } }

/**
 * How much summary one compare will read: 16 MiB of `--raw --numstat -z`,
 * which is on the order of a hundred thousand changed files. Past it the
 * records cannot be trusted to pair up, so the compare is refused rather than
 * answered with counts that silently stopped.
 */
const SUMMARY_MAX_BYTES = 16 * 1024 * 1024

/**
 * The flags every diff below runs with, whatever the repository's own config.
 *
 * `-M` because a rename shown as a delete and an add is the wrong review, and
 * git's `diff.renames` default is a config this process should not depend on.
 * No colour, no external diff driver and no textconv: the output is read by a
 * program, and a driver is a command the repository could name.
 */
const DIFF_FLAGS = ['-M', '--no-color', '--no-ext-diff', '--no-textconv']

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

/**
 * The head against its merge base with the base — three-dot, the diff a review
 * reads.
 *
 * `null` when the Cache cannot resolve one of the two to a commit;
 * `'unrelated'` when they share no history and there is no merge base to diff
 * against; `'too-large'` when the comparison cannot be computed inside the
 * bounds at all — the time budget ran out, or the summary alone overran.
 *
 * Four commands, all under one deadline: `rev-parse` to peel each side to its
 * commit (an annotated tag names a tag object), `merge-base`, one `diff --raw
 * --numstat -z` for the whole summary, and one `diff` for the text. The
 * summary line-diffs every changed file to count it, so it is not free — it is
 * read whole so the totals are true when the list is capped, and the deadline
 * is what bounds it. The text is limited to the listed files and cut off in
 * the subprocess at the byte cap. Both revisions are full oids by the time they
 * arrive (`src/http.ts`), and they go in as operands all the same.
 */
export async function compareRevs(
  gitDir: string,
  base: string,
  head: string,
  limits: CompareLimits,
): Promise<CompareResult | 'unrelated' | 'too-large' | null> {
  const deadline = Date.now() + limits.timeoutMs
  const run = (args: string[], limit: number, opts: Parameters<typeof gitBounded>[2] = {}) =>
    gitBounded(args, { limit, timeoutMs: Math.max(1, deadline - Date.now()) }, { gitDir, ...opts })

  const peeled: string[] = []
  for (const rev of [base, head]) {
    const res = run(['rev-parse', '--verify', '--quiet'], 4096, { operands: [`${rev}^{commit}`] })
    if (res.outcome === 'timed-out') return 'too-large'
    const oid = text(res.stdout).trim()
    if (res.outcome !== 'ok' || !OID.test(oid)) return null
    peeled.push(oid)
  }
  const [baseCommit, headCommit] = peeled as [string, string]

  const mb = run(['merge-base'], 4096, { operands: [baseCommit, headCommit] })
  if (mb.outcome === 'timed-out') return 'too-large'
  const mergeBase = text(mb.stdout).trim()
  // A failure with no output is "no common ancestor": two histories, both real.
  if (mb.outcome === 'failed' && mergeBase === '') return 'unrelated'
  if (mb.outcome !== 'ok' || !OID.test(mergeBase)) return null

  const summary = run(['diff', ...DIFF_FLAGS, '--raw', '--numstat', '-z'], SUMMARY_MAX_BYTES, {
    operands: [mergeBase, headCommit],
  })
  if (summary.outcome === 'timed-out' || summary.outcome === 'overflowed') return 'too-large'
  if (summary.outcome !== 'ok') return null
  const all = parseSummary(text(summary.stdout))
  if (all === null) return 'too-large'

  const totals = { files: all.length, additions: 0, deletions: 0 }
  for (const file of all) {
    totals.additions += file.additions
    totals.deletions += file.deletions
  }
  const files = all.slice(0, limits.maxFiles)
  const capped = files.length < all.length
  let truncated = capped

  let diff = ''
  if (files.length > 0) {
    // Only the listed files, when the list was capped — so the diff a reader
    // gets describes exactly the files they were shown. A rename needs both
    // of its paths in the pathspec or git cannot pair them. Literal pathspecs,
    // because a file may be called `*` and that is a name, not a glob.
    const paths = capped
      ? files.flatMap((file) => (file.previousPath ? [file.previousPath, file.path] : [file.path]))
      : []
    const res = run(['-c', 'core.quotePath=false', 'diff', ...DIFF_FLAGS], limits.maxDiffBytes, {
      operands: [mergeBase, headCommit],
      paths,
      env: { GIT_LITERAL_PATHSPECS: '1' },
    })
    if (res.outcome === 'timed-out') return 'too-large'
    if (res.outcome === 'failed') return null
    let bytes = res.stdout
    if (res.outcome === 'overflowed') {
      truncated = true
      // On a line boundary, so the last line shown is a whole one and a
      // multi-byte character is never split.
      bytes = bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1)
    }
    diff = text(bytes)
    // A pathspec still matches as a directory PREFIX, so a listed `a` lets an
    // unlisted `a/x` into the diff. Keep only the sections the list names.
    if (capped) diff = onlySections(diff, files)
  }

  return {
    mergeBase,
    files,
    totals,
    diff,
    truncated,
    peeled: { base: baseCommit, head: headCommit },
  }
}

/**
 * The sections of a unified diff whose `diff --git` header names a listed
 * file, in order. The header is rebuilt the way git writes it — each side
 * C-quoted on its own when it needs to be, with `core.quotePath` off so only
 * control characters, `"` and `\\` do — and compared whole.
 */
function onlySections(diff: string, files: CompareFile[]): string {
  const wanted = new Set(
    files.map(
      (file) =>
        `diff --git ${quotePath(`a/${file.previousPath ?? file.path}`)} ${quotePath(`b/${file.path}`)}`,
    ),
  )
  const sections = diff.split(/^(?=diff --git )/m)
  return sections
    .filter((section) => {
      const end = section.indexOf('\n')
      return wanted.has(end === -1 ? section : section.slice(0, end))
    })
    .join('')
}

const C_ESCAPES: Record<string, string> = {
  '\x07': 'a',
  '\b': 'b',
  '\t': 't',
  '\n': 'n',
  '\v': 'v',
  '\f': 'f',
  '\r': 'r',
  '"': '"',
  '\\': '\\',
}

/** git's `quote_c_style` with `core.quotePath=false`. */
function quotePath(name: string): string {
  let quoted = ''
  let needs = false
  for (const ch of name) {
    const code = ch.codePointAt(0)!
    if (C_ESCAPES[ch] !== undefined) {
      quoted += `\\${C_ESCAPES[ch]}`
      needs = true
    } else if (code < 0x20 || code === 0x7f) {
      quoted += `\\${code.toString(8).padStart(3, '0')}`
      needs = true
    } else {
      quoted += ch
    }
  }
  return needs ? `"${quoted}"` : name
}

/**
 * `git diff --raw --numstat -z`: every raw record, then every numstat record,
 * in the same order.
 *
 * A raw record is `:<modes> <oids> <status>` then one path, or two for a
 * rename. A numstat record is `<added>\t<deleted>\t<path>`, or for a rename
 * `<added>\t<deleted>\t` followed by the two paths as their own fields. `-`
 * for both counts is git's word for binary.
 */
function parseSummary(out: string): CompareFile[] | null {
  const fields = out.split('\0')
  const raw: { path: string; previousPath?: string; status: CompareStatus }[] = []
  const counts: { additions: number; deletions: number; binary: boolean }[] = []
  let i = 0
  while (i < fields.length) {
    const field = fields[i++]!
    if (field === '') continue
    if (field.startsWith(':')) {
      const letter = field.slice(field.lastIndexOf(' ') + 1)
      if (letter.startsWith('R') || letter.startsWith('C')) {
        const previousPath = fields[i++] ?? ''
        const path = fields[i++] ?? ''
        raw.push(
          letter.startsWith('R')
            ? { path, previousPath, status: 'renamed' }
            : // A copy is only reported under `-C`, which is not asked for; were
              // one ever to arrive, the new file is what a reviewer reads.
              { path, status: 'added' },
        )
      } else {
        const path = fields[i++] ?? ''
        raw.push({ path, status: statusOf(letter) })
      }
      continue
    }
    const [added, deleted, path] = field.split('\t')
    // A rename's numstat names its paths as the next two fields.
    if (path === '') i += 2
    const binary = added === '-' && deleted === '-'
    counts.push({
      additions: binary ? 0 : Number(added) || 0,
      deletions: binary ? 0 : Number(deleted) || 0,
      binary,
    })
  }
  // Every file has one record of each kind. Anything else is output that was
  // not read whole, and counts from it would be wrong without saying so.
  if (raw.length !== counts.length) return null
  return raw.map((file, n) => ({ ...file, ...counts[n]! }))
}

/** git's one-letter status, as the four a reviewer reads apart. */
function statusOf(letter: string): CompareStatus {
  if (letter === 'A') return 'added'
  if (letter === 'D') return 'deleted'
  // `M`, and `T` — a type change (a file become a symlink) is a modification
  // of the path as far as a review is concerned.
  return 'modified'
}
