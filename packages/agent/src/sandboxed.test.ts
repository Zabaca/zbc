// Containment invariants, asserted once per profile rather than once per file.
//
// These used to live copied into coding.test.ts and review.test.ts, which meant
// a third sandboxed profile got full coverage only if someone remembered to copy
// eleven tests. Now it gets them by appearing in the table below.
import { execFile as execFileCb } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { coding } from './coding'
import { ESSENTIAL_ENV } from './index'
import { reviewer } from './review'
import { type SandboxedProfile, runSandboxed, sandboxedOptions } from './sandboxed'
import { type Workspace, createWorkspace } from './workspace'

const execFile = promisify(execFileCb)
const git = async (args: string[]) => (await execFile('git', args)).stdout.trim()

// A credential must be present before a workspace will build one — the sandbox
// denies the Keychain, so there is nothing to fall back to. These tests never
// reach the network, so a placeholder is enough.
if (process.env.CLAUDE_CODE_OAUTH_TOKEN === undefined) {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-placeholder'
}

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

const PROFILES: Array<[string, SandboxedProfile]> = [
  ['coding', coding],
  ['review', reviewer],
]

test('resuming without the original workspace is refused, not silently restarted', async () => {
  // Session transcripts live under CLAUDE_CONFIG_DIR, which points inside the
  // workspace. A fresh workspace has no history, so the agent would start over
  // and the caller would see a plausible answer to the wrong conversation.
  await expect(runSandboxed(coding, 'anything', { resume: 'some-session-id' })).rejects.toThrow(
    /resume needs the workspace/,
  )
})

test('a borrowed workspace survives a failed run', async () => {
  // The caller passed it in because it outlives the call; disposing it on error
  // would throw away work from earlier runs in the same session.
  const borrowed = await createWorkspace({ repo: origin })
  await expect(
    runSandboxed(coding, 'anything', {
      workspace: borrowed,
      // No credential reaches the wire: an impossible model fails at the CLI.
      overrides: { model: 'no-such-model-zbc-test' },
      maxTurns: 1,
    }),
  ).rejects.toThrow()
  expect(existsSync(borrowed.dir)).toBe(true)
  await borrowed.dispose()
})

for (const [name, profile] of PROFILES) {
  describe(name, () => {
    test('runs the CLI through the workspace shim, with the SDK sandbox off', () => {
      const o = sandboxedOptions(profile, ws)
      // The shim runs the real binary inside sandbox-runtime, so the in-process
      // tools are contained too. Under the SDK's sandbox they were not: only
      // Bash reached the kernel, and `denyRead` did nothing to a `Read` call.
      expect(o.pathToClaudeCodeExecutable).toBe(ws.shim)
      // Must stay absent. The kernel refuses sandbox_apply inside a sandbox, so
      // enabling it kills every Bash command with exit 71.
      expect(o.sandbox).toBeUndefined()
      // Bypassing prompts is safe only because the kernel is enforcing instead.
      expect(o.permissionMode).toBe('bypassPermissions')
      expect(o.allowDangerouslySkipPermissions).toBe(true)
    })

    test('works outside $HOME, which is what lets the sandbox deny it', () => {
      const o = sandboxedOptions(profile, ws)
      expect(o.cwd).toBe(ws.dir)
      expect(String(o.cwd).startsWith(homedir())).toBe(false)
      // Safe only because of the line above: CLAUDE.md discovery walks up the
      // tree, and from a repo under $HOME it also loads the operator's own.
      expect(o.settingSources).toEqual(['project'])
    })

    test('toolchain config is redirected into the workspace', () => {
      const o = sandboxedOptions(profile, ws)
      expect(o.env?.GIT_CONFIG_GLOBAL).toBe(join(ws.home, 'gitconfig'))
      expect(o.env?.XDG_CONFIG_HOME).toBe(join(ws.home, 'xdg'))
      // Load-bearing: the CLI creates session-env/<uuid> under this before it
      // will run any Bash command, and $HOME/.claude is denied.
      expect(o.env?.CLAUDE_CONFIG_DIR).toBe(join(ws.home, 'claude'))
      // Never redirected — it hides the login Keychain and raises a dialog.
      expect(o.env?.HOME).toBe(process.env.HOME)
    })

    test('the operator environment is not inherited — only an allowlist', () => {
      // The sandbox protects a credential *file*; nothing protects a credential
      // *value* in the environment, and an agent with Bash only has to run
      // `env`. CI sets SOPS_AGE_KEY at the step level, which decrypts every
      // environment.
      process.env.ZBC_FAKE_SECRET = 'sops-age-key-would-be-here'
      try {
        const env = sandboxedOptions(profile, ws).env ?? {}
        expect(env.ZBC_FAKE_SECRET).toBeUndefined()
        for (const key of ESSENTIAL_ENV) {
          if (process.env[key] !== undefined) expect(env[key]).toBe(process.env[key])
        }
      } finally {
        delete process.env.ZBC_FAKE_SECRET
      }
    })

    test('an override cannot re-inherit the environment, but can name what it needs', () => {
      process.env.ZBC_FAKE_SECRET = 'still-secret'
      try {
        const reinherited = sandboxedOptions(profile, ws, { overrides: { inheritEnv: true } })
        expect(reinherited.env?.ZBC_FAKE_SECRET).toBeUndefined()

        const named = sandboxedOptions(profile, ws, {
          overrides: { env: { GITHUB_TOKEN: 'explicit' } },
        })
        expect(named.env?.GITHUB_TOKEN).toBe('explicit')
      } finally {
        delete process.env.ZBC_FAKE_SECRET
      }
    })

    test('overrides win, without reaching the containment', () => {
      const o = sandboxedOptions(profile, ws, {
        overrides: { model: 'claude-haiku-4-5', tools: ['Read'], effort: 'low' },
      })
      expect(o.model).toBe('claude-haiku-4-5')
      expect(o.tools).toEqual(['Read'])
      // Overrides are spread into minimalOptions, which has no way to express
      // the boundary — so there is no override that can weaken it.
      expect(o.pathToClaudeCodeExecutable).toBe(ws.shim)
      expect(o.sandbox).toBeUndefined()
    })

    test('privacy and traffic levers survive the profile', () => {
      const o = sandboxedOptions(profile, ws)
      expect(o.settings).toMatchObject({
        autoMemoryEnabled: false,
        disableClaudeAiConnectors: true,
      })
      expect(o.env?.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
      expect(o.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
      expect(o.strictMcpConfig).toBe(true)
      expect(o.mcpServers).toEqual({})
    })

    test('an override env bag cannot re-enable attribution or extra traffic', () => {
      const o = sandboxedOptions(profile, ws, {
        overrides: { env: { CLAUDE_CODE_ATTRIBUTION_HEADER: '1', FOO: 'bar' } },
      })
      expect(o.env?.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
      expect(o.env?.FOO).toBe('bar')
    })

    test('no web tools — the egress allowlist would block them anyway', () => {
      const tools = sandboxedOptions(profile, ws).tools ?? []
      expect(tools).not.toContain('WebSearch')
      expect(tools).not.toContain('WebFetch')
    })

    test('description and prompt are metadata and never reach the wire', () => {
      const serialised = JSON.stringify(sandboxedOptions(profile, ws))
      expect(serialised).not.toContain(profile.description)
      expect(serialised).not.toContain('"prompt"')
    })

    test('maxTurns is omitted unless asked for', () => {
      expect('maxTurns' in sandboxedOptions(profile, ws)).toBe(false)
      expect(sandboxedOptions(profile, ws, { maxTurns: 9 }).maxTurns).toBe(9)
    })

    test('resume is omitted unless asked for', () => {
      expect('resume' in sandboxedOptions(profile, ws)).toBe(false)
      expect(sandboxedOptions(profile, ws, { resume: 'abc' }).resume).toBe('abc')
    })
  })
}
