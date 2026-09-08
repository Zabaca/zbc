import { afterEach, describe, expect, test } from 'bun:test'
import { execSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * `zbc update` in a copy-mode project: the CLI already carries the templates,
 * so refreshing them in place is the update path copy-mode consumers never had
 * (varnick's subtree add failed, and nothing else could bring engine fixes in).
 */

const CLI = path.resolve(import.meta.dir, '../index.ts')
const TEMPLATES = path.resolve(import.meta.dir, '../../templates/infra')

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

function zbc(cwd: string, args: string[]): { status: number; out: string } {
  const res = spawnSync('bun', [CLI, ...args], { cwd, encoding: 'utf8' })
  return { status: res.status ?? -1, out: `${res.stdout}\n${res.stderr}` }
}

/** A copy-mode consumer scaffolded by the real CLI. */
function initCopy(): string {
  const consumer = tmpdir('consumer-')
  sh(consumer, 'git init -q -b main')
  sh(consumer, 'git config user.email t@t && git config user.name t')
  expect(zbc(consumer, ['init', 'testproj']).status).toBe(0)
  return consumer
}

describe('zbc update in copy mode', () => {
  test('refreshes the copied engine and the built-in modules already present', () => {
    const consumer = initCopy()
    const enginePath = path.join(consumer, 'packages/infra/src/define-module.ts')
    fs.writeFileSync(enginePath, '// stale hand-edited engine\n')
    const tursoPath = path.join(consumer, 'packages/infra/modules/turso/index.ts')
    fs.mkdirSync(path.dirname(tursoPath), { recursive: true })
    fs.writeFileSync(tursoPath, '// stale turso\n')
    // A consumer-owned module the CLI knows nothing about.
    const minePath = path.join(consumer, 'packages/infra/modules/mine/index.ts')
    fs.mkdirSync(path.dirname(minePath), { recursive: true })
    fs.writeFileSync(minePath, 'export const mine = 1\n')

    const res = zbc(consumer, ['update'])
    expect(res.status).toBe(0)

    expect(fs.readFileSync(enginePath, 'utf8')).toBe(
      fs.readFileSync(path.join(TEMPLATES, 'src/define-module.ts'), 'utf8'),
    )
    expect(fs.readFileSync(tursoPath, 'utf8')).toBe(
      fs.readFileSync(path.join(TEMPLATES, 'modules/turso/index.ts'), 'utf8'),
    )
    // Consumer-owned code is never touched.
    expect(fs.readFileSync(minePath, 'utf8')).toBe('export const mine = 1\n')
    // A built-in module the project never added is not pulled in.
    expect(fs.existsSync(path.join(consumer, 'packages/infra/modules/r2'))).toBe(false)
  })

  test('records the refreshed vintage so the next apply is quiet', () => {
    const consumer = initCopy()
    fs.writeFileSync(
      path.join(consumer, '.zbc-vendor.json'),
      JSON.stringify({ mode: 'copy', cliVersion: '0.0.1', vendoredAt: '2026-01-01T00:00:00.000Z' }),
    )
    expect(zbc(consumer, ['update']).status).toBe(0)
    const stamp = JSON.parse(
      fs.readFileSync(path.join(consumer, '.zbc-vendor.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(stamp.mode).toBe('copy')
    expect(stamp.cliVersion).not.toBe('0.0.1')
  })

  test('never writes through a symlinked engine dir', () => {
    const consumer = initCopy()
    const srcDir = path.join(consumer, 'packages/infra/src')
    const real = tmpdir('linked-src-')
    fs.writeFileSync(path.join(real, 'define-module.ts'), '// linked\n')
    fs.rmSync(srcDir, { recursive: true, force: true })
    fs.symlinkSync(real, srcDir)

    const res = zbc(consumer, ['update'])
    expect(res.status).toBe(0)
    expect(res.out).toMatch(/symlink/i)
    expect(fs.readFileSync(path.join(real, 'define-module.ts'), 'utf8')).toBe('// linked\n')
  })
})
