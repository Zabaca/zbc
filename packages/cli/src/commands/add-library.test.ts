import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * A shared library is a registry kind, and a manifest may name the sibling
 * directories its code imports.
 *
 * Both halves exist because the same sentence had been written by hand into
 * six manifests' `instructions` — "in COPY mode run `zbc add host-exec` too" —
 * which is a dangling relative import waiting for whoever does not read it.
 * These tests spawn the real CLI into a throwaway project: what they assert is
 * what lands on disk and what the caller is told, not how `add.ts` is shaped.
 */

const CLI = path.resolve(import.meta.dir, '../index.ts')

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

/** A copy-mode project: no vendor/zbc, so `zbc add` vendors into packages/infra. */
function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbc-add-library-'))
  roots.push(dir)
  fs.writeFileSync(
    path.join(dir, 'zbc.config.ts'),
    "export default { project: 'p', environments: ['production'] }\n",
  )
  fs.mkdirSync(path.join(dir, 'packages/infra'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'packages/infra/package.json'),
    '{"name":"@p/infra","version":"0.0.0"}\n',
  )
  return dir
}

function zbc(cwd: string, args: string[]): { status: number; out: string } {
  const res = spawnSync('bun', [CLI, ...args], { cwd, encoding: 'utf8' })
  return { status: res.status ?? -1, out: `${res.stdout}\n${res.stderr}` }
}

test('a module brings the library it imports, transitively', () => {
  const dir = project()
  // vm-provision imports `../host-exec`, `../incus-core` and `../provision-core`;
  // incus-core in turn imports `../host-exec`. One command, four directories.
  const res = zbc(dir, ['add', 'vm-provision', '--no-prompt'])
  expect(res.out).toContain('vm-provision')
  expect(res.status).toBe(0)

  const modules = path.join(dir, 'packages/infra/modules')
  for (const name of ['vm-provision', 'host-exec', 'incus-core', 'provision-core']) {
    expect(fs.existsSync(path.join(modules, name, 'index.ts'))).toBe(true)
    expect(fs.existsSync(path.join(modules, name, 'registry.json'))).toBe(true)
  }
  // incus-core ships two more files beside index.ts — a dependency is installed
  // by its own manifest, not by copying one file and hoping.
  expect(fs.existsSync(path.join(modules, 'incus-core/config-set-help.ts'))).toBe(true)
})

test('a library is added as a library — no instance file to write', () => {
  const dir = project()
  const res = zbc(dir, ['add', 'cloudflare-api', '--no-prompt'])
  expect(res.status).toBe(0)
  expect(res.out).toContain('library')
  // The line every module install ends with. A library has no `instance()`.
  expect(res.out).not.toContain('create an instance file')
})

test('a library is refused as an instance-bearing module would be misread', () => {
  const dir = project()
  const res = zbc(dir, ['add', 'no-such-library', '--no-prompt'])
  expect(res.status).not.toBe(0)
})
