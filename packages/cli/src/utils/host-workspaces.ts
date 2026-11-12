import * as path from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * The workspace globs a repository's own package manager reads: the root
 * `package.json` `workspaces` (npm, Yarn, Bun) and `pnpm-workspace.yaml`
 * `packages` (pnpm). A missing or unreadable file contributes none.
 */
export async function hostWorkspaceGlobs(repoTop: string): Promise<string[]> {
  const globs: string[] = []
  const pkgFile = Bun.file(path.join(repoTop, 'package.json'))
  if (await pkgFile.exists()) {
    try {
      const pkg = (await pkgFile.json()) as { workspaces?: string[] | { packages?: string[] } }
      const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? [])
      globs.push(...ws.filter((g): g is string => typeof g === 'string'))
    } catch {
      // Not ours to diagnose: detect-mode reports an unreadable manifest.
    }
  }
  const pnpmFile = Bun.file(path.join(repoTop, 'pnpm-workspace.yaml'))
  if (await pnpmFile.exists()) {
    try {
      const doc = parseYaml(await pnpmFile.text()) as { packages?: unknown } | null
      if (Array.isArray(doc?.packages)) {
        globs.push(...doc.packages.filter((g): g is string => typeof g === 'string'))
      }
    } catch {
      // An unparseable pnpm-workspace.yaml is pnpm's to complain about.
    }
  }
  return globs
}

// `./apps/*/` and `apps/*` are the same glob to a package manager.
const strip = (glob: string) => glob.replace(/^\.\//, '').replace(/\/+$/, '')

/**
 * The host globs that cover the zbc project folder (`subdir`, top-level
 * relative) or the `packages/infra` package inside it — either one is a
 * package the host's package manager would try to install and link. A `!`
 * glob that excludes the path wins, as it does for pnpm and Yarn.
 */
export async function hostWorkspaceGlobsCovering(
  repoTop: string,
  subdir: string,
): Promise<string[]> {
  const globs = await hostWorkspaceGlobs(repoTop)
  const includes = globs.filter((g) => !g.startsWith('!')).map(strip)
  const excludes = globs.filter((g) => g.startsWith('!')).map((g) => strip(g.slice(1)))
  const candidates = [subdir, `${subdir}/packages/infra`]
  return includes.filter((glob) =>
    candidates.some(
      (dir) => new Bun.Glob(glob).match(dir) && !excludes.some((ex) => new Bun.Glob(ex).match(dir)),
    ),
  )
}
