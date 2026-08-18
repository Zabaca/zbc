import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * `zbc add <unknown>` tells the caller what it could have asked for, and that
 * sentence is the only place the built-in registry is enumerated for a human.
 *
 * It was a hand-written literal, and it went stale the first time modules were
 * added to `templates/infra/modules/` — the four host primitives contributed
 * from foundry on 2026-08-18 resolved perfectly well and were named nowhere, so
 * the only way to discover them was to already know they existed. Every other
 * "Available:" in this CLI computes its list (`apply.ts`, `destroy.ts`,
 * `engine/resolve.ts` all join a live array); this one is now the same shape,
 * and this file is what stops it drifting back.
 *
 * The census is walked here with `readdirSync`, where the implementation globs
 * through `Bun.file(...).exists()`. Two different mechanisms on purpose: a test
 * that recomputed the implementation would agree with it while both were wrong.
 */

const CLI = path.resolve(import.meta.dir, '../index.ts')
const MODULES = path.resolve(import.meta.dir, '../../templates/infra/modules')
const APPS = path.resolve(import.meta.dir, '../../templates/apps')

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

/** Directories holding a registry.json — what `zbc add` can actually resolve. */
function census(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'registry.json')))
    .map((e) => e.name)
    .toSorted()
}

/** The smallest tree `zbc add` will get as far as resolution in. */
function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbc-add-registry-'))
  roots.push(dir)
  fs.writeFileSync(
    path.join(dir, 'zbc.config.ts'),
    "export default { project: 'p', environments: ['production'] }\n",
  )
  fs.mkdirSync(path.join(dir, 'packages/infra'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'packages/infra/package.json'), '{"name":"@p/infra"}\n')
  return dir
}

/** citty wraps and colours its error line, so flatten before matching — a
 *  line-oriented match cannot see a claim that wrapped. */
function addUnknown(): string {
  const res = spawnSync('bun', [CLI, 'add', 'no-such-module', '--no-prompt'], {
    cwd: project(),
    encoding: 'utf8',
  })
  expect(res.status).not.toBe(0)
  return `${res.stdout}\n${res.stderr}`.replace(/\s+/g, ' ')
}

test('the built-in registry census is non-empty and holds the promoted host primitives', () => {
  const modules = census(MODULES)
  const apps = census(APPS)
  // Floors, because every assertion below is vacuously true against an empty
  // walk — a mistyped MODULES would otherwise pass silently.
  expect(modules.length).toBeGreaterThanOrEqual(12)
  expect(apps.length).toBeGreaterThanOrEqual(3)
  // Named rather than counted: the group this file exists because of.
  expect(modules).toContain('host-dir')
  expect(modules).toContain('host-exec')
  expect(modules).toContain('host-symlink')
  expect(modules).toContain('systemd-mask')
})

test('`zbc add <unknown>` names every module and app it could have resolved', () => {
  const expected = [...census(MODULES), ...census(APPS)].toSorted()
  const listed = addUnknown()
    .match(/Available: ([^.]+)\./)?.[1]
    .split(',')
    .map((s) => s.trim())
    .toSorted()

  // Set equality, not substring containment: "cloudflare" is a prefix of
  // "cloudflare-token", so a `toContain` sweep passes on a list missing the
  // short name entirely.
  expect(listed).toEqual(expected)
})
