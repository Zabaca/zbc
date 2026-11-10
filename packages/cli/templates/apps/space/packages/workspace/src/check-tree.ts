/**
 * The plumbing the folder's two checks share: which files they read, how a hit is shaped, how hits are grouped by package and printed.
 *
 * A check is a pure function from one file's path and text to hits (`public-check.ts` is one). This file is everything around it: listing the tracked text files of a tree, skipping binaries and
 * build output, and the report (hits grouped by package, or `--summary` counts by package and kind). Nothing here knows what a check looks for.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, sep } from 'node:path'

export type Hit = {
  /** Path of the file, relative to the tree that was scanned. */
  path: string
  /** 1-based. */
  line: number
  /** The kind of finding; a check names its own kinds. */
  kind: string
  /** What exactly was found, in a few words. */
  detail: string
  /** The offending line, as it is in the file. */
  text: string
}

export type SourceFile = { path: string; text: string }

/** A check as the report sees it: one file in, its hits out. */
export type Check = (file: SourceFile) => Hit[]

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// What is scanned
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * What is scanned of the space's own folder (the one that holds `packages/` and `kit/`): all of it, the README, the licence and the manifest included. A tree handed to a check by path is scanned whole
 * too.
 */
export const SPACE_TARGETS = ['.'] as const

/** Directories that hold what a build made or what was installed, never the code's own text. */
export const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', '.wrangler', '.astro', '.svelte-kit', '.next', '.turbo', '.output', '.cache', 'coverage', '.git', 'test-results', 'playwright-report'])

/** Files that hold a secret by convention: never read, so a report can never print one. */
const SECRET_FILE = /^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|.*\.pem|.*\.key)$/

/** Extensions of files that are not text. A file with a NUL byte near its start is binary whatever its name. */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.icns', '.bmp', '.tiff', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.pdf', '.wasm', '.mp3', '.mp4', '.mov', '.webm', '.ogg', '.wav',
  '.m4a', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.bin', '.db', '.sqlite', '.duckdb', '.der', '.p12', '.pfx', '.lockb',
])

/** A file over this is generated data, not code someone wrote or a line someone would read; it is counted as skipped, never silently. */
export const MAX_FILE_BYTES = 2_000_000

export type Skipped = { binary: number; large: number }

/** Reads one file as text, or says why not. */
export const readTextFile = (absolute: string): { text: string } | { skipped: keyof Skipped } => {
  if (BINARY_EXTENSIONS.has(extname(absolute).toLowerCase())) return { skipped: 'binary' }
  if (SECRET_FILE.test(basename(absolute))) return { skipped: 'binary' }
  const size = statSync(absolute).size
  if (size > MAX_FILE_BYTES) return { skipped: 'large' }
  const bytes = readFileSync(absolute)
  if (bytes.subarray(0, 8192).includes(0)) return { skipped: 'binary' }
  return { text: bytes.toString('utf8') }
}

/** The tracked files under `folder`, relative to it, or null when `folder` is not in a git repository. */
const trackedFiles = (folder: string): string[] | null => {
  const run = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '.'], { cwd: folder, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (run.status !== 0) return null
  return run.stdout.split('\0').filter(Boolean)
}

const walk = (folder: string, prefix = ''): string[] => {
  const found: string[] = []
  for (const entry of readdirSync(join(folder, prefix), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) found.push(...walk(folder, join(prefix, entry.name)))
    } else if (entry.isFile()) found.push(join(prefix, entry.name))
  }
  return found
}

/** True for a path with a skipped directory anywhere in it (a tracked build folder is still build output). */
const inSkippedDirectory = (path: string) => path.split('/').some((part) => SKIPPED_DIRECTORIES.has(part))

/** A scan root that is not a folder: the report would otherwise read as clean because nothing was looked at. */
export class MissingRoot extends Error {}

/**
 * Every text file under each root of `repoRoot`, with paths relative to `repoRoot`. Files git tracks (or would track: untracked and not ignored) when the root is in a repository, so ignored files such as an
 * `.env` are never opened; every file when it is not. A root that is not a folder throws `MissingRoot`.
 */
export const readTree = (repoRoot: string, roots: readonly string[]): { files: SourceFile[]; skipped: Skipped } => {
  const files: SourceFile[] = []
  const skipped: Skipped = { binary: 0, large: 0 }
  for (const root of roots) {
    const folder = join(repoRoot, root)
    if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new MissingRoot(`not a folder: ${folder}`)
    const listed = trackedFiles(folder) ?? walk(folder)
    for (const inner of listed.sort()) {
      const path = join(root, inner).split(sep).join('/')
      if (inSkippedDirectory(inner)) continue
      let read: ReturnType<typeof readTextFile>
      try {
        read = readTextFile(join(folder, inner))
      } catch {
        continue // listed but gone (a deletion not yet staged)
      }
      if ('skipped' in read) skipped[read.skipped]++
      else files.push({ path, text: read.text })
    }
  }
  return { files, skipped }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The package a path belongs to, for grouping. `packages/<name>/...` is `<name>`, except the kit (`kit/`), which is `space-kit`. Any other path is grouped by its first folder, which is
 * how the public copy will read (a folder of packages), so the same report works there.
 */
export const packageOf = (path: string): string => {
  const parts = path.split('/')
  if (parts[0] === 'packages') {
    return parts[1] ?? '(root)'
  }
  return parts.length > 1 ? (parts[0] ?? '(root)') : '(root)'
}

export const runCheck = (check: Check, files: SourceFile[]): Hit[] => files.flatMap((file) => check(file))

const trimmed = (text: string, width = 140) => {
  const flat = text.trim().replace(/\s+/g, ' ')
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`
}

const countBy = <T>(items: T[], key: (item: T) => string): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1)
  return counts
}

/** Counts per package and per kind, and the totals, as the `--summary` table prints them. */
export const summarize = (hits: Hit[]) => {
  const kinds = [...new Set(hits.map((hit) => hit.kind))].sort()
  const packages = [...new Set(hits.map((hit) => packageOf(hit.path)))].sort()
  const byPackage = packages.map((name) => {
    const own = hits.filter((hit) => packageOf(hit.path) === name)
    const perKind = countBy(own, (hit) => hit.kind)
    return {
      name,
      hits: own.length,
      lines: new Set(own.map((hit) => `${hit.path}:${hit.line}`)).size,
      files: new Set(own.map((hit) => hit.path)).size,
      kinds: Object.fromEntries(kinds.map((kind) => [kind, perKind.get(kind) ?? 0])),
    }
  })
  return {
    kinds,
    byPackage,
    totals: {
      hits: hits.length,
      lines: new Set(hits.map((hit) => `${hit.path}:${hit.line}`)).size,
      files: new Set(hits.map((hit) => hit.path)).size,
      kinds: Object.fromEntries(kinds.map((kind) => [kind, hits.filter((hit) => hit.kind === kind).length])),
    },
  }
}

const table = (rows: string[][]) => {
  const widths = (rows[0] ?? []).map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length)))
  return rows.map((row) => row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!))).join('  ')).join('\n')
}

export type Scanned = { checked: number; skipped: Skipped }

const scannedLine = (name: string, scanned: Scanned, hits: Hit[]) => {
  const { totals } = summarize(hits)
  return `${name}: ${totals.hits} hit(s) on ${totals.lines} line(s) in ${totals.files} of ${scanned.checked} text file(s) (skipped ${scanned.skipped.binary} binary, ${scanned.skipped.large} over ${MAX_FILE_BYTES / 1_000_000} MB)`
}

/** The whole report: with `summary`, the scanned line and a table of counts per package and kind; without, the hits grouped by package, file and line, then the same table. */
export const formatReport = (name: string, hits: Hit[], scanned: Scanned, options: { summary: boolean }): string => {
  const { kinds, byPackage, totals } = summarize(hits)
  const out: string[] = []
  if (!options.summary) {
    for (const group of byPackage) {
      out.push(`\n== ${group.name} (${group.hits} hit(s) on ${group.lines} line(s) in ${group.files} file(s))`)
      let current = ''
      for (const hit of hits.filter((candidate) => packageOf(candidate.path) === group.name)) {
        if (hit.path !== current) {
          current = hit.path
          out.push(hit.path)
        }
        out.push(`  ${String(hit.line).padStart(5)}  ${hit.kind.padEnd(8)} ${hit.detail}  |  ${trimmed(hit.text)}`)
      }
    }
    out.push('')
  }
  out.push(scannedLine(name, scanned, hits))
  if (hits.length > 0) {
    out.push('')
    out.push(
      table([
        ['package', 'hits', 'lines', 'files', ...kinds],
        ...byPackage.map((group) => [group.name, String(group.hits), String(group.lines), String(group.files), ...kinds.map((kind) => String(group.kinds[kind]))]),
        ['total', String(totals.hits), String(totals.lines), String(totals.files), ...kinds.map((kind) => String(totals.kinds[kind]))],
      ]),
    )
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The command line, shared by both checks
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/** Where a command writes: the console, or a test's capture. */
export type Output = { out: (line: string) => void; err: (line: string) => void }

/**
 * Runs a check from a command line and returns the process's exit code. `--summary` prints counts only; `--strict` exits 1 when there is any hit, and also when no file was checked at all (a scan that looked at
 * nothing is not a pass). Exit 2 is a usage error: a folder that does not exist. Arguments that are not flags name folders to scan whole; with none, the space's own folders (`SPACE_TARGETS`) of `repoRoot` are scanned.
 * Without `--strict` it only reports and exits 0.
 */
export const runCommand = (name: string, check: Check, argv: string[], repoRoot: string, io: Output = { out: console.log, err: console.error }): number => {
  const summary = argv.includes('--summary')
  const strict = argv.includes('--strict')
  const flags = argv.filter((arg) => arg.startsWith('--'))
  const unknown = flags.filter((flag) => flag !== '--summary' && flag !== '--strict')
  if (unknown.length > 0) {
    io.err(`${name}: unknown option ${unknown.join(', ')} (known: --summary, --strict)`)
    return 2
  }
  const folders = argv.filter((arg) => !arg.startsWith('--'))
  const files: SourceFile[] = []
  const skipped: Skipped = { binary: 0, large: 0 }
  try {
    const scan = (root: string, roots: readonly string[]) => {
      const read = readTree(root, roots)
      files.push(...read.files)
      skipped.binary += read.skipped.binary
      skipped.large += read.skipped.large
    }
    if (folders.length === 0) scan(repoRoot, SPACE_TARGETS)
    // A folder given by path is scanned whole, and its files are named relative to it.
    for (const folder of folders) scan(folder, ['.'])
  } catch (error) {
    if (!(error instanceof MissingRoot)) throw error
    io.err(`${name}: ${error.message}`)
    return 2
  }
  const hits = runCheck(check, files)
  io.out(formatReport(name, hits, { checked: files.length, skipped }, { summary }))
  if (strict && files.length === 0) {
    io.err(`${name}: no file was checked, so nothing is proved`)
    return 1
  }
  return strict && hits.length > 0 ? 1 : 0
}
