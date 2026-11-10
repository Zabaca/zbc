// Forms is IN the space's Worker now: its operator API, its reads, its rules and the pieces of its
// signer-side screens the Forms tab draws are all bundled into the space. So a change to ANY file of forms is a change to the space's Worker, and reaches a company only when its space is applied.
// A project whose deploys are automated can say so when forms changes by watching the whole package: a list of files cannot be right (the whole app is in), and what this keeps true is that nothing of
// forms' that the space imports falls outside the package.
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const packages = fileURLToPath(new URL('../..', import.meta.url))
/** The space's own folder: the one that holds `packages/`. */
const repo = fileURLToPath(new URL('../../..', import.meta.url))

function walk(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, into)
    else if (/\.tsx?$/.test(name)) into.push(path)
  }
  return into
}

/** Every file of another package that the space's code (or its build) names by a path into it. */
function importedFrom(pkg: string): string[] {
  const out = new Set<string>()
  const root = join(packages, pkg)
  for (const file of [...walk(join(packages, 'space/src')), join(packages, 'space/vite.config.ts')]) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?'([^']+)'/g)) {
      const spec = m[1]!
      const base = spec.startsWith(`@space/${pkg}/`) ? join(root, spec.slice(`@space/${pkg}/`.length)) : spec.startsWith('.') ? normalize(join(dirname(file), spec)) : null
      if (!base?.startsWith(root)) continue
      const found = [`${base}.ts`, `${base}.tsx`, base].find((p) => existsSync(p) && statSync(p).isFile())
      if (found) out.add(relative(repo, found))
    }
  }
  return [...out].sort()
}

describe('forms in the space', () => {
  test('the space imports forms’ app and its reads, and from forms alone: that is the Worker’s forms', () => {
    const parts = readFileSync(join(packages, 'space/src/parts.ts'), 'utf8')
    expect(parts).toContain("from '@space/forms/src/app'")
    expect(parts).toContain("from '@space/forms/src/space-reads'")
    const real = importedFrom('forms')
    expect(real.length).toBeGreaterThan(8)
    for (const f of real) expect(f.startsWith('packages/forms/'), f).toBe(true)
  })

  test('and ADR 0007 says so: the one place the cost is written for people', () => {
    const adr = readFileSync(join(packages, 'space/docs/adr/0007-forms-screens-are-the-space-s-own-page-and-forms-keeps-the-api.md'), 'utf8')
    expect(adr).toContain('(0015-forms-and-the-knowledge-app-run-in-the-spaces-worker')
    expect(adr).toContain('packages/forms/**')
  })
})

describe('the knowledge app in the space', () => {
  test('is imported by path from its package, and its Durable Object class is the one the Worker exports', () => {
    const real = importedFrom('knowledge')
    expect(real).toContain('packages/knowledge/src/durable.ts')
    expect(real).toContain('packages/knowledge/src/space.ts')
    expect(real).toContain('packages/knowledge/src/store-access.ts')
  })
})
