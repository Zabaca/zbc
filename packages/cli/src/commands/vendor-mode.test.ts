import { afterEach, describe, expect, test } from 'bun:test'
import { execSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * End-to-end tests for subtree (vendor) mode, spawning the real CLI against a
 * throwaway consumer repo + a local stand-in for Zabaca/zbc-core. No network:
 * the core "URL" is a local path and the fake module declares no dependencies.
 */

const CLI = path.resolve(import.meta.dir, '../index.ts')

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

function makeRepo(dir: string): void {
  sh(dir, 'git init -q -b main')
  sh(dir, 'git config user.email t@t && git config user.name t')
  fs.writeFileSync(path.join(dir, '.keep'), '')
  sh(dir, 'git add . && git commit -qm init')
}

function makeCore(): string {
  const dir = tmpdir('zbc-core-')
  makeRepo(dir)
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src/define-module.ts'), 'export const defineModule = 1\n')
  fs.mkdirSync(path.join(dir, 'modules/faketool'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'modules/faketool/index.ts'), 'export const faketool = 1\n')
  fs.writeFileSync(
    path.join(dir, 'modules/faketool/registry.json'),
    JSON.stringify({
      name: 'faketool',
      description: 'test module',
      files: [{ path: 'index.ts' }],
      secrets: ['FAKETOOL_TOKEN'],
      instructions: 'faketool post-install text',
    }),
  )
  sh(dir, 'git add . && git commit -qm core-content')
  return dir
}

function zbc(cwd: string, args: string[]): { status: number; out: string } {
  const res = spawnSync('bun', [CLI, ...args], { cwd, encoding: 'utf8' })
  return { status: res.status ?? -1, out: `${res.stdout}\n${res.stderr}` }
}

function initSubtree(core: string): string {
  const consumer = tmpdir('consumer-')
  makeRepo(consumer)
  const res = zbc(consumer, [
    'init',
    'testproj',
    '--subtree',
    '--core-url',
    core,
    '--core-ref',
    'main',
  ])
  expect(res.status).toBe(0)
  return consumer
}

describe('zbc init --subtree', () => {
  test('vendors core at vendor/zbc and skips copying the engine into packages/infra', () => {
    const consumer = initSubtree(makeCore())
    expect(fs.existsSync(path.join(consumer, 'vendor/zbc/src/define-module.ts'))).toBe(true)
    expect(fs.existsSync(path.join(consumer, 'vendor/zbc/modules/faketool/index.ts'))).toBe(true)
    // Engine comes from the vendor tree — no copied src/, no split-repo README.
    expect(fs.existsSync(path.join(consumer, 'packages/infra/src'))).toBe(false)
    expect(fs.existsSync(path.join(consumer, 'packages/infra/README.md'))).toBe(false)
    // Rest of the scaffold still lands.
    expect(fs.existsSync(path.join(consumer, 'zbc.config.ts'))).toBe(true)
    expect(fs.existsSync(path.join(consumer, 'packages/infra/package.json'))).toBe(true)
    // zbc.config.ts must import the engine from the vendor tree — the copied
    // '@<project>/infra' package points at a src/ that subtree mode skips.
    const config = fs.readFileSync(path.join(consumer, 'zbc.config.ts'), 'utf8')
    expect(config).toContain("from './vendor/zbc/src/index'")
    expect(config).not.toContain('@testproj/infra')
    // Subtree bookkeeping recorded.
    expect(sh(consumer, 'git log --format=%B')).toContain('git-subtree-dir: vendor/zbc')
  })

  test('dirty tree → nonzero exit naming uncommitted changes, no vendor dir', () => {
    const core = makeCore()
    const consumer = tmpdir('consumer-')
    makeRepo(consumer)
    fs.writeFileSync(path.join(consumer, 'wip.txt'), 'x')
    const res = zbc(consumer, ['init', '--subtree', '--core-url', core, '--core-ref', 'main'])
    expect(res.status).not.toBe(0)
    expect(res.out).toMatch(/uncommitted/i)
    expect(fs.existsSync(path.join(consumer, 'vendor/zbc'))).toBe(false)
  })
})

describe('zbc add in vendor mode', () => {
  test('resolves the module from vendor/zbc, copies nothing, prints vendor import path', () => {
    const consumer = initSubtree(makeCore())
    const res = zbc(consumer, ['add', 'faketool', '--no-prompt'])
    expect(res.status).toBe(0)
    // Nothing vendored into packages/infra/modules — the module lives in vendor/zbc.
    expect(fs.existsSync(path.join(consumer, 'packages/infra/modules/faketool'))).toBe(false)
    expect(res.out).toContain('faketool post-install text')
    expect(res.out).toContain('vendor/zbc/modules/faketool')
  })

  test('unknown module still errors clearly', () => {
    const consumer = initSubtree(makeCore())
    const res = zbc(consumer, ['add', 'no-such-module', '--no-prompt'])
    expect(res.status).not.toBe(0)
    expect(res.out).toContain('no-such-module')
  })
})

describe('zbc update', () => {
  test('pulls newer core commits into vendor/zbc', () => {
    const core = makeCore()
    const consumer = initSubtree(core)
    // Commit the init scaffold so the tree is clean for the pull.
    sh(consumer, 'git add . && git commit -qm scaffold')

    fs.mkdirSync(path.join(core, 'modules/newmod'), { recursive: true })
    fs.writeFileSync(path.join(core, 'modules/newmod/index.ts'), 'export const n = 1\n')
    sh(core, 'git add . && git commit -qm add-newmod')

    const res = zbc(consumer, ['update', '--core-url', core, '--core-ref', 'main'])
    expect(res.status).toBe(0)
    expect(fs.existsSync(path.join(consumer, 'vendor/zbc/modules/newmod/index.ts'))).toBe(true)
  })

  test('outside vendor mode (copy-mode project) → clear error', () => {
    const consumer = tmpdir('consumer-')
    makeRepo(consumer)
    // A copy-mode zbc project: config present, no vendor/zbc.
    fs.writeFileSync(path.join(consumer, 'zbc.config.ts'), 'export default {}\n')
    const res = zbc(consumer, ['update', '--core-url', makeCore(), '--core-ref', 'main'])
    expect(res.status).not.toBe(0)
    expect(res.out).toMatch(/vendor|subtree/i)
  })
})
