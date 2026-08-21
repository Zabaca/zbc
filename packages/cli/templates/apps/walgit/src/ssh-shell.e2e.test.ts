/**
 * The SSH path end to end, minus OpenSSH itself.
 *
 * A real `git` client drives a real `ssh-shell.ts`: git's own transport is
 * `<ssh command> <host> <the git command>`, so standing in for ssh with a
 * script that puts that last argument in SSH_ORIGINAL_COMMAND reproduces
 * exactly what sshd's forced command does — without needing a daemon, a
 * keypair, or a port. What is NOT covered here is sshd's own configuration;
 * that is verified against the deployed app.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

let scratch: string
let reposDir: string
let fakeSsh: string

const git = async (cwd: string, ...args: string[]) => {
  const child = Bun.spawn(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_SSH_COMMAND: fakeSsh,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { status, out: `${out}${err}` }
}

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-ssh-'))
  reposDir = path.join(scratch, 'repos')
  fs.mkdirSync(reposDir)
  fakeSsh = path.join(scratch, 'fake-ssh')
  const shell = path.join(import.meta.dir, 'ssh-shell.ts')
  fs.writeFileSync(
    fakeSsh,
    `#!/bin/sh\nexport WALGIT_REPOS_DIR='${reposDir}'\nexport SSH_ORIGINAL_COMMAND="$2"\nexec bun '${shell}'\n`,
    { mode: 0o755 },
  )
})

describe('the ssh forced command', () => {
  test('clone, push, and fetch over the git-over-ssh transport', async () => {
    const origin = 'git@walgit.test:alpha.git'
    const first = path.join(scratch, 'first')
    expect((await git(scratch, 'clone', origin, first)).status).toBe(0)

    fs.writeFileSync(path.join(first, 'README'), 'over ssh\n')
    await git(first, 'config', 'user.email', 'walgit@example.test')
    await git(first, 'config', 'user.name', 'walgit')
    await git(first, 'add', 'README')
    await git(first, 'commit', '-m', 'first commit')
    expect((await git(first, 'push', 'origin', 'HEAD:refs/heads/main')).status).toBe(0)

    const second = path.join(scratch, 'second')
    expect((await git(scratch, 'clone', origin, second)).status).toBe(0)
    expect(fs.readFileSync(path.join(second, 'README'), 'utf8')).toBe('over ssh\n')
  })

  test('a push keeps its objects as a packfile', async () => {
    // receive.unpackLimit=0, observed through the transport rather than the
    // config: the WAL push path uploads packs, so loose objects here would
    // silently break the next milestone.
    const packs = fs.readdirSync(path.join(reposDir, 'alpha.git', 'objects', 'pack'))
    expect(packs.filter((f) => f.endsWith('.pack')).length).toBeGreaterThan(0)
    expect(
      fs
        .readdirSync(path.join(reposDir, 'alpha.git', 'objects'))
        .filter((d) => /^[0-9a-f]{2}$/.test(d)),
    ).toEqual([])
  })

  test('refuses a command that is not a git transport verb', async () => {
    const child = Bun.spawn(['bun', path.join(import.meta.dir, 'ssh-shell.ts')], {
      env: { ...process.env, WALGIT_REPOS_DIR: reposDir, SSH_ORIGINAL_COMMAND: 'sh -i' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [err, status] = await Promise.all([new Response(child.stderr).text(), child.exited])
    expect(status).not.toBe(0)
    expect(err).toContain('refused')
  })
})
