// What the review profile *is* — chiefly the tools it does not have. The
// containment it sits inside is asserted once for every sandboxed profile in
// sandboxed.test.ts, not again here.
import { execFile as execFileCb } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { REVIEW_MODEL, REVIEW_PROMPT, REVIEW_TOOLS, reviewPrompt, reviewerOptions } from './review'
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
