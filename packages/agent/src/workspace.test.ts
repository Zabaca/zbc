// These assert containment invariants, not behaviour. Each one, if broken,
// leaves an agent that runs perfectly and is no longer contained — which is the
// failure mode nothing else in the repo would notice.
import { execFile as execFileCb } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, stat as statFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { ALLOWED_DOMAINS, DENIED_BINARIES, srtExecutable, srtSettings } from './sandbox'
import { AGENT_IDENTITY, collect, createWorkspace, workspaceEnv } from './workspace'

const execFile = promisify(execFileCb)
const git = async (args: string[]) => (await execFile('git', args)).stdout.trim()

let origin: string
const cleanup: Array<() => Promise<unknown>> = []

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
})

afterAll(async () => {
  await Promise.all(cleanup.map((fn) => fn().catch(() => {})))
  await execFile('rm', ['-rf', origin])
})

async function workspace(opts: Parameters<typeof createWorkspace>[0] = {}) {
  const ws = await createWorkspace({ repo: origin, ...opts })
  cleanup.push(ws.dispose)
  return ws
}

test('the clone is plain — no alternates borrowing from the origin', async () => {
  // A --shared/--reference clone reads into the denied path on the first
  // missing object, and the failure is remote from the cause.
  const ws = await workspace()
  expect(existsSync(join(ws.dir, '.git/objects/info/alternates'))).toBe(false)
  expect(existsSync(join(ws.dir, '.git'))).toBe(true)
})

test('the clone is a real repository, not a linked worktree', async () => {
  // A worktree's .git is a file pointing into the origin's .git/worktrees/,
  // which is inside the denied region — every git command would fail.
  const ws = await workspace()
  const gitPath = join(ws.dir, '.git')
  const stat = await readFile(gitPath).catch(() => null)
  expect(stat).toBeNull() // .git is a directory here, so reading it as a file fails
  expect(await git(['-C', ws.dir, 'rev-parse', '--show-toplevel'])).toBe(ws.dir)
})

test('the clone shares no inodes with the origin', async () => {
  // A hardlink is a second name for an inode, not a path, so no path-based
  // profile can filter it: writing through one inside the workspace corrupts the origin's
  // object store, and dispose() cannot undo that.
  const ws = await workspace()
  const linked = (
    await execFile('find', [join(ws.dir, '.git/objects'), '-type', 'f', '-links', '+1'])
  ).stdout.trim()
  expect(linked).toBe('')
})

test('the workspace lives outside $HOME, which is what lets the profile deny it', async () => {
  const ws = await workspace()
  expect(ws.dir.startsWith(homedir())).toBe(false)
})

test('a root inside $HOME is refused rather than silently uncontained', async () => {
  await expect(createWorkspace({ repo: origin, root: homedir() })).rejects.toThrow(/inside \$HOME/)
})

test('the $HOME guard sees through a symlinked root', async () => {
  // resolve() does not follow symlinks. Without a realpath the guard passes,
  // the workspace lands under $HOME, which the profile denies — leaving an agent
  // that cannot read its own workspace, an error a long way from its cause.
  const linkRoot = await mkdtemp(join(tmpdir(), 'zbc-link-'))
  const link = join(linkRoot, 'home-link')
  await execFile('ln', ['-s', homedir(), link])
  await expect(createWorkspace({ repo: origin, root: link })).rejects.toThrow(/inside \$HOME/)
  await execFile('rm', ['-rf', linkRoot])
})

test('a non-repository is refused with a useful message', async () => {
  const notARepo = await mkdtemp(join(tmpdir(), 'zbc-notrepo-'))
  await expect(createWorkspace({ repo: notARepo })).rejects.toThrow(/not a git repository/)
})

test('the agent gets its own git identity, so its commits are attributable', async () => {
  const ws = await workspace()
  const config = await readFile(join(ws.home, 'gitconfig'), 'utf8')
  expect(config).toContain(AGENT_IDENTITY.email)

  // Redirected via env, never by granting a path inside the denied $HOME.
  const env = workspaceEnv(ws)
  expect(env.GIT_CONFIG_GLOBAL).toBe(join(ws.home, 'gitconfig'))
  expect(env.XDG_CONFIG_HOME).toBe(join(ws.home, 'xdg'))
  expect('HOME' in env).toBe(false) // hides the login Keychain; 401s the CLI
})

test('work is checked out on its own branch, off the origin head', async () => {
  const ws = await workspace({ branch: 'agent/fixed-name' })
  expect(ws.branch).toBe('agent/fixed-name')
  expect(await git(['-C', ws.dir, 'rev-parse', '--abbrev-ref', 'HEAD'])).toBe('agent/fixed-name')
  expect(await git(['-C', ws.dir, 'rev-parse', 'HEAD'])).toBe(ws.base)
})

test('branch names are unique per workspace by default', async () => {
  const [a, b] = await Promise.all([workspace(), workspace()])
  expect(a.branch).not.toBe(b.branch)
})

test('collect fetches the branch into the real repository without merging', async () => {
  const ws = await workspace({ branch: 'agent/collect-me' })
  await writeFile(join(ws.dir, 'README.md'), '# fixture\nfrom the agent\n')
  await git(['-C', ws.dir, 'add', '-A'])
  await git(['-C', ws.dir, 'commit', '--quiet', '-m', 'agent: a change'])

  const result = await collect(ws)
  expect(result.commits).toHaveLength(1)
  expect(result.commits[0]).toContain('agent: a change')

  // The branch landed as a ref...
  expect(await git(['-C', origin, 'rev-parse', '--verify', 'agent/collect-me'])).toBeTruthy()
  // ...but main is untouched: merging is a human's decision.
  const head = await git(['-C', origin, 'show', 'main:README.md'])
  expect(head).not.toContain('from the agent')
})

test('collect on an idle agent reports nothing rather than failing', async () => {
  const ws = await workspace({ branch: 'agent/did-nothing' })
  const result = await collect(ws)
  expect(result.commits).toEqual([])
  // No ref is created for a branch with no work on it.
  await expect(git(['-C', origin, 'rev-parse', '--verify', 'agent/did-nothing'])).rejects.toThrow()
})

test('dispose removes the whole tree', async () => {
  const ws = await createWorkspace({ repo: origin })
  expect(existsSync(ws.dir)).toBe(true)
  await ws.dispose()
  expect(existsSync(ws.root)).toBe(false)
  await ws.dispose() // idempotent
})

test('reads are denied by default, not by a list of remembered secrets', async () => {
  const ws = await workspace()
  const { filesystem } = srtSettings(ws)

  // srt ships the opposite default — reads allowed everywhere, with a built-in
  // denylist of credential paths. Denying the root inverts it: ~/.ssh, ~/.aws
  // and the SOPS age key are unreachable without anyone having named them.
  expect(filesystem.denyRead).toContain('/')
  for (const secret of ['.ssh', '.aws', '.gnupg', 'sops', 'Keychains']) {
    expect(filesystem.allowRead.some((path) => path.includes(secret))).toBe(false)
  }
})

test('the workspace is the only writable place outside temp', async () => {
  const ws = await workspace()
  const { filesystem } = srtSettings(ws)

  expect(filesystem.allowRead).toContain(ws.dir)
  expect(filesystem.allowRead).toContain(ws.home)
  expect(filesystem.allowWrite).toContain(ws.dir)
  expect(filesystem.allowWrite).toContain(ws.home)
  // Both /tmp spellings are writable — the CLI puts its own scratch there, and
  // it is world-writable already. Nothing else outside the workspace is.
  const shared = ['/private/tmp', '/tmp', '/dev']
  for (const path of filesystem.allowWrite) {
    expect(path.startsWith(ws.root) || shared.includes(path)).toBe(true)
  }
})

test('escape binaries are denied by making them unreadable', async () => {
  // srt has no execute allowlist. Denying a read of the binary denies the exec:
  // `security` becomes `command not found`, exit 127, while the rest of
  // /usr/bin still runs.
  const { filesystem } = srtSettings(await workspace())
  expect(DENIED_BINARIES).toContain('/usr/bin/security')
  for (const binary of DENIED_BINARIES) {
    expect(filesystem.denyRead).toContain(binary)
  }
})

test('egress is allow-listed, and extra domains never displace the defaults', async () => {
  const ws = await workspace()
  // The registry is a default because init installs dependencies inside the
  // sandbox, and an agent asked to add one needs it too.
  expect(srtSettings(ws).network.allowedDomains).toEqual([...ALLOWED_DOMAINS])
  expect(srtSettings(ws, { allowedDomains: ['example.test'] }).network.allowedDomains).toEqual([
    ...ALLOWED_DOMAINS,
    'example.test',
  ])
})

test("the shim runs the CLI through srt with this workspace's settings", async () => {
  const ws = await workspace()
  const shim = await readFile(ws.shim, 'utf8')

  expect(ws.shim).toBe(join(ws.home, 'claude-sandboxed'))
  expect(shim).toContain(join(ws.home, 'srt-settings.json'))
  expect(shim).toContain('sandbox-runtime')
  expect(shim).toMatch(/claude-agent-sdk-\w+-\w+\/claude/)
  expect((await statFile(ws.shim)).mode & 0o111).toBeGreaterThan(0)
})

test('the kernel actually enforces it — a denied read fails under the settings', async () => {
  // The only test here that proves the boundary rather than describing it, and
  // it costs nothing: srt and /bin/cat are enough.
  const ws = await workspace()
  const settings = join(ws.home, 'srt-settings.json')
  const srt = (args: string[]) =>
    execFile(process.execPath, [srtExecutable(), '-s', settings, ...args])

  await expect(srt(['/bin/cat', join(homedir(), '.zshrc')])).rejects.toThrow(
    /Operation not permitted/,
  )

  // ...and the workspace stays readable, or the sandbox is merely obstructive.
  const { stdout } = await srt(['/bin/cat', join(ws.dir, 'README.md')])
  expect(stdout).toContain('fixture')
})
