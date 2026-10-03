import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { ensureBareRepo } from './cache'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-cache-config-'))
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) => {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout.trim()
}

describe('ensureBareRepo', () => {
  // HEAD follows the Index (`ensureHead`), so it always names a real branch,
  // and git's default would then refuse to delete that branch.
  test('the branch HEAD names can still be deleted', () => {
    const repo = ensureBareRepo({ repoId: 'r', dir: path.join(scratch, 'r.git') })
    // walgit's hooks need an object store; the rule under test is receive-pack's
    // own, which it applies after the hooks, so they are pointed at nothing.
    const noHooks = fs.mkdtempSync(path.join(scratch, 'hooks-'))
    git(repo.dir, 'config', 'core.hooksPath', noHooks)
    const work = path.join(scratch, 'work')
    git(scratch, 'init', '--quiet', '-b', 'main', work)
    git(work, 'config', 'user.email', 'walgit@example.test')
    git(work, 'config', 'user.name', 'walgit')
    fs.writeFileSync(path.join(work, 'a'), 'one\n')
    git(work, 'add', 'a')
    git(work, 'commit', '--quiet', '-m', 'one')
    git(work, 'push', '--quiet', repo.dir, 'main:refs/heads/agent-a', 'main:refs/heads/agent-b')
    git(repo.dir, 'symbolic-ref', 'HEAD', 'refs/heads/agent-a')

    git(work, 'push', '--quiet', repo.dir, ':refs/heads/agent-a')
    expect(git(repo.dir, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/agent-b')
  })
})
