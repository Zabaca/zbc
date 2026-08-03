// Init is the step that makes a restored or freshly cloned workspace something
// an agent can build in. Its failure mode is silence — an agent that starts
// against missing dependencies looks like an agent having a bad day.
import { execFile as execFileCb } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { INSTALL_STEPS, type InitStep, initialize } from './initialize'
import { ALLOWED_DOMAINS } from './sandbox'
import { type Workspace, createWorkspace } from './workspace'

const execFile = promisify(execFileCb)
const git = async (args: string[]) => (await execFile('git', args)).stdout.trim()

if (process.env.CLAUDE_CODE_OAUTH_TOKEN === undefined) {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-placeholder'
}

let origin: string
const cleanup: Array<() => Promise<unknown>> = []

beforeAll(async () => {
  origin = await mkdtemp(join(tmpdir(), 'zbc-init-'))
  await git(['init', '--quiet', '-b', 'main', origin])
  await git(['-C', origin, 'config', 'user.email', 'host@test'])
  await git(['-C', origin, 'config', 'user.name', 'host'])
  await writeFile(join(origin, 'README.md'), '# fixture\n')
  await git(['-C', origin, 'add', '-A'])
  await git(['-C', origin, 'commit', '--quiet', '-m', 'init'])
})

afterAll(async () => {
  await Promise.all(cleanup.map((fn) => fn().catch(() => {})))
  await execFile('rm', ['-rf', origin])
})

async function workspace(): Promise<Workspace> {
  const ws = await createWorkspace({ repo: origin })
  cleanup.push(ws.dispose)
  return ws
}

test('a repository with no lockfile gets nothing', async () => {
  // Guessing an installer would write a lockfile and change the repository.
  const result = await initialize(await workspace())
  expect(result.steps).toEqual([])
})

test('the installer is chosen by lockfile, not by package.json', async () => {
  const ws = await workspace()
  await writeFile(join(ws.dir, 'package.json'), '{"name":"x"}')
  expect(INSTALL_STEPS.filter((s) => s.needed(ws))).toEqual([])

  await writeFile(join(ws.dir, 'bun.lock'), '')
  expect(INSTALL_STEPS.filter((s) => s.needed(ws)).map((s) => s.name)).toEqual(['bun install'])
})

test('it is idempotent — already-installed workspaces are skipped', async () => {
  // It cannot tell a cold workspace from a restored one, so every step has to
  // be safe to repeat.
  const ws = await workspace()
  await writeFile(join(ws.dir, 'bun.lock'), '')
  await execFile('mkdir', ['-p', join(ws.dir, 'node_modules')])
  expect((await initialize(ws)).steps).toEqual([])
})

test('a failing step throws, naming the step and the workspace', async () => {
  // The failure this guards is silence: the agent starts anyway, and spends its
  // turn debugging missing dependencies as though they were a code problem.
  const ws = await workspace()
  const doomed: InitStep[] = [
    { name: 'certain failure', needed: () => true, argv: ['/usr/bin/false'] },
  ]
  await expect(initialize(ws, doomed)).rejects.toThrow(/certain failure/)
  await expect(initialize(ws, doomed)).rejects.toThrow(/was not started/)
})

test('steps run inside the sandbox, never on the host', async () => {
  // `bun install` executes postinstall scripts from the target repository —
  // arbitrary code from the same untrusted input the sandbox exists to contain.
  // Running it host-side would reopen ADR 0002's hole through a different door.
  const ws = await workspace()
  const probe: InitStep[] = [
    {
      name: 'read $HOME',
      needed: () => true,
      argv: ['/bin/cat', join(process.env.HOME ?? '', '.zshrc')],
    },
  ]
  await expect(initialize(ws, probe)).rejects.toThrow(/Operation not permitted|not started/)
})

test('the sandbox reaches the registry, so an install can work at all', () => {
  expect(ALLOWED_DOMAINS).toContain('registry.npmjs.org')
  expect(ALLOWED_DOMAINS).toContain('api.anthropic.com')
})

test('a real install succeeds inside the sandbox', async () => {
  // The end-to-end claim: postinstall-capable tooling, network to the registry,
  // and a node_modules the agent can actually build against.
  const ws = await workspace()
  await writeFile(
    join(ws.dir, 'package.json'),
    JSON.stringify({ name: 'fixture', private: true, dependencies: { 'is-odd': '3.0.1' } }),
  )

  const result = await initialize(ws, [
    { name: 'bun install', needed: () => true, argv: ['bun', 'install'] },
  ])
  expect(result.steps).toEqual(['bun install'])
  expect(existsSync(join(ws.dir, 'node_modules', 'is-odd'))).toBe(true)
}, 120_000)
