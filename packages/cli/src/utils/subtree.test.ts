import { afterEach, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  coreRefForVersion,
  ensureCleanGitTree,
  isVendorMode,
  subtreeAdd,
  subtreePull,
  VENDOR_PREFIX,
} from './subtree'

/**
 * Real-git tests: a throwaway "core" repo stands in for Zabaca/zbc-core (local
 * path in place of the URL — git subtree accepts any repository), and a
 * throwaway consumer repo vendors it. No network.
 */

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

function sh(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function tmpdir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(dir)
  return dir
}

/** Init a git repo with identity + one commit so subtree has a base. */
function makeRepo(dir: string): void {
  sh(dir, 'git init -q -b main')
  sh(dir, 'git config user.email t@t && git config user.name t')
  fs.writeFileSync(path.join(dir, '.keep'), '')
  sh(dir, 'git add . && git commit -qm init')
}

/** A fake zbc-core: src/define-module.ts + one dep-free module. */
function makeCore(): string {
  const dir = tmpdir('zbc-core-')
  makeRepo(dir)
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src/define-module.ts'), 'export const defineModule = 1\n')
  fs.mkdirSync(path.join(dir, 'modules/faketool'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'modules/faketool/index.ts'), 'export const faketool = 1\n')
  fs.writeFileSync(
    path.join(dir, 'modules/faketool/registry.json'),
    JSON.stringify({ name: 'faketool', description: 'test module', files: [{ path: 'index.ts' }] }),
  )
  sh(dir, 'git add . && git commit -qm core-content')
  return dir
}

describe('coreRefForVersion', () => {
  test('maps a CLI version to its core tag', () => {
    expect(coreRefForVersion('0.9.0')).toBe('zbc-core-v0.9.0')
  })
})

describe('ensureCleanGitTree', () => {
  test('passes on a clean tree', () => {
    const dir = tmpdir('clean-')
    makeRepo(dir)
    expect(() => ensureCleanGitTree(dir)).not.toThrow()
  })

  test('throws on a dirty tree, naming the offending state', () => {
    const dir = tmpdir('dirty-')
    makeRepo(dir)
    fs.writeFileSync(path.join(dir, 'uncommitted.txt'), 'x')
    expect(() => ensureCleanGitTree(dir)).toThrow(/uncommitted/i)
  })

  test('throws outside a git repository', () => {
    const dir = tmpdir('nogit-')
    expect(() => ensureCleanGitTree(dir)).toThrow(/git/i)
  })
})

describe('subtreeAdd / isVendorMode / subtreePull', () => {
  test('vendors core under vendor/zbc with a squash commit; isVendorMode flips', async () => {
    const core = makeCore()
    const consumer = tmpdir('consumer-')
    makeRepo(consumer)

    expect(await isVendorMode(consumer)).toBe(false)
    subtreeAdd(consumer, { url: core, ref: 'main' })

    expect(fs.existsSync(path.join(consumer, VENDOR_PREFIX, 'src/define-module.ts'))).toBe(true)
    expect(
      fs.existsSync(path.join(consumer, VENDOR_PREFIX, 'modules/faketool/registry.json')),
    ).toBe(true)
    expect(await isVendorMode(consumer)).toBe(true)
    // --squash bookkeeping present (subtree pull depends on it)
    const log = sh(consumer, 'git log --format=%B')
    expect(log).toContain(`git-subtree-dir: ${VENDOR_PREFIX}`)
  })

  test('subtreePull brings later core commits into the vendored copy', () => {
    const core = makeCore()
    const consumer = tmpdir('consumer-')
    makeRepo(consumer)
    subtreeAdd(consumer, { url: core, ref: 'main' })

    fs.mkdirSync(path.join(core, 'modules/newmod'), { recursive: true })
    fs.writeFileSync(path.join(core, 'modules/newmod/index.ts'), 'export const n = 1\n')
    sh(core, 'git add . && git commit -qm add-newmod')

    subtreePull(consumer, { url: core, ref: 'main' })
    expect(fs.existsSync(path.join(consumer, VENDOR_PREFIX, 'modules/newmod/index.ts'))).toBe(true)
  })

  test('subtreeAdd on a dirty tree throws before touching anything', () => {
    const core = makeCore()
    const consumer = tmpdir('consumer-')
    makeRepo(consumer)
    fs.writeFileSync(path.join(consumer, 'wip.txt'), 'x')
    expect(() => subtreeAdd(consumer, { url: core, ref: 'main' })).toThrow(/uncommitted/i)
    expect(fs.existsSync(path.join(consumer, VENDOR_PREFIX))).toBe(false)
  })
})
