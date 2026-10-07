/**
 * The container's half of answering ref checks at the edge: saying, once per
 * boot, what its own git advertises (`shared/edge-refs.ts`).
 *
 * The edge answers a protocol-v2 `info/refs` and an `ls-refs` without waking
 * this process, and both answers carry bytes only git can author — the
 * capability advertisement, and the headers `git http-backend` puts on each.
 * Typing them out at the edge would be a promise about a git binary the edge
 * cannot see: the image's git is Alpine's, it moves when the image is rebuilt,
 * and an advertisement that outlived it would offer a client something the
 * container then refuses. So the container asks its own git, through the same
 * `runGitHttpBackend` every real request goes through, against a probe
 * repository provisioned by the same `ensureBareRepo` every Cache is — and
 * publishes the answers under the fingerprint of the environment it booted
 * with. The edge reads only the fingerprint IT would boot a container with, so
 * it serves this git's words exactly while this is the container behind it.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  REQUEST_TYPE,
  serializeUploadPackRecord,
  uploadPackKeyFor,
  type CapturedResponse,
  type UploadPackRecord,
} from '../shared/edge-refs'
import { UPLOAD_PACK_PREFIX } from '../shared/keys'
import type { ObjectStore } from '../shared/store'
import { ensureBareRepo } from './cache'
import { runGitHttpBackend } from './git-backend'
import type { BackendRequest } from './http'

/** The probe's name. Never a repository: it lives in a temporary directory, not under the repos dir. */
const PROBE = 'walgit-probe'

/**
 * Ask this image's git what it advertises, the way a client would.
 *
 * Two requests through `runGitHttpBackend` — the v2 `info/refs`, and an
 * `ls-refs` against the probe, which holds no refs and so answers a bare flush
 * whose status and headers are the ones every `ls-refs` gets. The probe is
 * created in `probeParent` and removed afterwards; it is never a repository
 * anyone can name.
 */
export async function captureUploadPack(
  probeParent: string = os.tmpdir(),
  runBackend: (req: BackendRequest) => Promise<Response> = runGitHttpBackend,
): Promise<UploadPackRecord> {
  const root = fs.mkdtempSync(path.join(probeParent, 'walgit-probe-'))
  try {
    const repo = ensureBareRepo({ repoId: PROBE, dir: path.join(root, `${PROBE}.git`) })
    const origin = 'http://walgit.internal'
    const advertisement = await capture(
      runBackend({
        repo,
        pathInfo: `/${PROBE}.git/info/refs`,
        request: new Request(`${origin}/${PROBE}.git/info/refs?service=git-upload-pack`, {
          headers: { 'git-protocol': 'version=2' },
        }),
      }),
    )
    const lsRefs = await capture(
      runBackend({
        repo,
        pathInfo: `/${PROBE}.git/git-upload-pack`,
        request: new Request(`${origin}/${PROBE}.git/git-upload-pack`, {
          method: 'POST',
          headers: { 'git-protocol': 'version=2', 'content-type': REQUEST_TYPE },
          body: '0014command=ls-refs\n00010000',
        }),
      }),
    )
    const version = spawnSync('git', ['--version'], { encoding: 'utf8' })
    return { version: 1, git: version.stdout.trim(), advertisement, lsRefs }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function capture(pending: Promise<Response>): Promise<CapturedResponse> {
  const response = await pending
  return {
    status: response.status,
    headers: [...response.headers],
    body: await response.text(),
  }
}

/**
 * Capture and publish this container's record, and collect the ones earlier
 * environments left behind. Returns the key written, or `null` when this
 * environment gives the edge no way to tell images apart (`uploadPackKeyFor`)
 * and nothing is published.
 *
 * The older records are deleted because nothing will read them again: the
 * Worker computes one fingerprint, and it is this container's. A Worker
 * version still mid-rollout that reads a deleted one falls through, which is
 * what it would do anyway. The collection is best effort for the same reason.
 */
export async function publishUploadPack(
  store: ObjectStore,
  env: Record<string, string | undefined> = process.env,
  probeParent?: string,
): Promise<string | null> {
  const key = uploadPackKeyFor(env)
  if (key === null) return null
  const record = await captureUploadPack(probeParent)
  const written = await store.put(key, serializeUploadPackRecord(record))
  if (!written.ok) throw new Error(`walgit: could not publish ${key}`)
  try {
    for (const old of await store.list(UPLOAD_PACK_PREFIX)) {
      if (old !== key) await store.delete(old)
    }
  } catch {
    // An extra object of a few hundred bytes, read by nobody.
  }
  return key
}

/**
 * `publishUploadPack` at boot, retried, and never fatal.
 *
 * Off the request path: the request that woke this container is already being
 * served the ordinary way, and until the record lands every ref check simply
 * keeps coming here, which is exactly what happened before the edge answered
 * any. Retried because a boot is when the store is likeliest to be slow, and a
 * record that never lands costs a whole container lifetime of wake-ups.
 */
export async function publishUploadPackAtBoot(store: ObjectStore): Promise<void> {
  for (const delayMs of [0, 2_000, 10_000, 60_000]) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    try {
      const key = await publishUploadPack(store)
      console.log(
        key === null
          ? 'walgit edge-refs: no WALGIT_BUILD_ID, so the edge answers no ref checks'
          : `walgit edge-refs: published ${key}`,
      )
      return
    } catch (err) {
      console.error(`walgit edge-refs: publish failed: ${(err as Error).message}`)
    }
  }
}
