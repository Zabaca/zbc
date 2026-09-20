/**
 * `FileStore` — an `ObjectStore` backed by a local directory.
 *
 * The interface and the two portable implementations (`MemoryStore`,
 * `S3Store`) are in `shared/store.ts`, which both halves of walgit compile.
 * This one cannot go with them and should not: it is `node:fs` and an
 * `mkdir`-based lock, which is the container's disk (docs/adr/0010).
 */

import * as fs from 'node:fs'
import * as nodePath from 'node:path'

import type {
  ConditionalGetResult,
  GetResult,
  ObjectStore,
  PutCondition,
  PutResult,
} from '../shared/store'
import { acquireLock } from './mkdir-lock'

// ── Filesystem implementation ───────────────────────────────────────────────

/**
 * A store backed by a local directory.
 *
 * It exists so the push path can be exercised end to end — real `git push`,
 * real hooks, real hook subprocesses — without a network or a bucket. The
 * in-memory store cannot do that job: hooks run in their own processes and
 * share nothing with the test but the filesystem.
 *
 * Its compare-and-swap is real, not a pretence: the ETag lives in a sidecar
 * file and every conditional write takes an exclusive lock, acquired with
 * `mkdir`, which is atomic on POSIX. That is enough for concurrent hook
 * processes on one machine, which is precisely the concurrency a single walgit
 * node has. It is NOT a substitute for a real bucket across machines — there
 * is no shared lock there, only the store's own conditional write.
 */
export class FileStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    return `${this.root}/${key}`
  }

  private etagPath(key: string): string {
    return `${this.root}/${key}.walgit-etag`
  }

  async get(key: string): Promise<GetResult> {
    if (!fs.existsSync(this.path(key))) return null
    return {
      // The `Buffer` is returned as it is: it already IS a `Uint8Array`, and
      // wrapping it would copy every byte read back out of the store.
      body: fs.readFileSync(this.path(key)),
      etag: fs.readFileSync(this.etagPath(key), 'utf8'),
    }
  }

  async getIfNoneMatch(key: string, etag: string): Promise<ConditionalGetResult> {
    const found = await this.get(key)
    if (!found) return { status: 'absent' }
    if (found.etag === etag) return { status: 'not-modified' }
    return { status: 'ok', body: found.body, etag: found.etag }
  }

  async put(key: string, body: Uint8Array, condition?: PutCondition): Promise<PutResult> {
    fs.mkdirSync(nodePath.dirname(this.path(key)), { recursive: true })
    const release = condition ? await this.lock(key) : () => {}
    try {
      if (condition) {
        const current = fs.existsSync(this.path(key))
          ? fs.readFileSync(this.etagPath(key), 'utf8')
          : null
        if ('ifAbsent' in condition && current !== null) {
          return { ok: false, reason: 'precondition-failed' }
        }
        if ('ifMatch' in condition && current !== condition.ifMatch) {
          return { ok: false, reason: 'precondition-failed' }
        }
      }
      const etag = `"${crypto.randomUUID()}"`
      // The body lands first and the ETag second: a reader that catches the
      // window sees the old ETag with new bytes, which fails its next CAS —
      // whereas the reverse order would hand out an ETag for bytes not yet on
      // disk and let that CAS succeed.
      fs.writeFileSync(this.path(key), body)
      fs.writeFileSync(this.etagPath(key), etag)
      return { ok: true, etag }
    } finally {
      release()
    }
  }

  /**
   * A conditional write is over in milliseconds, so a lock still held after a
   * second belongs to a process that died mid-write — and one of those would
   * otherwise wedge every later push. See `mkdir-lock.ts` for why breaking it
   * is safe.
   */
  private async lock(key: string): Promise<() => void> {
    const dir = `${this.root}/.walgit-locks`
    fs.mkdirSync(dir, { recursive: true })
    const lockPath = `${dir}/${key.replace(/[^A-Za-z0-9]/g, '_')}.lock`
    return acquireLock(lockPath, { breakAfter: 200 })
  }

  async delete(key: string): Promise<void> {
    fs.rmSync(this.path(key), { force: true })
    fs.rmSync(this.etagPath(key), { force: true })
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = []
    const walk = (rel: string) => {
      const abs = rel ? `${this.root}/${rel}` : this.root
      if (!fs.existsSync(abs)) return
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        if (entry.name === '.walgit-locks') continue
        const child = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) walk(child)
        else if (!child.endsWith('.walgit-etag') && child.startsWith(prefix)) keys.push(child)
      }
    }
    walk('')
    return keys.sort()
  }
}
