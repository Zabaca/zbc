import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { copyTemplateDir, templatesRoot } from './copy-template'

/**
 * Copy mode's update path. The CLI already carries the templates it scaffolds,
 * so `zbc update` in a copy-mode project can re-lay them over what is there —
 * the engine `src/`, plus every built-in module the project already added.
 *
 * Two things it must never do: pull in built-in modules the project did not
 * ask for, and touch a module the consumer wrote (anything not bundled). Both
 * fall out of "refresh what is present and bundled".
 *
 * It overlays *and prunes*: a file upstream renamed away would otherwise stay
 * importable beside its replacement, which is a project running two engine
 * vintages at once with nothing to show for it.
 */

export interface RefreshResult {
  /** Paths (project-relative) refreshed from the bundled templates. */
  refreshed: string[]
  /** Files deleted because this CLI no longer ships them at that path. */
  removed: string[]
  /** Paths left alone, with why — symlinks, mostly. */
  skipped: { path: string; reason: string }[]
  /**
   * Dependencies a refreshed module declares that packages/infra does not have.
   * Reported rather than installed: `zbc update` must not reach the network on
   * a consumer's behalf, and a missing one is a module-resolution failure at
   * the next apply, so it has to be said out loud.
   */
  missingDependencies: Record<string, string>
}

async function isSymlink(target: string): Promise<boolean> {
  try {
    return (await fs.lstat(target)).isSymbolicLink()
  } catch {
    return false
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

/** Relative file paths under root, ignoring dotfiles and nested .git. */
async function walk(root: string, base = ''): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(path.join(root, base), { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await walk(root, rel)))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/**
 * Overlay `src` onto `dest`, then delete anything in `dest` the template tree
 * no longer has. Test files are excluded both ways — the published CLI drops
 * them, so their absence upstream is not a rename.
 */
async function relayDir(srcDir: string, destDir: string): Promise<string[]> {
  await copyTemplateDir(srcDir, destDir, { skipIfExists: false, excludeTests: true })
  const upstream = new Set((await walk(srcDir)).filter((f) => !f.endsWith('.test.ts')))
  const removed: string[] = []
  for (const rel of await walk(destDir)) {
    if (upstream.has(rel) || rel.endsWith('.test.ts')) continue
    await fs.rm(path.join(destDir, rel))
    removed.push(rel)
  }
  return removed
}

interface RegistryDeps {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

async function declaredDependencies(moduleDir: string): Promise<Record<string, string>> {
  const file = Bun.file(path.join(moduleDir, 'registry.json'))
  if (!(await file.exists())) return {}
  try {
    const registry = (await file.json()) as RegistryDeps
    return {
      ...registry.dependencies,
      ...registry.devDependencies,
      ...registry.optionalDependencies,
    }
  } catch {
    return {}
  }
}

async function installedDependencies(infraDir: string): Promise<Set<string>> {
  const file = Bun.file(path.join(infraDir, 'package.json'))
  if (!(await file.exists())) return new Set()
  try {
    const pkg = (await file.json()) as RegistryDeps
    return new Set(
      Object.keys({
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.optionalDependencies,
      }),
    )
  } catch {
    return new Set()
  }
}

export async function refreshCopiedTemplates(projectRoot: string): Promise<RefreshResult> {
  const tplInfra = path.join(templatesRoot(), 'infra')
  const infraDir = path.join(projectRoot, 'packages/infra')
  const result: RefreshResult = {
    refreshed: [],
    removed: [],
    skipped: [],
    missingDependencies: {},
  }

  const engineDest = path.join(infraDir, 'src')
  if (await isSymlink(engineDest)) {
    // This repo's own packages/infra/src is a symlink into the templates;
    // writing through it would edit the source of truth from a consumer command.
    result.skipped.push({ path: 'packages/infra/src', reason: 'symlink' })
  } else if (await exists(engineDest)) {
    const removed = await relayDir(path.join(tplInfra, 'src'), engineDest)
    result.refreshed.push('packages/infra/src')
    result.removed.push(...removed.map((f) => `packages/infra/src/${f}`))
  }

  const modulesDest = path.join(infraDir, 'modules')
  if (await isSymlink(modulesDest)) {
    result.skipped.push({ path: 'packages/infra/modules', reason: 'symlink' })
    return result
  }
  if (!(await exists(modulesDest))) return result

  const bundled = new Set(
    (await fs.readdir(path.join(tplInfra, 'modules'), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  )
  const installed = await installedDependencies(infraDir)

  for (const entry of await fs.readdir(modulesDest, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const rel = `packages/infra/modules/${entry.name}`
    // Consumer-owned modules are not ours to rewrite.
    if (!bundled.has(entry.name)) continue
    if (entry.isSymbolicLink()) {
      result.skipped.push({ path: rel, reason: 'symlink' })
      continue
    }
    const srcDir = path.join(tplInfra, 'modules', entry.name)
    const removed = await relayDir(srcDir, path.join(modulesDest, entry.name))
    result.refreshed.push(rel)
    result.removed.push(...removed.map((f) => `${rel}/${f}`))
    for (const [name, version] of Object.entries(await declaredDependencies(srcDir))) {
      if (!installed.has(name)) result.missingDependencies[name] = version
    }
  }

  return result
}
