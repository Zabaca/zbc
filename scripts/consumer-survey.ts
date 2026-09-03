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
  /** Set when `divergent`: the revision to diff against, i.e. the closest one. */
  nearestRev?: string
  /** Set when `divergent`: 0..1 line overlap with `nearestRev`. */
  similarity?: number
}

export function hash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

export function revision(rev: string, content: string, date = ''): Revision {
  return { rev, date, hash: hash(content), normalizedHash: hash(normalize(content)), content }
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
 * an empty history means no such built-in has ever existed.
 */
export function classify(content: string, history: Revision[]): Classification {
  if (history.length === 0) return { verdict: 'novel' }

  const h = hash(content)
  const exact = history.find((r) => r.hash === h)
  if (exact) {
    // Verbatim either way — but a copy of the newest revision is up to date,
    // while a copy of an older one is upgrade debt on the consumer's side.
    return { verdict: exact.rev === history[0].rev ? 'current' : 'stale', matchedRev: exact.rev }
  }

  // Not byte-identical, but a reformat is not an edit.
  const nh = hash(normalize(content))
  const reformatted = history.find((r) => r.normalizedHash === nh)
  if (reformatted) {
    return {
      verdict: reformatted.rev === history[0].rev ? 'current' : 'stale',
      matchedRev: reformatted.rev,
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
  return { verdict: 'divergent', nearestRev: nearest.rev, similarity: Number(best.toFixed(3)) }
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
]

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
 */
export function findEscapeHatches(files: { path: string; content: string }[]): EscapeHatch[] {
  const hatches: EscapeHatch[] = []
  for (const file of files) {
    if (file.path.includes('/modules/') || file.path.includes('node_modules')) continue
    file.content.split('\n').forEach((text, idx) => {
      const tool = PROVIDER_CLIS.find((t) => text.includes(t))
      if (!tool) return
      if (text.trim().startsWith('*') || text.trim().startsWith('//')) return
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

/** Every revision of every built-in module's `index.ts`, newest first. */
export function buildAncestorIndex(repoRoot = REPO_ROOT): Record<string, Revision[]> {
  const names = fs
    .readdirSync(path.join(repoRoot, TEMPLATE_MODULES), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)

  const index: Record<string, Revision[]> = {}
  for (const name of names) {
    const file = `${TEMPLATE_MODULES}/${name}/index.ts`
    const revs = run('git', ['log', '--format=%H', '--follow', '--', file], repoRoot)
      .split('\n')
      .filter(Boolean)
    index[name] = revs.flatMap((rev) => {
      const content = tryRun('git', ['show', `${rev}:${file}`], repoRoot)
      if (content === null) return []
      const date = (
        tryRun('git', ['log', '-1', '--format=%ad', '--date=short', rev], repoRoot) ?? ''
      ).trim()
      return [revision(rev, content, date)]
    })
  }
  return index
}

interface Consumer {
  id: string
  repo: string | null
  access: string
  mode: string
  tier: string
}

/** Get a consumer's tree on disk at its default branch. Returns the checkout dir. */
function fetchConsumer(c: Consumer): { dir: string; ref: string } {
  const dir = path.join(WORK, 'repos', c.id)
  fs.mkdirSync(path.dirname(dir), { recursive: true })

  if (c.access === 'github') {
    if (!c.repo) throw new Error(`${c.id}: access is github but no repo`)
    if (fs.existsSync(path.join(dir, '.git'))) {
      run('git', ['fetch', '--depth', '1', 'origin', 'HEAD'], dir)
      run('git', ['reset', '--hard', 'FETCH_HEAD'], dir)
    } else {
      run('git', ['clone', '--depth', '1', `git@github.com:${c.repo}.git`, dir])
    }
    return { dir, ref: run('git', ['rev-parse', 'HEAD'], dir).trim() }
  }

  // ssh:<host>:<path> — a repo with no remote, read straight off the machine.
  const m = c.access.match(/^ssh:([^:]+):(.+)$/)
  if (!m) throw new Error(`${c.id}: unrecognised access ${c.access}`)
  const [, host, remotePath] = m
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const tar = spawnSync(
    'sh',
    ['-c', `ssh ${host} 'cd ${remotePath} && git archive HEAD' | tar -x -C ${dir}`],
    {
      encoding: 'utf8',
    },
  )
  if (tar.status !== 0) throw new Error(`${c.id}: ssh archive failed: ${tar.stderr}`)
  const ref = spawnSync('ssh', [host, `git -C ${remotePath} rev-parse HEAD`], {
    encoding: 'utf8',
  }).stdout.trim()
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
      } else if (/\.(ts|js|json|ya?ml|sh)$/.test(entry.name)) {
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
  matchedRev?: string
  nearestRev?: string
  similarity?: number
}

function surveyModules(dir: string, index: Record<string, Revision[]>): ModuleFinding[] {
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
        ...classify(content, index[entry.name] ?? []),
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

  const rollup: Record<string, unknown>[] = []
  for (const c of consumers) {
    console.error(`surveying ${c.id}…`)
    let survey: Record<string, unknown>
    try {
      const { dir, ref } = fetchConsumer(c)
      const modules = surveyModules(dir, index)
      survey = {
        id: c.id,
        repo: c.repo,
        mode: c.mode,
        tier: c.tier,
        ref,
        surveyedAt: new Date().toISOString(),
        environments: surveyEnvironments(dir),
        modules,
        escapeHatches: findEscapeHatches(
          readTextFiles(dir, ['scripts', 'packages/infra', '.github']),
        ),
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
  const upstream = new Set(Object.keys(index))
  const cases = Object.entries(byModule)
    .map(([name, impls]) => ({
      module: name,
      kind: upstream.has(name) ? 'upgrade' : 'new',
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
