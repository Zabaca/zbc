// One page draws every part's screens, and one Worker mounts every part's routes, so the folder's packages must agree on the libraries they share at run time. A package that asks for React by a range of
// its own is given its own copy wherever the project's lockfile resolves that range differently, and a screen drawn with two copies of React fails at its first hook. So React is named by one exact
// version in every package that names it, and every other library two packages share at run time is named the same way in each.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const packagesRoot = fileURLToPath(new URL('../../', import.meta.url))

/**
 * The tools that build, run locally and deploy the Worker. The local runtime they carry is what the end-to-end suites drive (how it keeps mail a Worker sent, for one), and the deploy tool is what an install's
 * apply runs, so a range that lets a project's lockfile choose a newer one is a suite, or a deploy, on a tool nobody ran this code with.
 */
const TOOLS = ['wrangler', '@cloudflare/vite-plugin'] as const
const tools = new Map<string, Map<string, string>>()

/** What each package of the folder asks for at run time: a library's name to the packages naming it and how each names it. */
const asked = new Map<string, Map<string, string>>()
for (const folder of readdirSync(packagesRoot)) {
  let manifest: { name: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  try {
    manifest = JSON.parse(readFileSync(`${packagesRoot}${folder}/package.json`, 'utf8'))
  } catch {
    continue
  }
  for (const tool of TOOLS) {
    const spec = manifest.devDependencies?.[tool]
    if (spec === undefined) continue
    if (!tools.has(tool)) tools.set(tool, new Map())
    tools.get(tool)!.set(manifest.name, spec)
  }
  for (const [library, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (spec.startsWith('workspace:')) continue
    if (!asked.has(library)) asked.set(library, new Map())
    asked.get(library)!.set(manifest.name, spec)
  }
}

describe('the folder’s packages share one copy of what they share', () => {
  test('React is one exact version wherever it is named, so no lockfile can give one part a copy of its own', () => {
    for (const library of ['react', 'react-dom']) {
      const specs = [...(asked.get(library)?.values() ?? [])]
      // The page and at least two parts draw with it.
      expect(specs.length, library).toBeGreaterThan(2)
      expect(new Set(specs).size, `${library}: ${JSON.stringify([...asked.get(library)!])}`).toBe(1)
      expect(specs[0], library).toMatch(/^\d+\.\d+\.\d+$/)
    }
    expect(asked.get('react')!.values().next().value).toBe(asked.get('react-dom')!.values().next().value)
  })

  test('a library two packages use at run time is asked for the same way by each', () => {
    const differing = [...asked].filter(([, by]) => new Set(by.values()).size > 1).map(([library, by]) => `${library}: ${JSON.stringify([...by])}`)
    expect(differing).toEqual([])
  })

  test('the tools that build and deploy the Worker are one exact version in every package that names them', () => {
    for (const tool of TOOLS) {
      const specs = [...(tools.get(tool)?.values() ?? [])]
      expect(specs.length, tool).toBeGreaterThan(1)
      expect(new Set(specs).size, `${tool}: ${JSON.stringify([...tools.get(tool)!])}`).toBe(1)
      expect(specs[0], tool).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })
})
