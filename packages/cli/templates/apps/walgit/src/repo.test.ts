import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { readPending, writePending } from './pending'
import { ensureBareRepo } from './cache'
import { resolveRepo } from './repo'

describe('resolveRepo', () => {
  test('maps a bare repo id to a directory under the repos root', () => {
    expect(resolveRepo('/srv/repos', 'alpha')).toEqual({
      repoId: 'alpha',
      dir: '/srv/repos/alpha.git',
    })
  })

  test('accepts the forms a git client actually sends', () => {
    // The smart-HTTP path is `/alpha.git/info/refs`, so the router hands over
    // a leading slash and a `.git` suffix the id itself does not carry.
    for (const requested of ['alpha.git', '/alpha.git', '/alpha']) {
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

  test('carries the push-certificate seed onto every repository it touches', () => {
    const root = scratch()
    const config = (dir: string, key: string) =>
      spawnSync('git', ['--git-dir', dir, 'config', '--get', key]).stdout.toString().trim()

    // Nothing is advertised until the instance configures a seed.
    const before = ensureBareRepo(resolveRepo(root, 'alpha'))
    expect(config(before.dir, 'receive.certNonceSeed')).toBe('')

    process.env.WALGIT_PUSH_CERT_SEED = 'a-long-random-seed'
    try {
      // The seed reaches a repository that already existed, which is the case
      // that matters: the disk is a cache, so most repositories are older than
      // whatever the container currently boots with.
      const after = ensureBareRepo(resolveRepo(root, 'alpha'))
      expect(config(after.dir, 'receive.certNonceSeed')).toBe('a-long-random-seed')

      // …and a second access does not fight `config.lock` over a value that is
      // already there. `ensureConfig` reads before it writes, so the steady
      // state writes nothing at all — the property that lets a materialize and
      // a push provision the same repository at the same moment.
      const again = ensureBareRepo(resolveRepo(root, 'alpha'))
      expect(config(again.dir, 'receive.certNonceSeed')).toBe('a-long-random-seed')

      // The window the nonce is judged against travels with the seed. git
      // defaults it to 0, which only a round trip that stayed inside one unix
      // second can satisfy — so without this a slow signed push establishes no
      // Signer, and a claimed name refuses its own owner (src/push-cert.ts).
      expect(config(after.dir, 'receive.certNonceSlop')).toBe('300')

      // Unsetting the variable withdraws the capability rather than leaving
      // older repositories certifying pushes on a seed nothing configures.
      delete process.env.WALGIT_PUSH_CERT_SEED
      const cleared = ensureBareRepo(resolveRepo(root, 'alpha'))
      expect(config(cleared.dir, 'receive.certNonceSeed')).toBe('')
      // …and the window goes with it, rather than being left on a repository
      // whose instance no longer takes certificates at all.
      expect(config(cleared.dir, 'receive.certNonceSlop')).toBe('')
    } finally {
      delete process.env.WALGIT_PUSH_CERT_SEED
    }
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
