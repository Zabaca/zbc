import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { age, bytes, findProjectRoot, sopsPath } from './cf'

// A zbc project is `zbc.config.ts` plus secrets at the conventional path. c9s
// finds them by walking up from the cwd, which is what lets one global install
// serve every project.

let tmp: string
const saved = { ...process.env }

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'c9s-'))
  delete process.env.C9S_SOPS_FILE
  delete process.env.C9S_ENV
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  process.env = { ...saved }
})

function project(name: string, envs: string[] = ['production']) {
  const root = join(tmp, name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'zbc.config.ts'), 'export default {}\n')
  for (const env of envs) {
    const dir = join(root, 'packages', 'infra', 'environments', env)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'secrets.yaml'), 'CLOUDFLARE_API_TOKEN: fake\n')
  }
  return root
}

test('finds the project root from any depth inside it', () => {
  const root = project('alpha')
  const deep = join(root, 'packages', 'infra', 'environments', 'production')
  expect(findProjectRoot(root)).toBe(root)
  expect(findProjectRoot(deep)).toBe(root)
})

test('returns nothing outside a zbc project', () => {
  const plain = join(tmp, 'not-a-project')
  mkdirSync(plain, { recursive: true })
  expect(findProjectRoot(plain)).toBeUndefined()
  expect(sopsPath(plain)).toBeUndefined()
})

test('the walk terminates at the filesystem root', () => {
  // Would hang or throw if the parent === dir guard were missing.
  expect(findProjectRoot('/')).toBeUndefined()
})

test('picks the nearest project when they nest', () => {
  const outer = project('outer')
  const inner = project(join('outer', 'packages', 'inner'))
  // The inner project must win over the one containing it, and its secrets with it.
  expect(findProjectRoot(inner)).toBe(inner)
  expect(findProjectRoot(inner)).not.toBe(outer)
  expect(sopsPath(inner)).toBe(join(inner, 'packages/infra/environments/production/secrets.yaml'))
  expect(findProjectRoot(outer)).toBe(outer)
})

test('two projects each resolve to their own secrets', () => {
  const a = project('alpha')
  const b = project('beta')
  expect(sopsPath(a)).toBe(join(a, 'packages/infra/environments/production/secrets.yaml'))
  expect(sopsPath(b)).toBe(join(b, 'packages/infra/environments/production/secrets.yaml'))
})

test('C9S_ENV selects the environment', () => {
  const root = project('alpha', ['production', 'staging'])
  process.env.C9S_ENV = 'staging'
  expect(sopsPath(root)).toBe(join(root, 'packages/infra/environments/staging/secrets.yaml'))
})

test('an environment with no secrets file resolves to nothing, not a bad path', () => {
  const root = project('alpha')
  process.env.C9S_ENV = 'preview'
  expect(sopsPath(root)).toBeUndefined()
})

test('C9S_SOPS_FILE wins over the project walk', () => {
  const root = project('alpha')
  process.env.C9S_SOPS_FILE = '/somewhere/else.yaml'
  expect(sopsPath(root)).toBe('/somewhere/else.yaml')
})

test('age renders compact units and tolerates junk', () => {
  const now = Date.now()
  expect(age(new Date(now - 5 * 60_000).toISOString())).toBe('5m')
  expect(age(new Date(now - 3 * 3_600_000).toISOString())).toBe('3h')
  expect(age(new Date(now - 4 * 86_400_000).toISOString())).toBe('4d')
  expect(age(undefined)).toBe('-')
  expect(age('not a date')).toBe('-')
})

test('bytes renders compact sizes', () => {
  expect(bytes(undefined)).toBe('-')
  expect(bytes(0)).toBe('0B')
  expect(bytes(733184)).toBe('716KB')
  expect(bytes(1536)).toBe('1.5KB')
})
