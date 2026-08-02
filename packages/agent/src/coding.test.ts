// What the coding profile *is*. The containment it sits inside is asserted once
// for every sandboxed profile in sandboxed.test.ts, not again here.
import { execFile as execFileCb } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { CODING_MODEL, CODING_TOOLS, codingOptions } from './coding'
import { type Workspace, createWorkspace } from './workspace'

const execFile = promisify(execFileCb)
const git = async (args: string[]) => (await execFile('git', args)).stdout.trim()

let ws: Workspace
let origin: string

// A credential must be present before a workspace will build one — the sandbox
// denies the Keychain, so there is nothing to fall back to. These tests never
// reach the network, so a placeholder is enough.
const HAD_CREDENTIAL = process.env.CLAUDE_CODE_OAUTH_TOKEN !== undefined
if (!HAD_CREDENTIAL) process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-placeholder'

beforeAll(async () => {
  origin = await mkdtemp(join(tmpdir(), 'zbc-origin-'))
  await git(['init', '--quiet', '-b', 'main', origin])
  await git(['-C', origin, 'config', 'user.email', 'host@test'])
  await git(['-C', origin, 'config', 'user.name', 'host'])
  await writeFile(join(origin, 'README.md'), '# fixture\n')
  await git(['-C', origin, 'add', '-A'])
  await git(['-C', origin, 'commit', '--quiet', '-m', 'init'])
  ws = await createWorkspace({ repo: origin })
})

afterAll(async () => {
  await ws?.dispose().catch(() => {})
  await execFile('rm', ['-rf', origin])
})

test('the profile is Opus 5 at low effort', () => {
  const o = codingOptions(ws)
  expect(o.model).toBe(CODING_MODEL)
  // Not a no-op: saying nothing sends effort 'high' on Opus 5.
  expect(o.effort).toBe('low')
  // Orthogonal to effort — separate fields on the wire.
  expect(o.thinking).toEqual({ type: 'adaptive' })
})

test('it carries the coding tools, Grep and Glob included', () => {
  // Named explicitly because the SDK defers them behind ToolSearch when Bash
  // is present.
  expect(codingOptions(ws).tools).toEqual([...CODING_TOOLS])
  expect(CODING_TOOLS).toContain('Grep')
  expect(CODING_TOOLS).toContain('Glob')
})

test('it uses the Claude Code preset with dynamic sections excluded', () => {
  // The SDK default is a 62-character identity line with no coding guidance.
  expect(codingOptions(ws).systemPrompt).toEqual({
    type: 'preset',
    preset: 'claude_code',
    excludeDynamicSections: true,
  })
})
