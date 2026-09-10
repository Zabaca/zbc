import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { validateRegistry } from './add'

/**
 * Every bundled `registry.json`, checked against the directory it describes.
 *
 * The kind is a claim about the code beside it — `kind: "library"` says
 * "defines no module" — and a claim nothing checks is a comment. This walks the
 * templates with `readdirSync` and reads the sources, where `add.ts` resolves
 * through globs and `Bun.file`: a test that recomputed the implementation would
 * agree with it while both were wrong.
 */

const MODULES = path.resolve(import.meta.dir, '../../templates/infra/modules')
const APPS = path.resolve(import.meta.dir, '../../templates/apps')

interface Manifest {
  name: string
  kind?: string
  modules?: string[]
  files?: { path: string }[]
  targetDir?: string
  instanceFile?: string
}

function manifests(dir: string): { dirName: string; manifest: Manifest }[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'registry.json')))
    .map((e) => ({
      dirName: e.name,
      manifest: JSON.parse(
        fs.readFileSync(path.join(dir, e.name, 'registry.json'), 'utf8'),
      ) as Manifest,
    }))
    .toSorted((a, b) => a.dirName.localeCompare(b.dirName))
}

/** Every non-test .ts file in the directory — a sibling import is not obliged
 *  to live in index.ts (incus-core ships two more files), and a check that read
 *  only index.ts would miss exactly the dangling import it exists to catch. */
function sources(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => fs.readFileSync(path.join(dir, e.name), 'utf8'))
}

const moduleDirs = manifests(MODULES)
const appDirs = manifests(APPS)

test('the walk found something to check', () => {
  expect(moduleDirs.length).toBeGreaterThanOrEqual(12)
  expect(appDirs.length).toBeGreaterThanOrEqual(3)
})

describe('a declared kind matches the code in the directory', () => {
  for (const { dirName, manifest } of moduleDirs) {
    test(dirName, () => {
      validateRegistry(manifest, dirName)
      const definesModule = sources(path.join(MODULES, dirName)).some((src) =>
        src.includes('defineModule('),
      )
      expect(manifest.kind ?? 'module').toBe(definesModule ? 'module' : 'library')
    })
  }
})

test('the five shared libraries are named as such', () => {
  const libraries = moduleDirs.filter((m) => m.manifest.kind === 'library').map((m) => m.dirName)
  // Named, not counted: these are the directories whose instructions used to
  // open "Not a module:", and the list a reader should have to edit on purpose.
  expect(libraries).toEqual([
    'cloudflare-api',
    'gcp-api',
    'host-exec',
    'incus-core',
    'provision-core',
  ])
})

describe('every sibling a module imports is declared, and every declaration resolves', () => {
  const known = new Set(moduleDirs.map((m) => m.dirName))
  for (const { dirName, manifest } of moduleDirs) {
    test(dirName, () => {
      for (const dep of manifest.modules ?? []) {
        expect(known).toContain(dep)
        expect(dep).not.toBe(dirName)
      }
      // The other direction: what the sources actually import as `../<name>`.
      const imported = sources(path.join(MODULES, dirName)).flatMap((src) =>
        [...src.matchAll(/from '\.\.\/([a-z0-9-]+)'/g)].map((m) => m[1] ?? ''),
      )
      const declared = new Set(manifest.modules ?? [])
      for (const name of imported) expect(declared).toContain(name)
    })
  }
})

test('app templates declare their infra module dependencies against real modules', () => {
  const known = new Set(moduleDirs.map((m) => m.dirName))
  for (const { dirName, manifest } of appDirs) {
    validateRegistry(manifest, dirName)
    expect(manifest.kind).toBe('app')
    for (const dep of manifest.modules ?? []) expect(known).toContain(dep)
  }
})

test('an unknown kind is refused by name', () => {
  expect(() => validateRegistry({ kind: 'librarry' }, 'x')).toThrow(/librarry/)
})

test('a library declaring app-only fields is refused', () => {
  expect(() => validateRegistry({ kind: 'library', targetDir: 'packages/x' }, 'x')).toThrow(
    /targetDir/,
  )
})
