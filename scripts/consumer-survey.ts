#!/usr/bin/env bun
/**
 * What have zbc's consumers had to write themselves?
 *
 * Every consumer repo is a record of where zbc fell short: a module someone
 * wrote because there was no built-in, an edit to a built-in that did not do
 * what they needed, a shell script that gave up on `defineModule` entirely.
 * This collects that record so it can be mined for the next module and the
 * next module upgrade. It decides nothing — it produces the evidence a
 * reviewer reasons over.
 *
 * **The whole design is one distinction: divergence versus staleness.**
 * A copy-mode consumer's `cloudflare` is 400 diff-lines off this repo's
 * `cloudflare` — and almost all of that is not their idea, it is *our own
 * module from last year*, frozen at whatever `zbc add` copied. Diffing against
 * HEAD makes every stale copy look like a rich source of ideas, and a reviewer
 * who trusts that reads our own history back to us as consumer feedback.
 *
 * So every consumer module is hashed against **every historical revision** of
 * the template of the same name, not just its current one:
 *
 *   - matches some past revision exactly → `stale`. Teaches nothing. The fix
 *     is an upgrade on their side and there is no zbc change to make.
 *   - matches no revision → `divergent`. Someone edited our module. That edit
 *     is a patch already written against our own interface.
 *   - no upstream module of that name exists → `novel`. A resource we have no
 *     module for, and they needed it enough to build one.
 *
 * Only `divergent` and `novel` are material. Everything else is noise this
 * exists to remove, and on the first run it removes most of the corpus.
 */
import { spawnSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

export type Verdict = 'current' | 'stale' | 'divergent' | 'novel'

/** One historical revision of one upstream module file. */
export interface Revision {
  rev: string
  /** Where the file lived at `rev` — modules moved, so `git show <rev>:<file>` needs both. */
  file?: string
  /** Author date, YYYY-MM-DD. Only the oldest one is used, and see below. */
  date: string
  hash: string
  /** Hash of the normalised form, so a reformat still matches its ancestor. */
  normalizedHash: string
  content: string
}

/**
 * Strip the axes a formatter owns: quote style, trailing semicolons and
 * commas, indentation, blank lines.
 *
 * A consumer whose repo runs prettier while ours runs biome produces a file
 * that differs on every line and means nothing by any of it. crux's
 * `cloudflare` was exactly this — 0.538 similarity, zero real edits — and
 * without this it lands as `divergent`, the one verdict the whole exercise
 * treats as material. Comments are deliberately kept: a consumer's comment is
 * often the finding.
 */
export function normalize(source: string): string {
  return source
    .replace(/"/g, "'")
    .split('\n')
    .map((l) => l.trim().replace(/[;,]+$/, ''))
    .filter((l) => l.length > 0)
    .join('\n')
}

export interface Classification {
  verdict: Verdict
  /** True when the match needed normalisation — a reformat, not an edit. */
  formattingOnly?: boolean
  /** Set when `stale`: the upstream revision this is a verbatim copy of. */
  matchedRev?: string
  matchedPath?: string
  /** Set when `divergent`: the revision to diff against, i.e. the closest one. */
  nearestRev?: string
  /** Where that revision's file lived: `git show <nearestRev>:<nearestPath>`. */
  nearestPath?: string
  /** Set when `divergent`: 0..1 line overlap with `nearestRev`. */
  similarity?: number
}

export function hash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

export function revision(rev: string, content: string, date = '', file?: string): Revision {
  return {
    rev,
    file,
    date,
    hash: hash(content),
    normalizedHash: hash(normalize(content)),
    content,
  }
}

/**
 * Line-set overlap, 0..1 — Jaccard over non-blank trimmed lines.
 *
 * Only used to pick which historical revision a divergent file is closest to,
 * so a reviewer diffs against the version the consumer actually started from
 * rather than against HEAD. Nothing branches on the value itself.
 */
function meaningfulLines(source: string): Set<string> {
  return new Set(
    source
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  )
}

export function similarity(a: string, b: string): number {
  const [x, y] = [meaningfulLines(a), meaningfulLines(b)]
  if (x.size === 0 && y.size === 0) return 1
  let shared = 0
  for (const line of x) if (y.has(line)) shared++
  return shared / (x.size + y.size - shared)
}

/**
 * Where does one consumer module sit relative to the upstream module of the
 * same name? `history` is every revision of that upstream file, newest first;
 * an empty history means no such built-in has ever existed. `shipped` is false
 * when main has since deleted the module, so even its last revision is stale.
 */
export function classify(content: string, history: Revision[], shipped = true): Classification {
  if (history.length === 0) return { verdict: 'novel' }
  const isNewest = (r: Revision) => shipped && r.rev === history[0].rev

  const h = hash(content)
  const exact = history.find((r) => r.hash === h)
  if (exact) {
    // Verbatim either way — but a copy of the newest revision is up to date,
    // while a copy of an older one is upgrade debt on the consumer's side.
    return {
      verdict: isNewest(exact) ? 'current' : 'stale',
      matchedRev: exact.rev,
      matchedPath: exact.file,
    }
  }

  // Not byte-identical, but a reformat is not an edit.
  const nh = hash(normalize(content))
  const reformatted = history.find((r) => r.normalizedHash === nh)
  if (reformatted) {
    return {
      verdict: isNewest(reformatted) ? 'current' : 'stale',
      matchedRev: reformatted.rev,
      matchedPath: reformatted.file,
      formattingOnly: true,
    }
  }

  let nearest = history[0]
  let best = -1
  for (const rev of history) {
    const score = similarity(content, rev.content)
    if (score > best) {
      best = score
      nearest = rev
    }
  }
  return {
    verdict: 'divergent',
    nearestRev: nearest.rev,
    nearestPath: nearest.file,
    similarity: Number(best.toFixed(3)),
  }
}

/**
 * Top-level keys of a `z.object({ … })` assigned to `field`.
 *
 * This is the convergence signal: when five consumers each wrote their own
 * `d1`, the keys they all chose are the interface and the keys only one chose
 * are the config surface. Brace-matched rather than parsed — it reads a shape
 * we author ourselves, and a module whose schema is built some other way
 * simply reports no keys rather than a wrong answer.
 */
export function schemaKeys(source: string, field: string): string[] {
  const marker = `${field}: z.object(`
  const open = source.indexOf(marker)
  if (open === -1) return []
  let i = source.indexOf('{', open + marker.length) // the object literal inside z.object(
  if (i === -1) return []
  let depth = 0
  const keys: string[] = []
  let line = ''
  for (; i < source.length; i++) {
    const c = source[i]
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') {
      depth--
      if (depth === 0) break
    }
    if (c === '\n') {
      if (depth === 1) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/)
        if (m) keys.push(m[1])
      }
      line = ''
    } else line += c
  }
  return keys
}

/** Provider CLIs a module should have wrapped. A hit outside a module is a gap. */
const PROVIDER_CLIS = [
  'wrangler',
  'flyctl',
  'fly ',
  'turso ',
  'gcloud',
  'vercel ',
  'aws ',
  'incus ',
  // Not a provider, but a resource no module declares.
  'gh api',
]

/**
 * A `sops` call, which `zbc secret get` replaces: `sops` then any option but
 * --version/--help, a subcommand, or a `\` continuation; or 'sops' as argv[0].
 * Matched by shape, not by the word, which is mostly error text and
 * `command -v` guards.
 */
export const SOPS_CALL =
  /\bsops(?:\s+(?:-{1,2}(?!(?:version|help|v|h)\b)[A-Za-z]|(?:decrypt|encrypt|exec-env|exec-file|set|unset|edit|updatekeys|rotate|filestatus|publish|keyservice|groups)\b)|\s*\\\s*$)|\[\s*['"]sops['"]\s*,|\b(?:spawn|exec)\w*\(\s*['"]sops['"]/

export interface EscapeHatch {
  file: string
  line: number
  tool: string
  snippet: string
}

/**
 * Provider CLI calls living outside `packages/infra/modules/`.
 *
 * The rarest and most valuable finding: not "the built-in was wrong" but
 * "nobody tried to write a module at all". That points at `defineModule`
 * rather than at any one module.
 *
 * `ours` is every line zbc's own workflows have had: `zbc init --ci github`
 * copies them into a consumer's .github/, so a call there can be our code —
 * the same rule the module index applies.
 */
export function findEscapeHatches(
  files: { path: string; content: string }[],
  ours: Set<string> = new Set(),
): EscapeHatch[] {
  const hatches: EscapeHatch[] = []
  for (const file of files) {
    if (file.path.includes('/modules/') || file.path.includes('node_modules')) continue
    const hashComments = /\.(sh|ya?ml)$/.test(file.path)
    file.content.split('\n').forEach((text, idx) => {
      const tool = PROVIDER_CLIS.find((t) => text.includes(t)) ?? (SOPS_CALL.test(text) && 'sops')
      if (!tool) return
      const t = text.trim()
      if (t.startsWith('*') || t.startsWith('//') || (hashComments && t.startsWith('#'))) return
      if (file.path.startsWith('.github/') && ours.has(t)) return
      hatches.push({
        file: file.path,
        line: idx + 1,
        tool: tool.trim(),
        snippet: text.trim().slice(0, 200),
      })
    })
  }
  return hatches
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dir, '..')
const TEMPLATE_MODULES = 'packages/cli/templates/infra/modules'
const WORK = path.join(REPO_ROOT, '.consumer-survey')

function run(cmd: string, args: string[], cwd?: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr?.trim()}`)
  return r.stdout
}

function tryRun(cmd: string, args: string[], cwd?: string): string | null {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return r.status === 0 ? r.stdout : null
}

/**
 * Everywhere a built-in's source has lived. Modules sat in packages/infra/ and
 * packages/cli/modules/ before settling under templates/ (d82840f), and some
 * were deleted outright (vercel in feee322, nats-server). A consumer's copy of
 * either is still our code: indexing only what main ships today reported ceo's
 * byte-identical `vercel` as a consumer idea.
 */
const MODULE_HOMES = [TEMPLATE_MODULES, 'packages/cli/modules', 'packages/infra/modules']
const MODULE_FILE = new RegExp(`^(?:${MODULE_HOMES.join('|')})/([^/]+)/index\\.ts$`)

/** `git log --format='@%H %ad' --name-only` → one entry per module file per commit. */
export function parseModuleLog(
  log: string,
): { rev: string; date: string; file: string; name: string }[] {
  const entries: { rev: string; date: string; file: string; name: string }[] = []
  let rev = ''
  let date = ''
  for (const line of log.split('\n')) {
    if (line.startsWith('@')) {
      ;[rev, date] = line.slice(1).split(' ')
      continue
    }
    const m = line.match(MODULE_FILE)
    if (m && rev) entries.push({ rev, date, file: line, name: m[1] })
  }
  return entries
}

/** Every revision of every built-in module's `index.ts` main has ever had, newest first. */
export function buildAncestorIndex(repoRoot = REPO_ROOT): Record<string, Revision[]> {
  const log = run(
    'git',
    [
      'log',
      '--format=@%H %ad',
      '--date=short',
      '--name-only',
      // Without this a merge lists no files, and a blob only a merge produced
      // (two clean edits to one index.ts) is never indexed. `combined` lists a
      // path only when it differs from every parent, so a merge that just
      // carries a branch's blob over is not indexed a second time under its own rev.
      '--diff-merges=combined',
      '--',
      ...MODULE_HOMES.map((home) => `${home}/*/index.ts`),
    ],
    repoRoot,
  )
  const index: Record<string, Revision[]> = {}
  for (const { rev, date, file, name } of parseModuleLog(log)) {
    const content = tryRun('git', ['show', `${rev}:${file}`], repoRoot)
    if (content === null)
      continue // the commit that deleted it, or moved it away
    ;(index[name] ??= []).push(revision(rev, content, date, file))
  }
  return index
}

/** The built-ins HEAD ships. The ancestor index also holds ones it has deleted. */
export function shippedModules(repoRoot = REPO_ROOT): Set<string> {
  // From HEAD, not the worktree: git leaves a deleted module's directory behind
  // while it still holds an ignored file (.DS_Store, node_modules).
  const files = run(
    'git',
    ['ls-tree', '-r', '--name-only', 'HEAD', '--', TEMPLATE_MODULES],
    repoRoot,
  )
  return new Set(files.split('\n').flatMap((f) => f.match(MODULE_FILE)?.[1] ?? []))
}

/**
 * Every line zbc's own workflows have ever had — the templates `zbc init --ci
 * github` copies, and this repo's workflows they were drawn from.
 */
export function workflowLines(repoRoot = REPO_ROOT): Set<string> {
  const log = run(
    'git',
    [
      'log',
      '--format=@%H',
      '--name-only',
      '--diff-merges=combined',
      '--',
      'packages/cli/templates/workflows/*.yml',
      '.github/workflows/*.yml',
    ],
    repoRoot,
  )
  const lines = new Set<string>()
  let rev = ''
  for (const line of log.split('\n')) {
    if (line.startsWith('@')) rev = line.slice(1)
    else if (line && rev) {
      for (const l of tryRun('git', ['show', `${rev}:${line}`], repoRoot)?.split('\n') ?? []) {
        if (l.trim()) lines.add(l.trim())
      }
    }
  }
  return lines
}

interface Consumer {
  id: string
  repo: string | null
  access: string
  mode: string
  tier: string
  /** Where zbc.config.ts sits, when it is not the repo root (varnick keeps it in `deploy/`). */
  root?: string
}

/** Get a consumer's tree on disk at its default branch: `checkout` is the repo, `dir` the zbc project. */
function fetchConsumer(c: Consumer): { checkout: string; dir: string; ref: string } {
  const { dir: checkout, ref } = fetchCheckout(c)
  return { checkout, ref, dir: path.join(checkout, c.root ?? '') }
}

/** Where escape hatches are looked for: the zbc project's, and the repo's own scripts and workflows. */
export function hatchDirs(root = ''): string[] {
  const inRoot = (sub: string) => path.posix.join(root, sub)
  return [...new Set(['scripts', inRoot('scripts'), inRoot('packages/infra'), '.github'])]
}

/** Run `cmd` with its stdout written to `file`: binary-safe, and its exit status checked. */
function runToFile(cmd: string, args: string[], file: string): void {
  const fd = fs.openSync(file, 'w')
  try {
    const r = spawnSync(cmd, args, { stdio: ['ignore', fd, 'pipe'], encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr?.trim()}`)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Unpack a git archive into `dir`. Through a file, not a shell pipe: a pipe
 * hides git's exit status, and bsdtar exits 0 on empty input.
 */
function extractArchive(dir: string, archive: (tarPath: string) => void): void {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const tarPath = `${dir}.tar` // beside the checkout, under the gitignored repos/
  try {
    archive(tarPath)
    run('tar', ['-xf', tarPath, '-C', dir])
  } finally {
    fs.rmSync(tarPath, { force: true })
  }
}

function fetchCheckout(c: Consumer): { dir: string; ref: string } {
  const dir = path.join(WORK, 'repos', c.id)
  fs.mkdirSync(path.dirname(dir), { recursive: true })

  if (c.access === 'github') {
    if (!c.repo) throw new Error(`${c.id}: access is github but no repo`)
    const url = `git@github.com:${c.repo}.git`
    if (fs.existsSync(path.join(dir, '.git'))) {
      // A consumer that moved host keeps its old clone here; follow the registry, not the cache.
      run('git', ['remote', 'set-url', 'origin', url], dir)
      run('git', ['fetch', '--depth', '1', 'origin', 'HEAD'], dir)
      run('git', ['reset', '--hard', 'FETCH_HEAD'], dir)
    } else {
      // A consumer that was local: or ssh: before leaves an archive here, and
      // clone refuses a directory that is not empty.
      fs.rmSync(dir, { recursive: true, force: true })
      run('git', ['clone', '--depth', '1', url, dir])
    }
    return { dir, ref: run('git', ['rev-parse', 'HEAD'], dir).trim() }
  }

  // local:<path> — a repo on this machine with no remote we can clone. agent-lab's
  // agentgit.co credential helper lives in its checkout's own git config, so a fresh
  // clone cannot authenticate.
  if (c.access.startsWith('local:')) {
    const local = c.access.slice('local:'.length).replace(/^~(?=\/|$)/, process.env.HOME ?? '~')
    // Resolve HEAD once and archive that commit, so the recorded ref is the tree surveyed.
    const ref = run('git', ['-C', local, 'rev-parse', 'HEAD']).trim()
    extractArchive(dir, (tar) =>
      run('git', ['-C', local, 'archive', '--format=tar', '-o', tar, ref]),
    )
    return { dir, ref }
  }

  // ssh:<host>:<path> — a repo with no remote, read straight off the machine.
  const m = c.access.match(/^ssh:([^:]+):(.+)$/)
  if (!m) throw new Error(`${c.id}: unrecognised access ${c.access}`)
  const [, host, remotePath] = m
  const ref = run('ssh', [host, `git -C ${remotePath} rev-parse HEAD`]).trim()
  extractArchive(dir, (tar) =>
    runToFile('ssh', [host, `git -C ${remotePath} archive --format=tar ${ref}`], tar),
  )
  return { dir, ref }
}

function readTextFiles(root: string, subdirs: string[]): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = []
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        walk(full)
      } else if (/\.([cm]?[tj]s|json|ya?ml|sh)$/.test(entry.name)) {
        out.push({ path: path.relative(root, full), content: fs.readFileSync(full, 'utf8') })
      }
    }
  }
  for (const sub of subdirs) walk(path.join(root, sub))
  return out
}

export interface ModuleFinding {
  name: string
  /** `own` = they wrote it; `vendored` = it came from the subtree and was edited. */
  location: 'own' | 'vendored'
  path: string
  lines: number
  configKeys: string[]
  outputKeys: string[]
  verdict: Verdict
  formattingOnly?: boolean
  /**
   * When the upstream module of this name was first committed.
   *
   * A `divergent` verdict silently assumes the consumer forked our module. That
   * is false when ours is the younger one: `cloudflare-access` entered the
   * templates on 2026-08-19 by promoting foundry's, and leeandco's copy already
   * existed — so its `nearestRev` is not a fork point and diffing against it
   * compares two independent implementations as though one derived from the
   * other. Surfacing the date is what lets a reviewer catch that.
   */
  upstreamFirstSeen?: string
  /** Set when main once shipped a module of this name and has since deleted it. */
  upstreamDeleted?: true
  matchedRev?: string
  matchedPath?: string
  nearestRev?: string
  nearestPath?: string
  similarity?: number
}

function surveyModules(
  dir: string,
  index: Record<string, Revision[]>,
  shipped: Set<string>,
): ModuleFinding[] {
  const roots: [string, 'own' | 'vendored'][] = [
    ['packages/infra/modules', 'own'],
    ['vendor/zbc/modules', 'vendored'],
  ]
  const findings: ModuleFinding[] = []
  for (const [rel, location] of roots) {
    const base = path.join(dir, rel)
    if (!fs.existsSync(base)) continue
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = path.join(base, entry.name, 'index.ts')
      if (!fs.existsSync(file)) continue
      const content = fs.readFileSync(file, 'utf8')
      findings.push({
        name: entry.name,
        location,
        path: `${rel}/${entry.name}/index.ts`,
        lines: content.split('\n').length,
        configKeys: schemaKeys(content, 'configSchema'),
        outputKeys: schemaKeys(content, 'outputs'),
        upstreamFirstSeen: index[entry.name]?.at(-1)?.date,
        ...(index[entry.name] && !shipped.has(entry.name) && { upstreamDeleted: true }),
        ...classify(content, index[entry.name] ?? [], shipped.has(entry.name)),
      })
    }
  }
  return findings
}

function surveyEnvironments(dir: string): Record<string, string[]> {
  const base = path.join(dir, 'packages/infra/environments')
  if (!fs.existsSync(base)) return {}
  const envs: Record<string, string[]> = {}
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    envs[entry.name] = fs
      .readdirSync(path.join(base, entry.name))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => f.replace(/\.ts$/, ''))
  }
  return envs
}

function main() {
  const registry = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'docs/consumers/registry.json'), 'utf8'),
  )
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const consumers: Consumer[] = registry.consumers.filter(
    (c: Consumer) => c.tier !== 'self' && (only.length === 0 || only.includes(c.id)),
  )

  fs.mkdirSync(WORK, { recursive: true })
  console.error('indexing template history…')
  const index = buildAncestorIndex()
  const shipped = shippedModules()
  const ours = workflowLines()

  const rollup: Record<string, unknown>[] = []
  for (const c of consumers) {
    console.error(`surveying ${c.id}…`)
    let survey: Record<string, unknown>
    try {
      const { checkout, dir, ref } = fetchConsumer(c)
      // Paths are reported from the checkout root, where the skill and the cases resolve them.
      const modules = surveyModules(dir, index, shipped).map((m) => ({
        ...m,
        path: path.posix.join(c.root ?? '', m.path),
      }))
      survey = {
        id: c.id,
        repo: c.repo,
        root: c.root,
        mode: c.mode,
        tier: c.tier,
        ref,
        surveyedAt: new Date().toISOString(),
        environments: surveyEnvironments(dir),
        modules,
        escapeHatches: findEscapeHatches(readTextFiles(checkout, hatchDirs(c.root)), ours),
      }
    } catch (err) {
      survey = { id: c.id, error: String(err instanceof Error ? err.message : err) }
    }
    fs.writeFileSync(path.join(WORK, `${c.id}.json`), `${JSON.stringify(survey, null, 2)}\n`)
    rollup.push(survey)
  }

  // Group the material by module name — the deliverable is per module, not per repo.
  const byModule: Record<string, unknown[]> = {}
  for (const s of rollup) {
    for (const m of (s.modules as ModuleFinding[] | undefined) ?? []) {
      if (m.verdict === 'current' || m.verdict === 'stale') continue
      ;(byModule[m.name] ??= []).push({ consumer: s.id, ...m })
    }
  }
  const cases = Object.entries(byModule)
    .map(([name, impls]) => ({
      module: name,
      kind: shipped.has(name) ? 'upgrade' : index[name] ? 'deleted-upstream' : 'new',
      consumers: impls.length,
      implementations: impls,
    }))
    .toSorted((a, b) => b.consumers - a.consumers)

  fs.writeFileSync(path.join(WORK, 'index.json'), `${JSON.stringify({ cases }, null, 2)}\n`)

  const all = rollup.flatMap((s) => (s.modules as ModuleFinding[]) ?? [])
  const count = (v: Verdict) => all.filter((m) => m.verdict === v).length
  console.error(
    `\n${all.length} consumer modules: ${count('current')} current, ${count('stale')} stale, ` +
      `${count('divergent')} divergent, ${count('novel')} novel`,
  )
  console.error(`${cases.length} cases → ${path.relative(REPO_ROOT, WORK)}/index.json`)
}

if (import.meta.main) main()
