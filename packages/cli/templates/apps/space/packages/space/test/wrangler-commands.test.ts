// The commands zbc's apply runs in this folder besides the deploy (the project's Worker module and its database module): `wrangler d1 migrations apply forms-records --remote` (the instance's D1 entry migrates by default) and
// `wrangler secret put <name>` for each Worker secret. Neither takes the deploy's redirect to dist/space/wrangler.json; both look for a config in the folder, and with none they fail ("No configuration file found",
// "Required Worker name missing"). The Worker's settings are made by the install kit and written by the build as wrangler.json here (vite.config.ts), which is what these tests keep true: they run the real commands
// against the generated file, locally and with no credentials, so the only thing that can fail is the config being found.
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NORTHFIELD_DECLARATION_FILE } from '../../workspace/northfield/paths'

const root = fileURLToPath(new URL('..', import.meta.url))
const wrangler = `${root}node_modules/.bin/wrangler`

/** Loads the build's config, which writes wrangler.json (and builds nothing, so the dist other suites read is left alone). */
const LOAD_CONFIG = "import { loadConfigFromFile } from 'vite'; await loadConfigFromFile({ command: 'build', mode: 'production' }, undefined, process.cwd())"

function run(args: string[]) {
  const done = Bun.spawnSync([wrangler, ...args], { cwd: root, env: { ...process.env, CLOUDFLARE_API_TOKEN: 'not-a-real-token', CLOUDFLARE_ACCOUNT_ID: '0000000000000000000000000000a001' }, stdout: 'pipe', stderr: 'pipe', timeout: 90_000 })
  return { code: done.exitCode, text: `${done.stdout.toString()}\n${done.stderr.toString()}` }
}

beforeAll(() => {
  const loaded = Bun.spawnSync(['bun', '-e', LOAD_CONFIG], { cwd: root, env: { ...process.env, SPACE_DECLARATION: NORTHFIELD_DECLARATION_FILE }, stderr: 'pipe' })
  expect(loaded.exitCode, loaded.stderr.toString()).toBe(0)
}, 60_000)

describe('wrangler finds the Worker’s settings for the commands the apply runs besides the deploy', () => {
  test('the build wrote them where wrangler looks: wrangler.json in this folder, for the install’s Worker', () => {
    expect(existsSync(`${root}wrangler.json`)).toBe(true)
    const written = JSON.parse(readFileSync(`${root}wrangler.json`, 'utf8')) as { name: string; d1_databases: { database_name: string; migrations_dir: string }[] }
    expect(written.name).toBe('space')
    expect(written.d1_databases).toEqual([expect.objectContaining({ database_name: 'forms-records', migrations_dir: '../forms/migrations' })])
  })

  test('d1 migrations list finds the database and forms’ migrations folder from it', () => {
    const r = run(['d1', 'migrations', 'list', 'forms-records', '--local'])
    expect(r.text).not.toContain('No configuration file found')
    expect(r.code, r.text).toBe(0)
    expect(r.text).toContain('0001_')
  })

  test('secret commands know the Worker’s name from it: they get as far as asking Cloudflare, and never stop at "Required Worker name missing"', () => {
    const r = run(['secret', 'list'])
    expect(r.text).not.toContain('Required Worker name missing')
    expect(r.text).not.toContain('No configuration file found')
  })
})
