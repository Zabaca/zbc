/**
 * The object-store seam.
 *
 * Everything walgit persists goes through this interface, because the store is
 * the source of truth and swapping it must not be a rewrite: R2 in production,
 * an in-memory implementation in tests, S3/MinIO/Tigris for portability. See
 * this repository's docs/adr/0007-walgit-object-storage-holds-the-log.md.
 *
 * The interface is deliberately narrow — five operations, exactly what the WAL
 * needs. In particular it exposes CONDITIONAL writes as a first-class result
 * rather than an exception, because losing a compare-and-swap is a normal
 * outcome on the push path, not an error: two pushes raced and one has to be
 * told to try again.
 */

import * as fs from 'node:fs'
import * as nodePath from 'node:path'

/** A conditional precondition on a write. */
export type PutCondition =
  /** Write only if the object's current ETag matches (compare-and-swap). */
  | { ifMatch: string }
  /** Write only if the object does not exist yet. */
  | { ifAbsent: true }

export type PutResult =
  | { ok: true; etag: string }
  /** The precondition failed: someone else wrote first. Not an error. */
  | { ok: false; reason: 'precondition-failed' }

export type GetResult = { body: Uint8Array; etag: string } | null

/** Result of a conditional read — the cheap "am I current?" check. */
export type ConditionalGetResult =
  | { status: 'not-modified' }
  | { status: 'ok'; body: Uint8Array; etag: string }
  | { status: 'absent' }

export interface ObjectStore {
  get(key: string): Promise<GetResult>
  /**
   * Read only if the caller's ETag is stale. A `not-modified` answer is a
   * metadata-only round trip, which is what makes "is my cached repo current?"
   * cheap enough to do on every request.
   */
  getIfNoneMatch(key: string, etag: string): Promise<ConditionalGetResult>
  /** Unconditional when `condition` is omitted. */
  put(key: string, body: Uint8Array, condition?: PutCondition): Promise<PutResult>
  delete(key: string): Promise<void>
  /** Keys under a prefix, lexicographically ascending. */
  list(prefix: string): Promise<string[]>
}

// ── In-memory implementation ────────────────────────────────────────────────

/**
 * For tests. Faithful about the one property that matters: a conditional put
 * evaluates its precondition and swaps atomically with respect to other
 * in-flight puts.
 *
 * `yieldBeforeWrite` exists because JavaScript would otherwise make this test
 * nothing. Without a suspension point between reading the current ETag and
 * writing, every put runs to completion uninterrupted and a broken CAS
 * implementation would still pass. The hook forces the interleaving that a real
 * network round trip would produce.
 */
export class MemoryStore implements ObjectStore {
  private objects = new Map<string, { body: Uint8Array; etag: string }>()
  private counter = 0

  constructor(private readonly yieldBeforeWrite: () => Promise<void> = async () => {}) {}

  private nextEtag(): string {
    this.counter += 1
    return `"mem-${this.counter}"`
  }

  async get(key: string): Promise<GetResult> {
    const found = this.objects.get(key)
    return found ? { body: found.body, etag: found.etag } : null
  }

  async getIfNoneMatch(key: string, etag: string): Promise<ConditionalGetResult> {
    const found = this.objects.get(key)
    if (!found) return { status: 'absent' }
    if (found.etag === etag) return { status: 'not-modified' }
    return { status: 'ok', body: found.body, etag: found.etag }
  }

  async put(key: string, body: Uint8Array, condition?: PutCondition): Promise<PutResult> {
    // Read the precondition's subject, then suspend — this is the window a
    // real store has, and the window a wrong implementation loses data in.
    const before = this.objects.get(key)
    await this.yieldBeforeWrite()

    // Re-read after the suspension: the check and the swap must both see the
    // same state, which is the whole contract being modelled.
    const current = this.objects.get(key)
    if (condition) {
      if ('ifAbsent' in condition && current) return { ok: false, reason: 'precondition-failed' }
      if ('ifMatch' in condition && current?.etag !== condition.ifMatch) {
        return { ok: false, reason: 'precondition-failed' }
      }
      // A racing writer that landed during the suspension invalidates a
      // precondition that was true when we started.
      if (current?.etag !== before?.etag) return { ok: false, reason: 'precondition-failed' }
    }

    const etag = this.nextEtag()
    this.objects.set(key, { body, etag })
    return { ok: true, etag }
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort()
  }
}

// ── S3-compatible implementation (R2, S3, MinIO, Tigris) ────────────────────

export interface S3StoreOptions {
  /** e.g. `https://<account>.r2.cloudflarestorage.com` */
  endpoint: string
  bucket: string
  /** Signs each request. `aws4fetch`'s `AwsClient.fetch` satisfies this. */
  fetch: (input: string, init?: RequestInit) => Promise<Response>
}

/**
 * Conditional writes were verified against R2 on 2026-08-20 — 16 concurrent
 * writers against one ETag produced exactly one 200 and fifteen 412s, with no
 * torn writes. See docs/research/walgit-m0-spike/.
 *
 * Portability caveat worth carrying: Tigris honours the same headers but only
 * evaluates them safely on Multi-region or Single-region buckets. Its Global
 * and Dual-region types are strong same-region and eventual cross-region, and a
 * sub-second replication window is exactly wide enough to lose a push race and
 * never reproduce it.
 */
export class S3Store implements ObjectStore {
  constructor(private readonly opts: S3StoreOptions) {}

  private url(key: string): string {
    return `${this.opts.endpoint}/${this.opts.bucket}/${key}`
  }

  async get(key: string): Promise<GetResult> {
    const res = await this.opts.fetch(this.url(key))
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`GET ${key}: HTTP ${res.status}`)
    return { body: new Uint8Array(await res.arrayBuffer()), etag: res.headers.get('etag') ?? '' }
  }

  async getIfNoneMatch(key: string, etag: string): Promise<ConditionalGetResult> {
    const res = await this.opts.fetch(this.url(key), { headers: { 'If-None-Match': etag } })
    if (res.status === 304) return { status: 'not-modified' }
    if (res.status === 404) return { status: 'absent' }
    if (!res.ok) throw new Error(`GET ${key}: HTTP ${res.status}`)
    return {
      status: 'ok',
      body: new Uint8Array(await res.arrayBuffer()),
      etag: res.headers.get('etag') ?? '',
    }
  }

  async put(key: string, body: Uint8Array, condition?: PutCondition): Promise<PutResult> {
    const headers: Record<string, string> = {}
    if (condition && 'ifMatch' in condition) headers['If-Match'] = condition.ifMatch
    if (condition && 'ifAbsent' in condition) headers['If-None-Match'] = '*'

    // `Uint8Array` is a valid BodyInit at runtime; the cast is only to bridge
    // TS 5.7's `Uint8Array<ArrayBufferLike>` against lib.dom's narrower
    // `BodyInit`, which does not accept the generic form.
    const res = await this.opts.fetch(this.url(key), {
      method: 'PUT',
      body: body as unknown as BodyInit,
      headers,
    })
    // 412 is the documented precondition failure. 409 is included because
    // S3-compatible stores have historically used it for the same condition
    // under concurrent load; treating it as an error would surface a normal
    // race as an outage.
    if (res.status === 412 || res.status === 409)
      return { ok: false, reason: 'precondition-failed' }
    if (!res.ok) throw new Error(`PUT ${key}: HTTP ${res.status}`)
    return { ok: true, etag: res.headers.get('etag') ?? '' }
  }

  async delete(key: string): Promise<void> {
    const res = await this.opts.fetch(this.url(key), { method: 'DELETE' })
    if (!res.ok && res.status !== 404) throw new Error(`DELETE ${key}: HTTP ${res.status}`)
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let token: string | undefined
    do {
      const params = new URLSearchParams({ 'list-type': '2', prefix })
      if (token) params.set('continuation-token', token)
      const res = await this.opts.fetch(`${this.opts.endpoint}/${this.opts.bucket}?${params}`)
      if (!res.ok) throw new Error(`LIST ${prefix}: HTTP ${res.status}`)
      const xml = await res.text()
      for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]!)
      token = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1]
    } while (token)
    return keys.sort()
  }
}

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
      body: new Uint8Array(fs.readFileSync(this.path(key))),
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

  private async lock(key: string): Promise<() => void> {
    const dir = `${this.root}/.walgit-locks`
    fs.mkdirSync(dir, { recursive: true })
    const lockPath = `${dir}/${key.replace(/[^A-Za-z0-9]/g, '_')}.lock`
    for (let i = 0; ; i += 1) {
      try {
        fs.mkdirSync(lockPath)
        return () => {
          try {
            fs.rmdirSync(lockPath)
          } catch {
            /* already released */
          }
        }
      } catch {
        // A holder that died mid-write would otherwise wedge every later push,
        // so the wait is bounded and then broken.
        if (i > 200) {
          try {
            fs.rmdirSync(lockPath)
          } catch {
            /* someone else broke it first */
          }
        }
        await new Promise((r) => setTimeout(r, 5))
      }
    }
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
