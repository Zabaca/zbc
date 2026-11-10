import type { RestoreStorage } from '../src/restore'

/**
 * The Durable Object's storage as the restore step uses it, in memory, with the bookmarks working the way Cloudflare's page
 * says they do and nothing more: a bookmark is a string that sorts in time order, one can be had for a time within the last 30
 * days, arming a restore answers the bookmark of the moment just before, and the restore happens when the object restarts. The
 * key-value half is what a restore rolls back here, standing in for the whole store (the rows of the real one are
 * SQLite's, and no test can restore those: the runbook's live check on a scratch object is the proof).
 *
 * NOT evidence about Cloudflare: whether `onNextSessionRestoreBookmark` can be called again to replace an arming, how a restart
 * is reported to the caller, and the window itself are all in the runbook's live check.
 */
export class FakeObjectStorage implements RestoreStorage {
  readonly kv = new Map<string, unknown>()
  /** Every bookmark taken, with the kv as it was then: what a restore to it brings back. */
  private readonly history: { bookmark: string; at: number; kv: Map<string, unknown> }[] = []
  private counter = 0
  /** The bookmark the next restart restores to. */
  armedTo: string | null = null
  /** Every arming, in order. */
  readonly armings: string[] = []
  restarts = 0
  failArm = false
  failBookmark = false
  /** What happens when the object restarts, as the runtime makes a new one: the harness swaps its module for a new one. */
  onRestart: () => void = () => {}

  constructor(
    private readonly now: () => number,
    private readonly windowMs = 30 * 24 * 3600_000,
  ) {}

  /** Take a bookmark of the storage as it is now. Real storage does this continuously; a test says when it matters. */
  mark(): string {
    this.counter += 1
    const bookmark = `0000${(this.counter + 0x100).toString(16).padStart(4, '0')}-${this.now().toString(16).padStart(12, '0')}-fakebookmark`
    this.history.push({ bookmark, at: this.now(), kv: new Map(this.kv) })
    return bookmark
  }

  async currentBookmark(): Promise<string> {
    if (this.failBookmark) throw new Error('a durable log of data changes is not stored locally')
    return this.mark()
  }

  async bookmarkForTime(at: Date): Promise<string> {
    if (this.failBookmark) throw new Error('a durable log of data changes is not stored locally')
    if (at.getTime() < this.now() - this.windowMs) throw new Error('the time is outside the 30 day window')
    // The latest bookmark taken at or before that time; the storage begins at the first one.
    const found = [...this.history].reverse().find((h) => h.at <= at.getTime())
    if (!found) throw new Error('there is no history that old')
    return found.bookmark
  }

  async armRestore(bookmark: string): Promise<string> {
    if (this.failArm) throw new Error('Cloudflare would not arm that')
    if (!this.history.some((h) => h.bookmark === bookmark)) throw new Error('that bookmark is not one of this object’s')
    const undo = this.mark()
    this.armedTo = bookmark
    this.armings.push(bookmark)
    return undo
  }

  async get(key: string): Promise<unknown> {
    return this.kv.get(key)
  }

  async put(key: string, value: unknown): Promise<void> {
    this.kv.set(key, structuredClone(value))
  }

  async delete(key: string): Promise<unknown> {
    return this.kv.delete(key)
  }

  /** `ctx.abort()`: the object restarts, applying an armed restore, and the call that asked for it throws. */
  restart(): void {
    this.restarts += 1
    if (this.armedTo !== null) {
      const to = this.history.find((h) => h.bookmark === this.armedTo)
      this.kv.clear()
      for (const [k, v] of to?.kv ?? []) this.kv.set(k, v)
      this.armedTo = null
    }
    this.onRestart()
    throw new Error('Durable Object reset because its code was aborted')
  }
}
