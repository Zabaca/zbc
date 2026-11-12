/**
 * The push sizes a real project's first push has: one 20 MiB push, eight of
 * them at once, and a push at the advertised per-push cap.
 *
 * A first push is a project's whole history, and a node project with a lockfile
 * and some images is 10–20 MiB, so this is the size that has to work rather
 * than the size that is convenient to test. The packs are random bytes, so git
 * cannot compress them below the size they are named for.
 *
 * Out of process on purpose: the node is `src/server.ts` started as the
 * container starts it (`e2e/harness.ts`), so the request body crosses a real
 * socket into `Bun.serve`, then `git http-backend`'s stdin, then the hooks and
 * the object store, which is the whole container half of the path. The edge
 * Worker in front of it is not here; `docs/research/agentgit-load-2026-09-16.md`
 * and `e2e/load.ts` are how that half is measured against a deployment.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { Run, type WalgitNode, git, gitOk } from '../e2e/harness'
import { loadIndex } from '../shared/wal-index'

const MiB = 1024 * 1024

/**
 * The cap the public instance sets (`WALGIT_MAX_PUSH_BYTES` in
 * `packages/infra/environments/production/walgit-public.ts`), repeated here so
 * the push it advertises is the push this file makes.
 */
const MAX_PUSH_BYTES = 90 * MiB

/**
 * Cloudflare's request-body limit on the Free and Pro plans: 100 MB, decimal.
 * A cap above it is one the edge refuses before walgit can, with a 413 after
 * the whole upload, which a client reads as a dropped network.
 */
const EDGE_BODY_LIMIT_BYTES = 100_000_000

let run: Run
let node: WalgitNode

beforeAll(async () => {
  // A local FileStore always: `Run` uses a real bucket when `WALGIT_S3_*` is
  // set, and this file would upload ~450 MiB to it on every `bun test src`.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('WALGIT_S3_')) delete process.env[key]
  }
  run = new Run()
  node = await run.node('large', {
    WALGIT_MAX_PUSH_BYTES: String(MAX_PUSH_BYTES),
    WALGIT_MAX_REPO_BYTES: String(250 * MiB),
  })
})

afterAll(async () => {
  await run?.cleanup()
})

/** A new repository holding one commit of `bytes` random bytes, pushed. */
async function pushRandom(name: string, bytes: number) {
  const repoId = run.repoId(name)
  const dir = run.dir(name)
  await gitOk(dir, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'blob.bin'), crypto.randomBytes(bytes))
  await gitOk(dir, 'add', '-A')
  await gitOk(dir, 'commit', '-q', '-m', `${bytes} random bytes`)
  const oid = (await gitOk(dir, 'rev-parse', 'HEAD')).trim()
  const pushed = await git(dir, 'push', node.origin(repoId), 'HEAD:refs/heads/main')
  return { repoId, oid, ...pushed }
}

/** The pushed commit is what the log says `main` is, so it is durable, not just accepted. */
async function expectInLog(repoId: string, oid: string) {
  const { index } = await loadIndex(run.store, repoId)
  expect(index.refs['refs/heads/main']).toBe(oid)
}

describe('large pushes', () => {
  test('one 20 MiB push succeeds', async () => {
    const result = await pushRandom('single-20', 20 * MiB)
    expect(result.out).not.toContain('error:')
    expect(result.status).toBe(0)
    await expectInLog(result.repoId, result.oid)
  }, 60_000)

  test('eight concurrent 20 MiB pushes all succeed', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => pushRandom(`concurrent-${index}`, 20 * MiB)),
    )
    for (const result of results) {
      expect(result.out).not.toContain('error:')
      expect(result.status).toBe(0)
    }
    for (const result of results) await expectInLog(result.repoId, result.oid)
  }, 120_000)

  test('the advertised cap sits under the edge body limit, with room for the commands', () => {
    // The request body is the pack plus the ref commands and, on a signed push,
    // the certificate: a few KiB. A MiB of room is far more than either.
    expect(MAX_PUSH_BYTES + MiB).toBeLessThan(EDGE_BODY_LIMIT_BYTES)
  })

  test('a push just under the cap is accepted', async () => {
    const result = await pushRandom('under-cap', MAX_PUSH_BYTES - MiB)
    expect(result.out).not.toContain('error:')
    expect(result.status).toBe(0)
    await expectInLog(result.repoId, result.oid)
  }, 120_000)

  test('a push over the cap is refused in walgit’s own words', async () => {
    const result = await pushRandom('over-cap', MAX_PUSH_BYTES + MiB)
    expect(result.status).not.toBe(0)
    expect(result.out).toContain('this push is larger than 90 MiB')
    expect(result.out).toContain('This is a walgit limit')
    const { index } = await loadIndex(run.store, result.repoId)
    expect(index.refs['refs/heads/main']).toBeUndefined()
  }, 120_000)
})
