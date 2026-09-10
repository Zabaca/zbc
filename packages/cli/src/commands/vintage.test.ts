import { afterEach, describe, expect, test } from 'bun:test'
import { execSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * End-to-end: a project records which engine it vendored, and `zbc apply` says
 * so when that vintage has drifted from the CLI running it. Spawns the real
 * CLI against throwaway repos; no network.
 */

const CLI = path.resolve(import.meta.dir, '../index.ts')
const CLI_VERSION = (
  JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, '../../package.json'), 'utf8')) as {
    version: string
  }
).version

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
  sh(dir, 'git add . && git commit -qm core-content')
  return dir
}

function zbc(cwd: string, args: string[]): { status: number; out: string } {
  const res = spawnSync('bun', [CLI, ...args], { cwd, encoding: 'utf8' })
  return { status: res.status ?? -1, out: `${res.stdout}\n${res.stderr}` }
}

function readStampFile(root: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, '.zbc-vendor.json'), 'utf8')) as Record<
    string,
    unknown
  >
}

describe('zbc init records the vintage', () => {
  test('subtree mode stamps the core ref at the project root, not inside the prefix', () => {
    const core = makeCore()
    const consumer = tmpdir('consumer-')
    makeRepo(consumer)
    expect(
      zbc(consumer, ['init', 'testproj', '--subtree', '--core-url', core, '--core-ref', 'main'])
        .status,
    ).toBe(0)

    const stamp = readStampFile(consumer)
    expect(stamp.mode).toBe('subtree')
    expect(stamp.cliVersion).toBe(CLI_VERSION)
    expect(stamp.coreRef).toBe('main')
    // The prefix is upstream's; a stamp in there would ride a subtree push.
    expect(fs.existsSync(path.join(consumer, 'vendor/zbc/.zbc-vendor.json'))).toBe(false)
  })

  test('copy mode stamps itself as copy mode', () => {
    const consumer = tmpdir('consumer-')
    makeRepo(consumer)
    expect(zbc(consumer, ['init', 'testproj']).status).toBe(0)
    const stamp = readStampFile(consumer)
    expect(stamp.mode).toBe('copy')
    expect(stamp.coreRef).toBeUndefined()
  })
})

describe('zbc apply surfaces the vintage', () => {
  test('a copy-mode project is told, on every apply, that updates do not flow', () => {
    const consumer = tmpdir('consumer-')
    makeRepo(consumer)
    expect(zbc(consumer, ['init', 'testproj']).status).toBe(0)
    const res = zbc(consumer, ['apply', 'production'])
    expect(res.out).toContain('copy mode')
    expect(res.out).toContain('zbc init --subtree')
  })

  test('a subtree project stamped by an older CLI is told which ref it is on', () => {
    const core = makeCore()
    const consumer = tmpdir('consumer-')
    makeRepo(consumer)
    expect(
      zbc(consumer, ['init', 'testproj', '--subtree', '--core-url', core, '--core-ref', 'main'])
        .status,
    ).toBe(0)
    fs.writeFileSync(
      path.join(consumer, '.zbc-vendor.json'),
      JSON.stringify({
        mode: 'subtree',
        cliVersion: '0.0.1',
        coreRef: 'zbc-core-v0.0.1',
        vendoredAt: '2026-01-01T00:00:00.000Z',
      }),
    )
    const res = zbc(consumer, ['apply', 'production'])
    expect(res.out).toContain('zbc-core-v0.0.1')
    expect(res.out).toContain('zbc update')
  })
})
