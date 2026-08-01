// The coding profile deliberately spends tokens the base module exists to save,
// so these pin the things that must survive that trade — the privacy levers and
// the containment — rather than the token count itself.
import { execFile as execFileCb } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { CODING_MODEL, CODING_TOOLS, coding, codingOptions } from './coding'
import { type Workspace, createWorkspace } from './workspace'

const execFile = promisify(execFileCb)
const git = async (args: string[]) => (await execFile('git', args)).stdout.trim()

let ws: Workspace
let origin: string

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

test('no web tools, since strictAllowlist would block their egress anyway', () => {
  expect(CODING_TOOLS).not.toContain('WebSearch')
  expect(CODING_TOOLS).not.toContain('WebFetch')
})

test('it uses the Claude Code preset with dynamic sections excluded', () => {
  // The SDK default is a 62-character identity line with no coding guidance.
  expect(codingOptions(ws).systemPrompt).toEqual({
    type: 'preset',
    preset: 'claude_code',
    excludeDynamicSections: true,
  })
})

test('privacy and traffic levers survive the profile', () => {
  const o = codingOptions(ws)
  expect(o.settings).toMatchObject({ autoMemoryEnabled: false, disableClaudeAiConnectors: true })
  expect(o.env?.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
  expect(o.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
  expect(o.strictMcpConfig).toBe(true)
  expect(o.mcpServers).toEqual({})
})

test('project settings load, which is safe only because cwd is outside $HOME', () => {
  // CLAUDE.md discovery walks up the tree. From a repo under $HOME this would
  // also pull in the user's home-directory CLAUDE.md.
  const o = codingOptions(ws)
  expect(o.settingSources).toEqual(['project'])
  expect(String(o.cwd).startsWith(homedir())).toBe(false)
  expect(o.cwd).toBe(ws.dir)
})

test('git config is redirected into the workspace, not allow-listed out of $HOME', () => {
  const o = codingOptions(ws)
  expect(o.env?.GIT_CONFIG_GLOBAL).toBe(join(ws.home, 'gitconfig'))
  expect(o.env?.XDG_CONFIG_HOME).toBe(join(ws.home, 'xdg'))
})

test('neither HOME nor CLAUDE_CONFIG_DIR is set — both break authentication', () => {
  // HOME hides the login Keychain and raises a system dialog; CLAUDE_CONFIG_DIR
  // fails even when set to its own default value.
  const o = codingOptions(ws)
  expect(o.env?.HOME).toBe(process.env.HOME)
  expect(o.env?.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR)
})

test('the sandbox is attached, and permissions are bypassed only behind it', () => {
  const o = codingOptions(ws)
  expect(o.sandbox?.enabled).toBe(true)
  expect(o.sandbox?.allowUnsandboxedCommands).toBe(false)
  // Bypassing prompts is safe only because the kernel is enforcing instead.
  expect(o.permissionMode).toBe('bypassPermissions')
  expect(o.allowDangerouslySkipPermissions).toBe(true)
})

test('overrides win, without weakening the sandbox', () => {
  const o = codingOptions(ws, {
    overrides: { model: 'claude-haiku-4-5', tools: ['Read'], effort: 'high' },
  })
  expect(o.model).toBe('claude-haiku-4-5')
  expect(o.tools).toEqual(['Read'])
  expect(o.effort).toBe('high')
  expect(o.sandbox?.allowUnsandboxedCommands).toBe(false)
  expect(o.sandbox?.filesystem?.denyRead).toEqual([homedir()])
})

test('an override env bag cannot re-enable attribution or extra traffic', () => {
  const o = codingOptions(ws, {
    overrides: { env: { CLAUDE_CODE_ATTRIBUTION_HEADER: '1', FOO: 'bar' } },
  })
  expect(o.env?.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
  expect(o.env?.FOO).toBe('bar')
})

test('description is metadata and never reaches the wire', () => {
  expect(JSON.stringify(codingOptions(ws))).not.toContain(coding.description)
})

test('maxTurns is omitted unless asked for', () => {
  expect('maxTurns' in codingOptions(ws)).toBe(false)
  expect(codingOptions(ws, { maxTurns: 12 }).maxTurns).toBe(12)
})
