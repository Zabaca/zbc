#!/usr/bin/env bun
/**
 * Which production instances does a push actually touch?
 *
 * `zbc apply production` ran on every push to main with no filter at all — a
 * README-only commit redeployed every Worker, rolled two Containers and hit
 * the Cloudflare API for a zone with two dozen DNS records. This narrows that
 * to the instances whose inputs changed, and prints either their names or the
 * word `ALL`.
 *
 * **It is built to fail toward ALL, and that direction is the whole design.**
 * The cost of a needless apply is a slow job; the cost of a missed one is a
 * merged change that silently never deployed, discovered whenever someone next
 * looks. So a changed file that this cannot confidently attribute to an
 * instance — a new package, a moved directory, anything the map below does not
 * know — widens the run instead of being dropped. Only two categories narrow
 * it: files owned by a specific instance, and files on an explicit inert list.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ModuleInstance } from '../packages/cli/templates/infra/src/types'

/** One instance, flattened to the paths whose contents decide its deployed state. */
export interface InstancePaths {
  name: string
  /** Names of the instances it imports — the edges the closure walks backwards. */
  imports: string[]
  /** Repo-relative path prefixes this instance owns. */
  paths: string[]
}

export type Affected =
  | { kind: 'all'; reason: string }
  | { kind: 'scoped'; instances: string[] }
  | { kind: 'none' }

/**
 * Paths that feed every instance, so a change to one can only mean ALL.
 *
 * `packages/cli/src/` is the engine: it decides the order the graph converges
 * in, which imports resolve and which secrets a module can see. `templates/
 * infra/src/` is `defineModule` and the ApplyContext every module is handed.
 * The rest are the inputs a build reads no matter which package it builds.
 */
const GLOBAL_PATHS = [
  'packages/cli/src/',
  'packages/cli/templates/infra/src/',
  'packages/infra/src/',
  'package.json',
  'bun.lock',
  'tsconfig.json',
  'zbc.config.ts',
  '.sops.yaml',
  '.github/workflows/production.yml',
]

/**
 * Paths that cannot change what is deployed, so a change to one narrows the run
 * rather than widening it.
 *
 * Prose and board state are obvious. Test files are here on a sharper claim: a
 * deployed artifact never imports one — wrangler bundles from an entrypoint,
 * and no entrypoint reaches a `.test.ts`. If that ever stops being true the
 * failure is a missed deploy, which is the expensive direction, so this entry
 * is the one to remove first if anything here is ever in doubt.
 */
const INERT_PATHS = [
  'docs/',
  '.claude/',
  '.agents/',
  '.github/',
  '.vscode/',
  'lefthook.yml',
  // The CLI manifest, and this one earns its own sentence because leaving it
  // out made the whole filter a no-op: nearly every PR bumps the version there,
  // so treating it as unmapped answered ALL for all three of the merges this
  // was first tested against. The field that matters for a deploy is
  // `dependencies` — a module's apply imports them — and a change to those
  // always moves `bun.lock`, which is global above. What is left is the version
  // and the scripts, neither of which any instance reads.
  'packages/cli/package.json',
]
const INERT_SUFFIXES = ['.md', '.test.ts', '.e2e.test.ts']

const under = (file: string, prefix: string): boolean =>
  prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix

/** The graph half: pure over the flattened map, so the rules above are testable. */
export function affectedInstances(changed: string[], instances: InstancePaths[]): Affected {
  // An empty file list is almost always a diff that failed to compute, not a
  // push that changed nothing — and a push that changed nothing does not reach
  // this script. Treat it as unknown.
  if (changed.length === 0) return { kind: 'all', reason: 'no changed files were reported' }

  const owners = new Set<string>()

  for (const file of changed) {
    const global = GLOBAL_PATHS.find((p) => under(file, p))
    if (global) return { kind: 'all', reason: `${file} is a shared input (${global})` }

    if (INERT_PATHS.some((p) => under(file, p))) continue
    if (INERT_SUFFIXES.some((s) => file.endsWith(s))) continue

    const matched = instances.filter((inst) => inst.paths.some((p) => under(file, p)))
    if (matched.length === 0) {
      return { kind: 'all', reason: `${file} maps to no instance` }
    }
    for (const inst of matched) owners.add(inst.name)
  }

  if (owners.size === 0) return { kind: 'none' }

  // Walk the edges backwards. A dependency's outputs are wired into its
  // dependents — `walgit-public` reads its bucket name out of
  // `walgit-public-wal`, `email` its worker name out of `inbox` — so a changed
  // dependency has to redeploy everything that reads it, not just itself.
  const importers = new Map<string, string[]>()
  for (const inst of instances) {
    for (const dep of inst.imports) {
      importers.set(dep, [...(importers.get(dep) ?? []), inst.name])
    }
  }

  const closure = new Set<string>()
  const queue = Array.from(owners)
  while (queue.length > 0) {
    const name = queue.shift()!
    if (closure.has(name)) continue
    closure.add(name)
    for (const dependent of importers.get(name) ?? []) queue.push(dependent)
  }

  return { kind: 'scoped', instances: Array.from(closure).toSorted() }
}

/**
 * The I/O half: read an environment directory into the flattened map above.
 *
 * `workdir` is realpath'd because the packages the instances name are symlinks
 * — `packages/inbox` and `packages/walgit` point into
 * `packages/cli/templates/apps/`, which is where git reports the change. A map
 * built on the symlink path would match nothing a push ever contains, and this
 * script would answer ALL forever without anyone noticing it had stopped
 * working.
 */
export async function readEnvironment(
  projectRoot: string,
  envDir: string,
): Promise<InstancePaths[]> {
  const glob = new Bun.Glob('*.ts')
  const files = Array.from(glob.scanSync({ cwd: envDir })).toSorted()
  const relEnvDir = path.relative(projectRoot, envDir)
  const instances: InstancePaths[] = []

  for (const file of files) {
    const absolutePath = path.resolve(envDir, file)
    const mod = await import(absolutePath)
    const instance: ModuleInstance = mod.default

    const paths = [
      path.posix.join(relEnvDir, file),
      `packages/cli/templates/infra/modules/${instance.moduleName}/`,
    ]

    const workdir = (instance.config as { workdir?: string }).workdir
    if (workdir) {
      const real = fs.realpathSync(path.resolve(projectRoot, workdir))
      paths.push(`${path.relative(projectRoot, real)}/`)
    }

    instances.push({
      name: instance.name,
      imports: instance.imports.map((dep) => dep.name),
      paths,
    })
  }

  return instances
}

if (import.meta.main) {
  const [env, ...changed] = process.argv.slice(2)
  if (!env) {
    console.error('usage: affected-instances.ts <env> <changed file>...')
    process.exit(2)
  }

  const projectRoot = path.resolve(import.meta.dir, '..')
  const envDir = path.join(projectRoot, 'packages', 'infra', 'environments', env)

  let result: Affected
  try {
    result = affectedInstances(changed, await readEnvironment(projectRoot, envDir))
  } catch (error) {
    // The environment failed to load — which `zbc apply` is about to report far
    // better than this script can. Hand it the full run and let it be the one
    // that says why.
    console.error(`could not read ${env}: ${error instanceof Error ? error.message : error}`)
    result = { kind: 'all', reason: 'the environment could not be read' }
  }

  if (result.kind === 'all') console.error(`ALL — ${result.reason}`)
  if (result.kind === 'none') console.error('nothing deployable changed')
  console.log(
    result.kind === 'all' ? 'ALL' : result.kind === 'none' ? '' : result.instances.join(','),
  )
}
