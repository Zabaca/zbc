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
import { ESSENTIAL_ENV } from './index'
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

test('HOME is never redirected; CLAUDE_CONFIG_DIR always is', () => {
  const o = codingOptions(ws)
  // Redirecting HOME hides the login Keychain and raises a system dialog.
  expect(o.env?.HOME).toBe(process.env.HOME)
  // CLAUDE_CONFIG_DIR is the opposite: the CLI creates session-env/<uuid> under
  // it before running any Bash command, and $HOME/.claude is denied — so
  // leaving it alone breaks every Bash call, not just the config.
  expect(o.env?.CLAUDE_CONFIG_DIR).toBe(join(ws.home, 'claude'))
})

test('the CLI is spawned through the workspace shim, and the SDK sandbox is off', () => {
  const o = codingOptions(ws)
  // The shim runs the real binary inside sandbox-runtime, so
  // in-process tools (Read, Grep, Glob) are contained too. The SDK's own
  // sandbox must stay absent: the kernel refuses sandbox_apply inside a
  // sandbox, so enabling it kills every Bash command with exit 71.
  expect(o.pathToClaudeCodeExecutable).toBe(ws.shim)
  expect(o.sandbox).toBeUndefined()
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
  // An override reaches minimalOptions, never the containment.
  expect(o.pathToClaudeCodeExecutable).toBe(ws.shim)
  expect(o.sandbox).toBeUndefined()
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

test('the operator environment is not inherited — only an allowlist', () => {
  // denyRead protects a credential *file*; nothing protects a credential
  // *value* in the environment, and an agent with Bash only has to run `env`.
  // CI sets SOPS_AGE_KEY at the step level, which decrypts every environment.
  process.env.ZBC_FAKE_SECRET = 'sops-age-key-would-be-here'
  try {
    const env = codingOptions(ws).env ?? {}
    expect(env.ZBC_FAKE_SECRET).toBeUndefined()
    for (const name of ESSENTIAL_ENV) {
      if (process.env[name] !== undefined) expect(env[name]).toBe(process.env[name])
    }
  } finally {
    delete process.env.ZBC_FAKE_SECRET
  }
})

test('an override cannot re-inherit the environment, but can name what it needs', () => {
  process.env.ZBC_FAKE_SECRET = 'still-secret'
  try {
    const env = codingOptions(ws, { overrides: { inheritEnv: true } }).env ?? {}
    expect(env.ZBC_FAKE_SECRET).toBeUndefined()

    const named = codingOptions(ws, { overrides: { env: { GITHUB_TOKEN: 'explicit' } } }).env ?? {}
    expect(named.GITHUB_TOKEN).toBe('explicit')
  } finally {
    delete process.env.ZBC_FAKE_SECRET
  }
})
