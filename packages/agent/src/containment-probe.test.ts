// A probe, not a contribution: does the boundary actually contain on *this*
// box? Reads and writes, inside and outside, asserting on outcome rather than
// on errno — bubblewrap denies by not binding a path in, so an unreachable
// file is ENOENT and not EPERM, and a test that pins the errno reports a
// working sandbox as broken.
import { execFile as execFileCb } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'bun:test'
import { srtExecutable } from './sandbox'
import { createWorkspace } from './workspace'

const execFile = promisify(execFileCb)

const origin = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'probe-origin-'))
  const git = (args: string[]) =>
    execFile('git', ['-c', 'user.email=p@p', '-c', 'user.name=p', ...args], { cwd: dir })
  await git(['init', '-q', '-b', 'main'])
  await writeFile(join(dir, 'README.md'), '# fixture\n')
  await git(['add', '-A'])
  await git(['commit', '-qm', 'init'])
  return dir
}

test('the boundary holds on this box: outside unreachable, inside usable', async () => {
  const ws = await createWorkspace({ repo: await origin(), branch: 'probe' })
  const settings = join(ws.home, 'srt-settings.json')
  const run = async (args: string[]) => {
    try {
      const { stdout } = await execFile(process.execPath, [
        srtExecutable(),
        '-s',
        settings,
        ...args,
      ])
      return { ok: true, out: stdout }
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message?: string }
      return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}` }
    }
  }

  expect(ws.dir.startsWith(homedir())).toBe(false)

  // Assert on *effect*, never on exit status. The sandbox redirects $HOME, so a
  // write to a path that looks like the operator's home succeeds — into the
  // workspace. Only the real filesystem, read from outside, settles it.
  const escapes: string[] = []
  const attempt = async (path: string) => {
    const result = await run(['/bin/sh', '-c', `echo pwned > ${path}`])
    try {
      await readFile(path, 'utf8')
      escapes.push(`${path} (write reported ${result.ok ? 'success' : 'failure'})`)
    } catch {
      /* absent from the real filesystem: contained */
    }
  }

  // The operator's checkout is the target that would actually hurt: an agent
  // editing the repo it was cloned from is the whole thing we are preventing.
  await attempt('/home/uptown/foundry/CONTAINMENT-PROBE')
  await attempt(join(homedir(), 'containment-probe-should-never-exist'))
  await attempt('/tmp/containment-probe-should-never-exist')
  await attempt('/etc/containment-probe-should-never-exist')
  expect(escapes).toEqual([])

  // Reads of the operator's files are denied too.
  const secret = join(homedir(), '.zshrc')
  expect((await readFile(secret, 'utf8')).length).toBeGreaterThan(0)
  expect((await run(['/bin/cat', secret])).ok).toBe(false)
  expect((await run(['/bin/cat', '/home/uptown/foundry/CLAUDE.md'])).ok).toBe(false)

  // ...and the workspace stays usable, or the sandbox is merely obstructive.
  const readInside = await run(['/bin/cat', join(ws.dir, 'README.md')])
  expect(readInside.ok).toBe(true)
  expect(readInside.out).toContain('fixture')

  const writeInside = await run(['/bin/sh', '-c', `echo ok > ${join(ws.dir, 'written')}`])
  expect(writeInside.ok).toBe(true)
  expect(await readFile(join(ws.dir, 'written'), 'utf8')).toContain('ok')
}, 120_000)
