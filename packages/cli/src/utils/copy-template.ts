import * as path from 'node:path'
import * as fs from 'node:fs/promises'

interface CopyOptions {
  /** {{KEY}} → value substitution applied to the file body. */
  vars?: Record<string, string>
  /** Override skip-if-exists behavior. Default true. */
  skipIfExists?: boolean
  /** Directory/file basenames to skip (e.g. ['modules']). */
  exclude?: string[]
}

function substitute(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key: string) => {
    return vars[key] ?? match
  })
}

/**
 * Copy a single template file. Returns true if written, false if skipped.
 * Always logs the action.
 */
export async function copyTemplateFile(
  sourcePath: string,
  destPath: string,
  opts: CopyOptions = {},
): Promise<boolean> {
  const skipIfExists = opts.skipIfExists !== false

  const destFile = Bun.file(destPath)
  if (skipIfExists && (await destFile.exists())) {
    console.log(`  skip ${path.relative(process.cwd(), destPath)} (exists)`)
    return false
  }

  let body = await Bun.file(sourcePath).text()
  if (opts.vars) body = substitute(body, opts.vars)

  await fs.mkdir(path.dirname(destPath), { recursive: true })
  await Bun.write(destPath, body)
  console.log(`  write ${path.relative(process.cwd(), destPath)}`)
  return true
}

/**
 * Recursively copy a directory of templates. Mirrors structure under destDir.
 * Optional rename map maps source basenames to dest names (e.g. `gitignore` →
 * `.gitignore`).
 */
export async function copyTemplateDir(
  sourceDir: string,
  destDir: string,
  opts: CopyOptions & { rename?: Record<string, string> } = {},
): Promise<void> {
  const rename = opts.rename ?? {}
  const exclude = new Set(opts.exclude ?? [])
  const entries = await fs.readdir(sourceDir, { withFileTypes: true })

  for (const entry of entries) {
    if (exclude.has(entry.name)) continue
    const srcPath = path.join(sourceDir, entry.name)
    const destName = rename[entry.name] ?? entry.name
    const destPath = path.join(destDir, destName)

    if (entry.isDirectory()) {
      await copyTemplateDir(srcPath, destPath, opts)
    } else {
      await copyTemplateFile(srcPath, destPath, opts)
    }
  }
}

/** Resolve the bundled-templates directory relative to this CLI install. */
export function templatesRoot(): string {
  // import.meta.dir = .../packages/cli/src/utils → templates at ../../templates
  return path.resolve(import.meta.dir, '../../templates')
}

/** Path to bundled modules: packages/cli/templates/infra/modules/. */
export function bundledModulesCandidates(): string[] {
  return [path.resolve(import.meta.dir, '../../templates/infra/modules')]
}

/** Path to bundled app templates: packages/cli/templates/apps/. */
export function bundledAppsCandidates(): string[] {
  return [path.resolve(import.meta.dir, '../../templates/apps')]
}
