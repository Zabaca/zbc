/**
 * End-to-end over the real thing: a real `git` client, the real handler, and a
 * real `git http-backend` child. Nothing here is a double — the point is that
 * clone/push/fetch work, which no unit test of the routing can establish.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createHttpHandler } from './http'
import { ensureBareRepo } from './cache'
import { runGitHttpBackend } from './git-backend'
import { FileStore } from './store'
import { syncRepo } from './sync'

const TOKEN = 's3cret'
let server: ReturnType<typeof Bun.serve>
let reposDir: string
let scratch: string
let storeDir: string
let origin: string

/**
 * git runs ASYNCHRONOUSLY here, not via spawnSync. The server under test lives
 * in this same process, so a synchronous child would block the event loop that
 * has to answer the request the child is waiting on — a guaranteed deadlock.
 */
const git = async (cwd: string, ...args: string[]) => {
  const child = Bun.spawn(['git', '-c', 'credential.helper=', ...args], {
    cwd,
    // The developer's own git config is excluded on purpose: a credential
    // helper inherited from it (macOS ships osxkeychain) answers a 401 by
    // opening an interactive prompt, and the test would hang instead of
    // observing the refusal.
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_ASKPASS: '/usr/bin/false',
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
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-repos-'))
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-work-'))
  // A push that cannot reach the write-ahead log is refused by the hooks, so
  // even a transport test needs somewhere for the log to live.
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-store-'))
  process.env.WALGIT_STORE_DIR = storeDir
  server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: createHttpHandler({
      reposDir,
      tokens: [TOKEN],
      ensureRepo: ensureBareRepo,
      syncRepo: (repo) => syncRepo(new FileStore(storeDir), repo),
      runBackend: runGitHttpBackend,
      instructions: { appendOnly: true, retentionHours: 24, maxPushBytes: 99 * 1024 * 1024 },
    }),
  })
  origin = `http://walgit:${TOKEN}@127.0.0.1:${server.port}/alpha.git`
})

afterAll(() => {
  server.stop(true)
  delete process.env.WALGIT_STORE_DIR
  fs.rmSync(storeDir, { recursive: true, force: true })
})

describe('smart-HTTP', () => {
  test('clone, push, and fetch the pushed commit from a second clone', async () => {
    const first = path.join(scratch, 'first')
    expect((await git(scratch, 'clone', origin, first)).status).toBe(0)

    fs.writeFileSync(path.join(first, 'README'), 'walgit\n')
    await git(first, 'config', 'user.email', 'walgit@example.test')
    await git(first, 'config', 'user.name', 'walgit')
    await git(first, 'add', 'README')
    await git(first, 'commit', '-m', 'first commit')
    const pushed = await git(first, 'push', 'origin', 'HEAD:refs/heads/main')
    expect(pushed.out).toContain('[new branch]')
    expect(pushed.status).toBe(0)

    const second = path.join(scratch, 'second')
    expect((await git(scratch, 'clone', origin, second)).status).toBe(0)
    expect(fs.readFileSync(path.join(second, 'README'), 'utf8')).toBe('walgit\n')

    // …and a fetch sees a later push, which a clone alone would not prove.
    fs.writeFileSync(path.join(first, 'README'), 'walgit again\n')
    await git(first, 'commit', '-am', 'second commit')
    await git(first, 'push', 'origin', 'HEAD:refs/heads/main')
    expect((await git(second, 'fetch', 'origin')).status).toBe(0)
    expect((await git(second, 'log', '--oneline', 'origin/main')).out).toContain('second commit')
  })

  test('a plain fetch of the root returns instructions whose example works verbatim', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    const text = await res.text()
    expect(text).not.toContain('<')

    // The example is not paraphrased here: the push line is taken out of the
    // served text and run, so a change to the copy that breaks the flow fails
    // this test rather than reaching an agent.
    const line = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('git push http'))
    expect(line).toBeDefined()

    const work = path.join(scratch, 'from-instructions')
    fs.mkdirSync(work, { recursive: true })
    fs.writeFileSync(path.join(work, 'file'), 'from the instructions\n')
    await git(work, 'init', '.')
    await git(work, 'add', '-A')
    await git(
      work,
      '-c',
      'user.email=agent@localhost',
      '-c',
      'user.name=agent',
      'commit',
      '-m',
      'first',
    )

    // The one substitution: this instance still demands a credential, which
    // public mode removes in a sibling ticket. Everything else — the path
    // shape, the `.git` suffix and the refspec — is the served text's own.
    const args = line!.split(' ').slice(1)
    args[1] = args[1]!
      .replace('$NAME', `instructions-${Date.now()}`)
      .replace('http://', `http://walgit:${TOKEN}@`)
    const pushed = await git(work, ...args)
    expect(pushed.out).toContain('[new branch]')
    expect(pushed.status).toBe(0)
  })

  test('an anonymous clone is refused', async () => {
    const anon = await git(
      scratch,
      'clone',
      `http://127.0.0.1:${server.port}/alpha.git`,
      path.join(scratch, 'anon'),
    )
    expect(anon.status).not.toBe(0)
    expect(anon.out).toMatch(/401|Authentication failed|could not read Username/i)
  })
})
