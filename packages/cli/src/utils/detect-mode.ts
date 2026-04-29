import * as path from 'node:path'

export type InitMode =
  | { kind: 'greenfield' }
  | { kind: 'monorepo' }
  | { kind: 'incompatible'; reason: string }

interface PackageJson {
  workspaces?: string[] | { packages?: string[] }
}

function workspaceGlobs(pkg: PackageJson): string[] {
  if (!pkg.workspaces) return []
  if (Array.isArray(pkg.workspaces)) return pkg.workspaces
  return pkg.workspaces.packages ?? []
}

function hasPackagesGlob(globs: string[]): boolean {
  return globs.some((g) => g === 'packages/*' || g === 'packages/**' || g.startsWith('packages/'))
}

export async function detectMode(cwd: string): Promise<InitMode> {
  const pkgPath = path.join(cwd, 'package.json')
  const pkgFile = Bun.file(pkgPath)

  if (!(await pkgFile.exists())) {
    return { kind: 'greenfield' }
  }

  let pkg: PackageJson
  try {
    pkg = (await pkgFile.json()) as PackageJson
  } catch {
    return { kind: 'incompatible', reason: 'package.json is not valid JSON' }
  }

  const globs = workspaceGlobs(pkg)
  if (globs.length === 0) {
    return {
      kind: 'incompatible',
      reason:
        'package.json exists but has no `workspaces` field. v1 only supports greenfield or existing Bun workspaces. Add `"workspaces": ["packages/*"]` and re-run.',
    }
  }

  if (!hasPackagesGlob(globs)) {
    return {
      kind: 'incompatible',
      reason: `workspaces glob does not include packages/* (found: ${globs.join(', ')}). Add a packages/* glob and re-run.`,
    }
  }

  return { kind: 'monorepo' }
}
