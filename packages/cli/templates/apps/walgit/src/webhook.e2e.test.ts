/**
 * The push webhook over the real thing: a real `git push` into the real
 * handler, whose `post-receive` spawns the detached announcer, which POSTs to a
 * receiver listening on loopback. The receiver answers its first attempt 503,
 * so the retry is part of what a real push is shown to do.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { capabilitiesFrom } from '../shared/capabilities'
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyWebhook,
} from '../shared/webhook'
import { ensureBareRepo } from './cache'
import { runGitHttpBackend } from './git-backend'
import { createHttpHandler } from './http'
import { FileStore } from './store'
import { syncRepo } from './sync'

const TOKEN = 's3cret'
const SECRET = 'webhook-secret'

interface Received {
  body: string
  signature: string | null
  timestamp: string | null
  id: string | null
}

let server: ReturnType<typeof Bun.serve>
let hook: ReturnType<typeof Bun.serve>
let scratch: string
let storeDir: string
let reposDir: string
const received: Received[] = []

const git = async (cwd: string, ...args: string[]) => {
  const child = Bun.spawn(['git', '-c', 'credential.helper=', ...args], {
    cwd,
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
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walgit-store-'))

  hook = Bun.serve({
    port: 0,
    async fetch(request) {
      received.push({
        body: await request.text(),
        signature: request.headers.get(SIGNATURE_HEADER),
        timestamp: request.headers.get(TIMESTAMP_HEADER),
        id: request.headers.get(EVENT_ID_HEADER),
      })
      // The first attempt fails, so the event must arrive twice.
      return new Response('', { status: received.length === 1 ? 503 : 204 })
    },
  })

  // The hooks are children of git http-backend, a child of this process, so
  // this environment is theirs.
  process.env.WALGIT_STORE_DIR = storeDir
  process.env.WALGIT_WEBHOOK_URL = `http://127.0.0.1:${hook.port}/hook`
  process.env.WALGIT_WEBHOOK_SECRET = SECRET

  server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: createHttpHandler({
      reposDir,
      tokens: [TOKEN],
      ensureRepo: ensureBareRepo,
      syncRepo: (repo) => syncRepo(new FileStore(storeDir), repo),
      runBackend: runGitHttpBackend,
      capabilities: capabilitiesFrom(process.env),
    }),
  })
})

afterAll(() => {
  server.stop(true)
  hook.stop(true)
  delete process.env.WALGIT_STORE_DIR
  delete process.env.WALGIT_WEBHOOK_URL
  delete process.env.WALGIT_WEBHOOK_SECRET
  for (const dir of [reposDir, scratch, storeDir]) fs.rmSync(dir, { recursive: true, force: true })
})

async function until<T>(read: () => T | undefined, ms: number): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for the webhook')
    await Bun.sleep(50)
  }
}

test('a push delivers a signed POST, retried after a 5xx, that the receiver can verify', async () => {
  const work = path.join(scratch, 'work')
  fs.mkdirSync(work)
  await git(work, 'init', '-q', '.')
  fs.writeFileSync(path.join(work, 'README'), 'webhook\n')
  await git(work, 'add', 'README')
  await git(work, '-c', 'user.email=a@example.test', '-c', 'user.name=a', 'commit', '-qm', 'one')
  const sha = (await git(work, 'rev-parse', 'HEAD')).out.trim()

  const pushed = await git(
    work,
    'push',
    `http://walgit:${TOKEN}@127.0.0.1:${server.port}/hooked.git`,
    'HEAD:refs/heads/main',
  )
  expect(pushed.status).toBe(0)

  const second = await until(() => received[1], 15_000)
  const first = received[0]!
  const payload = JSON.parse(second.body)
  expect(payload).toMatchObject({ repo: 'hooked', ref: 'refs/heads/main', oldSha: null, sha })
  // The same event both times: a receiver de-duplicates on the id.
  expect(first.body).toBe(second.body)
  expect(second.id).toBe(payload.id)

  const verify = (body: string) =>
    verifyWebhook({
      secret: SECRET,
      body,
      signature: second.signature,
      timestamp: second.timestamp,
    })
  expect(await verify(second.body)).toBe(true)
  expect(await verify(second.body.replace(sha, '0'.repeat(40)))).toBe(false)
}, 30_000)
