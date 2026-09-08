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
 */

export interface RefreshResult {
  /** Paths (project-relative) refreshed from the bundled templates. */
  refreshed: string[]
  /** Paths left alone, with why — symlinks, mostly. */
  skipped: { path: string; reason: string }[]
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

export async function refreshCopiedTemplates(projectRoot: string): Promise<RefreshResult> {
  const tplInfra = path.join(templatesRoot(), 'infra')
  const infraDir = path.join(projectRoot, 'packages/infra')
  const result: RefreshResult = { refreshed: [], skipped: [] }

  const engineDest = path.join(infraDir, 'src')
  if (await isSymlink(engineDest)) {
    // This repo's own packages/infra/src is a symlink into the templates;
    // writing through it would edit the source of truth from a consumer command.
    result.skipped.push({ path: 'packages/infra/src', reason: 'symlink' })
  } else if (await exists(engineDest)) {
    await copyTemplateDir(path.join(tplInfra, 'src'), engineDest, {
      skipIfExists: false,
      excludeTests: true,
    })
    result.refreshed.push('packages/infra/src')
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

  for (const entry of await fs.readdir(modulesDest, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const rel = `packages/infra/modules/${entry.name}`
    // Consumer-owned modules are not ours to rewrite.
    if (!bundled.has(entry.name)) continue
    if (entry.isSymbolicLink()) {
      result.skipped.push({ path: rel, reason: 'symlink' })
      continue
    }
    await copyTemplateDir(
      path.join(tplInfra, 'modules', entry.name),
      path.join(modulesDest, entry.name),
      { skipIfExists: false, excludeTests: true },
    )
    result.refreshed.push(rel)
  }

  return result
}
