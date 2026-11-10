import type { RawBucket } from '../src/cloudflare/arrivals'

/**
 * The raw-mail bucket, in memory, that can fail: what the entrance and the arrival work are driven against. It keeps what
 * was put, with its metadata, and a log of every call in order, which is how a test shows the raw copy was written BEFORE
 * the store heard of the message. NOT evidence about R2: what `head` and `put` do on the real bucket is the hand test.
 */
export class FakeBucket implements RawBucket {
  readonly objects = new Map<string, { bytes: ArrayBuffer; metadata: Record<string, string> }>()
  /** Every call, in order: `put:<key>`, `head:<key>`, `get:<key>`, `list:<prefix>`. */
  readonly calls: string[] = []
  /** The key of every object whose body was read (`arrayBuffer` or `text`), in order: what shows a size was checked before a byte was read. */
  readonly bodyReads: string[] = []
  /** Every ranged `get`, in order: what shows a part of a file was read and not the whole of it. */
  readonly ranges: { key: string; offset: number; length: number }[] = []
  /** Make the next calls of that kind throw, until reset. */
  failPut = false
  failGet = false
  failList = false
  failDelete = false
  /** Milliseconds each body read takes, so a test can have reads overlap. */
  readDelayMs = 0
  /** How many body reads are under way now, and the most there have been at once: what shows reads took turns, or did not. */
  active = 0
  maxActive = 0

  async delete(key: string): Promise<unknown> {
    this.calls.push(`delete:${key}`)
    if (this.failDelete) throw new Error('R2 would not delete that')
    this.objects.delete(key)
    return undefined
  }

  async head(key: string): Promise<unknown> {
    this.calls.push(`head:${key}`)
    return this.objects.has(key) ? { key } : null
  }

  /** As R2: `size` is the whole object's, and with a `range` the body is only those bytes. */
  async get(key: string, options?: { range: { offset: number; length: number } }) {
    this.calls.push(`get:${key}`)
    if (this.failGet) throw new Error('R2 would not read that')
    const found = this.objects.get(key)
    if (options) this.ranges.push({ key, ...options.range })
    return found
      ? {
          size: found.bytes.byteLength,
          arrayBuffer: async () => {
            this.active += 1
            this.maxActive = Math.max(this.maxActive, this.active)
            if (this.readDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.readDelayMs))
            this.active -= 1
            this.bodyReads.push(key)
            return options
              ? found.bytes.slice(options.range.offset, options.range.offset + options.range.length)
              : found.bytes.slice(0)
          },
          text: async () => {
            this.bodyReads.push(key)
            return new TextDecoder().decode(found.bytes)
          },
        }
      : null
  }

  async put(
    key: string,
    value: ArrayBuffer | ReadableStream<Uint8Array> | string,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<unknown> {
    this.calls.push(`put:${key}`)
    if (this.failPut) throw new Error('R2 would not write that')
    // A stream is read to its end first (a stream that errors fails the put, as R2's does).
    const bytes =
      typeof value === 'string'
        ? new TextEncoder().encode(value).buffer
        : value instanceof ReadableStream
          ? await new Response(value).arrayBuffer()
          : value.slice(0)
    this.objects.set(key, { bytes: bytes as ArrayBuffer, metadata: options?.customMetadata ?? {} })
    return { key, size: bytes.byteLength }
  }

  /** The keys under a prefix, in R2's order (by key), a page at a time of `limit` (the real default is 1000). */
  async list(options: { prefix: string; cursor?: string; limit?: number }) {
    this.calls.push(`list:${options.prefix}`)
    if (this.failList) throw new Error('R2 would not list that')
    const after = options.cursor ?? ''
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(options.prefix) && k > after).sort()
    const page = keys.slice(0, options.limit ?? 1000)
    const truncated = keys.length > page.length
    return {
      objects: page.map((key) => ({ key })),
      truncated,
      ...(truncated ? { cursor: page.at(-1) as string } : {}),
    }
  }

  /** A kept object's text, for the assertions that it is the message exactly as it came. */
  text(key: string): string {
    return new TextDecoder().decode(this.objects.get(key)?.bytes)
  }
}
