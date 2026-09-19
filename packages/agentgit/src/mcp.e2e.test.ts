/**
 * `agentgit_watch_once` against a real socket and a real git fetch.
 *
 * The unit tests stub the watcher, so what is unproven there is the whole point
 * of the tool: an agent asks to wait, another agent pushes, and the answer names
 * the ref and the sha that landed — in a clone that really advanced.
 *
 * The host is doubled only where walgit computes, and it lives in its own
 * process (`mcp.e2e.fixture.ts`, which says why). Everything the client does —
 * discovery from the remote, the subscription, the fetch, leaving the branch
 * alone — is the real thing.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { git } from './git'
import { createHandlers, realMcpDeps } from './mcp'

const run = (dir: string, ...args: string[]) => {
  const result = git(dir, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    ...args,
  ])
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result
}

const REPO = 'my-thing'
const FIXTURE = path.join(import.meta.dir, 'mcp.e2e.fixture.ts')

let scratch: string
let host: string
let watcher: string
let pusher: string
let walgit: ReturnType<typeof Bun.spawn> | null = null

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgit-mcp-'))
  host = path.join(scratch, 'host.git')
  watcher = path.join(scratch, 'watcher')
  pusher = path.join(scratch, 'pusher')

  run(scratch, 'init', '--bare', '--initial-branch=main', host)
  run(scratch, 'clone', host, pusher)
  fs.writeFileSync(path.join(pusher, 'README.md'), 'one\n')
  run(pusher, 'add', 'README.md')
  run(pusher, 'commit', '-m', 'first')
  run(pusher, 'push', 'origin', 'main')
  run(scratch, 'clone', host, watcher)
})

afterEach(() => {
  walgit?.kill()
  walgit = null
  fs.rmSync(scratch, { recursive: true, force: true })
})

/** Start the double, wait for the port it chose, and point the clone at it. */
async function startWalgit(withPusher: boolean): Promise<void> {
  walgit = Bun.spawn(['bun', FIXTURE, host, REPO, ...(withPusher ? [pusher] : [])], {
    stdout: 'pipe',
    stderr: 'inherit',
  })
  // The first line and no more: the double keeps running, so its stdout never
  // ends and anything that waits for that waits forever.
  const reader = (walgit.stdout as ReadableStream<Uint8Array>).getReader()
  let said = ''
  while (!said.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) break
    said += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  const address = said.trim().split('\n')[0]
  if (!address) throw new Error('the walgit double never named a port')
  run(watcher, 'remote', 'set-url', 'origin', `http://${address}/${REPO}.git`)
}

describe('agentgit_watch_once, end to end', () => {
  test('answers with the ref and sha the other agent pushed, in a clone that advanced', async () => {
    const before = run(watcher, 'rev-parse', 'HEAD').stdout.trim()
    await startWalgit(true)

    const handlers = createHandlers(realMcpDeps('test'))
    const result = await handlers.watchOnce({ cwd: watcher, timeoutMs: 20_000 })

    expect(result.isError).toBeUndefined()
    const answer = JSON.parse(result.content[0]?.text ?? 'null')
    expect(answer.timedOut).toBe(false)
    expect(answer.repo).toBe(REPO)
    expect(answer.ref).toBe('refs/heads/main')
    expect(answer.sha).toMatch(/^[0-9a-f]{40}$/)

    // It fetched: the remote-tracking ref really moved to what was pushed.
    expect(run(watcher, 'rev-parse', 'origin/main').stdout.trim()).toBe(answer.sha)
    // And it moved nothing else: the branch the agent is standing on is where
    // it was, which is the promise the whole client is built on.
    expect(run(watcher, 'rev-parse', 'HEAD').stdout.trim()).toBe(before)
  }, 40_000)

  test('nothing pushed before the deadline is reported as a timeout', async () => {
    await startWalgit(false)

    const handlers = createHandlers(realMcpDeps('test'))
    const result = await handlers.watchOnce({ cwd: watcher, timeoutMs: 2_000 })

    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0]?.text ?? 'null').timedOut).toBe(true)
  }, 40_000)
})
