// A reviewer's containment is the same as the coding profile's, minus the
// ability to write. These pin both halves: the missing write tools, which are
// the profile's whole point and would go unnoticed if they came back, and the
// sandbox invariants they sit inside.
import { execFile as execFileCb } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  REVIEW_MODEL,
  REVIEW_PROMPT,
  REVIEW_TOOLS,
  reviewPrompt,
  reviewer,
  reviewerOptions,
} from './review'
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

test('a reviewer cannot write — no Write, no Edit', () => {
  // The point of the profile. An agent that can edit what it is reviewing is a
  // second author, and its review is a description of its own work.
  const o = reviewerOptions(ws)
  expect(o.tools).not.toContain('Write')
  expect(o.tools).not.toContain('Edit')
  expect(REVIEW_TOOLS).not.toContain('Write')
  expect(REVIEW_TOOLS).not.toContain('Edit')
})

test('it keeps Bash for git, and Grep/Glob by name', () => {
  // Bash is how `git diff` and `git log` happen. Grep/Glob are named because
  // the SDK defers them behind ToolSearch whenever Bash is present.
  expect(reviewerOptions(ws).tools).toEqual([...REVIEW_TOOLS])
  expect(REVIEW_TOOLS).toContain('Bash')
  expect(REVIEW_TOOLS).toContain('Grep')
  expect(REVIEW_TOOLS).toContain('Glob')
})

test('no web tools, since strictAllowlist would block their egress anyway', () => {
  expect(REVIEW_TOOLS).not.toContain('WebSearch')
  expect(REVIEW_TOOLS).not.toContain('WebFetch')
})

test('the profile is Opus 5 at high effort — the opposite of coding', () => {
  const o = reviewerOptions(ws)
  expect(o.model).toBe(REVIEW_MODEL)
  // Already the Opus 5 default, but stated so it has to be undone on purpose.
  expect(o.effort).toBe('high')
  // Orthogonal to effort — separate fields on the wire.
  expect(o.thinking).toEqual({ type: 'adaptive' })
})

test('no preset: the Claude Code prompt steers towards implementing changes', () => {
  const o = reviewerOptions(ws)
  expect(typeof o.systemPrompt).toBe('string')
  expect(o.systemPrompt).toBe(REVIEW_PROMPT)
})

test('the prompt asks for what makes a review worth reading', () => {
  // Kept under 1200 characters: it is paid once per request, and length here
  // buys nothing this shape of review needs.
  expect(REVIEW_PROMPT.length).toBeLessThan(1200)
  expect(REVIEW_PROMPT).toContain('file:line')
  expect(REVIEW_PROMPT).toContain('severity')
  // Say nothing rather than pad with style nits.
  expect(REVIEW_PROMPT).toContain('Report nothing rather than pad')
  expect(REVIEW_PROMPT).toMatch(/do not change it|never modify/i)
})

test('the target is passed through verbatim, ref range or path', () => {
  expect(reviewPrompt('main..feature')).toContain('main..feature')
  expect(reviewPrompt('packages/agent/src')).toContain('packages/agent/src')
})

test('privacy and traffic levers survive the profile', () => {
  const o = reviewerOptions(ws)
  expect(o.settings).toMatchObject({ autoMemoryEnabled: false, disableClaudeAiConnectors: true })
  expect(o.env?.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
  expect(o.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
  expect(o.strictMcpConfig).toBe(true)
  expect(o.mcpServers).toEqual({})
})

test('project settings load, which is safe only because cwd is outside $HOME', () => {
  // CLAUDE.md discovery walks up the tree. From a repo under $HOME this would
  // also pull in the user's home-directory CLAUDE.md.
  const o = reviewerOptions(ws)
  expect(o.settingSources).toEqual(['project'])
  expect(String(o.cwd).startsWith(homedir())).toBe(false)
  expect(o.cwd).toBe(ws.dir)
})

test('git config is redirected into the workspace, not allow-listed out of $HOME', () => {
  const o = reviewerOptions(ws)
  expect(o.env?.GIT_CONFIG_GLOBAL).toBe(join(ws.home, 'gitconfig'))
  expect(o.env?.XDG_CONFIG_HOME).toBe(join(ws.home, 'xdg'))
})

test('HOME is never redirected; CLAUDE_CONFIG_DIR always is', () => {
  const o = reviewerOptions(ws)
  // Redirecting HOME hides the login Keychain and raises a system dialog.
  expect(o.env?.HOME).toBe(process.env.HOME)
  // CLAUDE_CONFIG_DIR is the opposite: the CLI creates session-env/<uuid> under
  // it before running any Bash command, and $HOME/.claude is denied — so
  // leaving it alone breaks every Bash call, not just the config.
  expect(o.env?.CLAUDE_CONFIG_DIR).toBe(join(ws.home, 'claude'))
})

test('the CLI is spawned through the workspace shim, and the SDK sandbox is off', () => {
  const o = reviewerOptions(ws)
  // The shim runs the real binary inside sandbox-runtime, so
  // the in-process tools a reviewer lives on — Read, Grep, Glob — are contained
  // too. Under the SDK's sandbox they were not: only Bash ever reached the
  // kernel, and `denyRead` did nothing to a `Read` call.
  expect(o.pathToClaudeCodeExecutable).toBe(ws.shim)
  // Must stay absent. The kernel refuses sandbox_apply inside a sandbox, so
  // enabling it kills every Bash command with exit 71.
  expect(o.sandbox).toBeUndefined()
  // Bypassing prompts is safe only because the kernel is enforcing instead.
  expect(o.permissionMode).toBe('bypassPermissions')
  expect(o.allowDangerouslySkipPermissions).toBe(true)
})

test('overrides win, without reaching the containment', () => {
  const o = reviewerOptions(ws, {
    overrides: { model: 'claude-haiku-4-5', tools: ['Read'], effort: 'low' },
  })
  expect(o.model).toBe('claude-haiku-4-5')
  expect(o.tools).toEqual(['Read'])
  expect(o.effort).toBe('low')
  // Overrides are spread into minimalOptions, which has no way to express the
  // boundary — so there is no override that can weaken it.
  expect(o.pathToClaudeCodeExecutable).toBe(ws.shim)
  expect(o.sandbox).toBeUndefined()
})

test('an override env bag cannot re-enable attribution or extra traffic', () => {
  const o = reviewerOptions(ws, {
    overrides: { env: { CLAUDE_CODE_ATTRIBUTION_HEADER: '1', FOO: 'bar' } },
  })
  expect(o.env?.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
  expect(o.env?.FOO).toBe('bar')
})

test('description is metadata and never reaches the wire', () => {
  expect(JSON.stringify(reviewerOptions(ws))).not.toContain(reviewer.description)
})

test('maxTurns is omitted unless asked for', () => {
  expect('maxTurns' in reviewerOptions(ws)).toBe(false)
  expect(reviewerOptions(ws, { maxTurns: 8 }).maxTurns).toBe(8)
})

test('the operator environment is not inherited — only an allowlist', () => {
  // denyRead protects a credential *file*; nothing protects a credential
  // *value* in the environment, and an agent with Bash only has to run `env`.
  // CI sets SOPS_AGE_KEY at the step level, which decrypts every environment.
  process.env.ZBC_FAKE_SECRET = 'sops-age-key-would-be-here'
  try {
    const env = reviewerOptions(ws).env ?? {}
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
    const env = reviewerOptions(ws, { overrides: { inheritEnv: true } }).env ?? {}
    expect(env.ZBC_FAKE_SECRET).toBeUndefined()

    const named =
      reviewerOptions(ws, { overrides: { env: { GITHUB_TOKEN: 'explicit' } } }).env ?? {}
    expect(named.GITHUB_TOKEN).toBe('explicit')
  } finally {
    delete process.env.ZBC_FAKE_SECRET
  }
})
