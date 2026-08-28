import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { readPending, writePending } from './push'
import { ensureBareRepo, parseSshCommand, resolveRepo } from './repo'

describe('resolveRepo', () => {
  test('maps a bare repo id to a directory under the repos root', () => {
    expect(resolveRepo('/srv/repos', 'alpha')).toEqual({
      repoId: 'alpha',
      dir: '/srv/repos/alpha.git',
    })
  })

  test('accepts the forms a git client actually sends', () => {
    // `git clone ssh://host/alpha.git` sends a leading slash; the scp-style
    // `git@host:alpha.git` sends none; OpenSSH expands `~/alpha.git` for
    // neither, so the server sees the tilde verbatim.
    for (const requested of ['alpha.git', '/alpha.git', '~/alpha.git', '/alpha']) {
      expect(resolveRepo('/srv/repos', requested).dir).toBe('/srv/repos/alpha.git')
    }
  })

  test('rejects anything that could escape the repos root', () => {
    for (const hostile of [
      '..',
      '../../etc/passwd',
      'a/../../../etc',
      'team/alpha',
      '/etc/passwd',
      '.ssh',
      '',
      'alpha; rm -rf /',
      'alpha\nbeta',
      'alpha\n',
    ]) {
      expect(() => resolveRepo('/srv/repos', hostile)).toThrow()
    }
  })
})

describe('ensureBareRepo', () => {
  const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-repo-'))

  test('creates a bare repo that keeps a small push as a packfile', () => {
    const root = scratch()
    const { dir } = ensureBareRepo(resolveRepo(root, 'alpha'))

    expect(fs.existsSync(path.join(dir, 'HEAD'))).toBe(true)
    // receive.unpackLimit=0 is what makes even a 3-object push land as a pack
    // rather than loose objects — the WAL push path (next milestone) uploads
    // packs, and this was verified in the M0 spike.
    const cfg = spawnSync('git', ['--git-dir', dir, 'config', '--get', 'receive.unpackLimit'])
    expect(cfg.stdout.toString().trim()).toBe('0')
  })

  test('is idempotent and does not disturb an existing repo', () => {
    const root = scratch()
    const first = ensureBareRepo(resolveRepo(root, 'alpha'))
    fs.writeFileSync(path.join(first.dir, 'description'), 'mine')
    const second = ensureBareRepo(resolveRepo(root, 'alpha'))
    expect(second.dir).toBe(first.dir)
    expect(fs.readFileSync(path.join(second.dir, 'description'), 'utf8')).toBe('mine')
  })

  test('sweeps the hand-off record a killed receive-pack left behind', async () => {
    const root = scratch()
    const repo = ensureBareRepo(resolveRepo(root, 'alpha'))
    const child = Bun.spawn(['true'])
    const dead = child.pid
    await child.exited
    writePending(repo.dir, { entry: null }, dead)

    ensureBareRepo(resolveRepo(root, 'alpha'))

    expect(readPending(repo.dir, dead)).toBeNull()
  })
})

describe('parseSshCommand', () => {
  test('accepts the two commands a git client runs over ssh', () => {
    // Exactly what OpenSSH puts in SSH_ORIGINAL_COMMAND for
    // `git clone git@host:alpha.git` and `git push`.
    expect(parseSshCommand("git-upload-pack 'alpha.git'")).toEqual({
      service: 'git-upload-pack',
      requested: 'alpha.git',
    })
    expect(parseSshCommand("git-receive-pack '/alpha.git'")).toEqual({
      service: 'git-receive-pack',
      requested: '/alpha.git',
    })
  })

  test('accepts the `git upload-pack` spelling older clients send', () => {
    expect(parseSshCommand("git upload-pack 'alpha.git'")).toEqual({
      service: 'git-upload-pack',
      requested: 'alpha.git',
    })
  })

  test('refuses anything that is not a git transport command', () => {
    for (const hostile of [
      'sh',
      'scp -t /root/.ssh/authorized_keys',
      "git-upload-archive 'alpha.git'",
      "git-upload-pack 'alpha.git'; sh",
      '',
      undefined,
    ]) {
      expect(() => parseSshCommand(hostile)).toThrow()
    }
  })
})

describe("git's own housekeeping is off", () => {
  /**
   * The failure this closes did not look like a gc problem. Compaction refused
   * with "repack left 2 packs" on CI and nowhere else, because `git gc --auto`
   * had run behind it after a push and left a cruft pack beside walgit's own.
   * A repo holding one pack per WAL entry passes gc.autoPackLimit (50) almost
   * immediately, so this is the normal case, not a corner.
   */
  test('a bare repo refuses to gc itself after a push', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-autogc-'))
    const repo = ensureBareRepo(resolveRepo(dir, 'gctest'))
    const cfg = (key: string) =>
      spawnSync('git', ['--git-dir', repo.dir, 'config', '--get', key], {
        encoding: 'utf8',
      }).stdout.trim()

    expect(cfg('receive.autogc')).toBe('false')
    expect(cfg('gc.auto')).toBe('0')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('ensureBareRepo under a concurrent writer', () => {
  /**
   * `git config <key> <value>` takes an exclusive `config.lock` and does NOT
   * retry when it cannot get it — it exits non-zero with "could not lock config
   * file". Two processes reach `ensureBareRepo` on one repository routinely:
   * compaction materializes in a detached process (materialize.ts calls it)
   * while the front door is still serving pushes. The loser's throw becomes a
   * `404 not found` in `createHttpHandler`, which cannot tell a repo that
   * failed to open from one that is not there — so the client sees
   * `fatal: repository '…' not found` and a healthy push dies.
   *
   * A held lock is exactly what the loser of that race encounters, so this
   * holds one. The second call must still succeed: the values are already set,
   * so there is nothing to write and no lock to take.
   */
  test('a held config.lock does not fail a repo whose config is already set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-configlock-'))
    const repo = ensureBareRepo(resolveRepo(dir, 'locked'))

    // What a concurrent `git config` looks like from here, mid-write.
    const lock = path.join(repo.dir, 'config.lock')
    fs.writeFileSync(lock, '')

    expect(() => ensureBareRepo(resolveRepo(dir, 'locked'))).not.toThrow()

    fs.rmSync(dir, { recursive: true, force: true })
  })
})
