import type { InboxOwner } from './owner'
import { onlyOwnerRestores } from './owner-words'
import { fail, ok, type Result } from './store/store'

/**
 * Restoring the inbox's store to an earlier moment: the precondition of a business's customer mail moving in
 * (the runbook for a business mailbox, "Backups of the inbox's store"; the inbox's ADR 0001).
 *
 * The store is a SQLite-backed Durable Object, and Cloudflare keeps 30 days of its history (point-in-time recovery). The only
 * way to use it is from inside the object: `getCurrentBookmark`, `getBookmarkForTime`, and `onNextSessionRestoreBookmark`,
 * which arranges for the storage to match a bookmark when the object next restarts and answers the bookmark of the moment
 * just before, so a restore can itself be undone. This module is those calls and the rules around them, over ports, so
 * `bun test` drives it with a fake; durable.ts supplies the real ones. Nothing in a worktree can run a real restore.
 *
 * ── THE FLOW, TWO CALLS ────────────────────────────────────────────────
 * 1. `prepareRestore` (the owner only) resolves a bookmark or a time to the bookmark it would restore to, and answers it with a
 *    confirmation token that is good for five minutes and for that bookmark only. It changes nothing in the store.
 * 2. `confirmRestore` (the owner only) must be sent the token AND the bookmark back, so a restore cannot be made blind or from a
 *    stale screen. It arms the restore, keeps the record, and answers the UNDO bookmark. The route then calls
 *    `restartForRestore`, which is the `ctx.abort()` the storage page asks for: the abort throws in the call that makes it, so
 *    the answer to the caller has to come from the call before.
 * Claude's service token can read the bookmarks (`restoreBookmarks`, so it can capture one before a risky deploy) and can do
 * nothing else here: the routes refuse it and so does every method below that writes, by default.
 *
 * ── THE RECORD LIVES IN R2, NOT IN THE STORE ───────────────────────────
 * The store's audit table is part of what a restore rolls back, so a restore that wrote its own audit row there would erase it.
 * Each preparation and each restore is written as a JSON object under `restores/` in the raw-mail bucket, which a restore does
 * not touch, BEFORE anything is changed: no record, no restore (a Worker with no bucket bound refuses both). Its key sorts in
 * time order, and `restoreBookmarks` lists the latest, so the undo bookmark of any restore is still readable after it.
 *
 * ── WHILE ARMED THE OBJECT RESTARTS INSTEAD OF SERVING ─────────────────
 * Between arming and the restart, a write would land in a store that is about to be replaced and could not be undone (the undo
 * bookmark is the moment of arming). So once armed, `restartIfArmed` is the first thing every call and the alarm does: it
 * restarts the object, which applies the restore, rather than serving or refusing. That makes the route's own restart call
 * only the prompt one: if it never comes (the client disconnects, the cancel below failed), the next call of any kind
 * does it, and the object is never left refusing work while something keeps it alive.
 *
 * A restore that is armed back to the undo bookmark (the record could not be kept) is restarted the same way. It is armed
 * to the moment it was armed at, so the restart applies nothing; leaving it pending would apply it at the next restart
 * and erase every write between.
 *
 * The 30-day window and everything about what Cloudflare does with these calls is documentation, not something this repo has
 * seen (the runbook's live check is the one that does).
 */

/** Where the records of preparations and restores are kept, in the raw-mail bucket. */
export const RESTORE_PREFIX = 'restores/'

/** How long a confirmation token is good for. */
export const CONFIRM_WINDOW_MS = 5 * 60_000

/** How many records the bookmark answer carries. */
const RECENT = 10

const PENDING_KEY = 'restore:pending'

const NO_BUCKET = 'This Worker has no raw-mail bucket bound, so a restore could not be recorded and none is made.'

/** A bookmark is an opaque string Cloudflare gives out; this refuses what cannot be one before it is sent anywhere. */
const BOOKMARK = /^[A-Za-z0-9._:-]{8,300}$/

/** A time with its zone stated: "2026-10-26T09:30:00-07:00" or "...Z". A time with none would mean whatever the Worker's clock says. */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/** What the object's storage offers, as `ctx.storage` offers it. */
export interface RestoreStorage {
  currentBookmark(): Promise<string>
  bookmarkForTime(at: Date): Promise<string>
  /** `onNextSessionRestoreBookmark`: arm the restore; answers the bookmark of the moment just before. */
  armRestore(bookmark: string): Promise<string>
  /** The key-value half of the storage (the pending confirmation lives there, so a restore also wipes it). */
  get(key: string): Promise<unknown>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<unknown>
  /** `ctx.abort()`: restart the object. Throws, as the runtime's does. */
  restart(): void
}

/** The part of the raw-mail bucket this uses. */
export interface RestoreBucket {
  put(key: string, value: string, options?: { customMetadata?: Record<string, string> }): Promise<unknown>
  list(options: {
    prefix: string
    cursor?: string
    limit?: number
  }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>
  get(key: string): Promise<{ text(): Promise<string> } | null>
}

export interface RestorePorts {
  storage: RestoreStorage
  /**
   * Run `fn` with no other event let into the object (`ctx.blockConcurrencyWhile`). `fn` must not throw: the runtime
   * resets the object when it does. Everything inside answers a Result.
   */
  exclusive: <T>(fn: () => Promise<T>) => Promise<T>
  /** The raw-mail bucket, or null in a Worker deployed without one, which then restores nothing. */
  bucket: RestoreBucket | null
  now: () => Date
  /** A hard-to-guess string, new each call. */
  newToken: () => string
  /** The install's owner: the only actor a restore admits. */
  owner: InboxOwner
}

/** One preparation or one restore, as kept in R2. */
export interface RestoreRecord {
  kind: 'prepared' | 'restored'
  /** The same for a preparation and the restore that confirms it. */
  id: string
  at: string
  actor: string
  /** The bookmark the restore goes to. */
  target: string
  /** The time it was asked for, when it was asked for by a time. */
  targetTime: string | null
  /** The store's bookmark when the preparation was made. */
  current: string
  /** On a restore: the bookmark of the moment just before it, which restores everything it replaced. */
  undoBookmark: string | null
  /** On a preparation: when its token stops working. */
  expiresAt: string | null
}

export interface BookmarkReport {
  current: string
  at: string
  /** The bookmark for the time asked about, when one was. */
  forTime: { time: string; bookmark: string } | null
  /** The latest records, newest first. */
  restores: RestoreRecord[]
  /** Why `restores` could not be read, when it could not (the bookmarks are still right). */
  restoresError: string | null
}

export interface RestorePlan {
  target: string
  targetTime: string | null
  current: string
  token: string
  expiresAt: string
  /** What to send to confirm, and what happens when it is sent. */
  next: string
}

export interface RestoreDone {
  restoredTo: string
  targetTime: string | null
  /** Restoring to this puts back everything the restore replaced. */
  undoBookmark: string
  by: string
  at: string
  /** The R2 key of the record. */
  record: string
  next: string
}

interface Pending {
  id: string
  token: string
  target: string
  targetTime: string | null
  current: string
  requestedBy: string
  expiresAt: string
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class Restores {
  private restoring = false

  constructor(private readonly ports: RestorePorts) {}

  /** True once a restore (or the cancelling of one) is armed and waits for the object to restart. */
  get armed(): boolean {
    return this.restoring
  }

  /**
   * The first line of every call into the object and of its alarm (durable.ts): when a restore is armed, restart now. Does
   * nothing otherwise. It throws, as the abort does, and so the call that triggered it fails; the caller tries again against the
   * new object. Kept to one place so a method added later is covered without anyone remembering it.
   */
  restartIfArmed(): void {
    if (!this.restoring) return
    this.ports.storage.restart()
    throw new Error('The store is being restored and is restarting. Try again in a moment.')
  }

  /**
   * The store's current bookmark, the bookmark for `time` if one is asked about, and the latest records of restores. A read, open
   * to the agent: it is how Claude captures a bookmark before a risky deploy, and it changes nothing.
   */
  async restoreBookmarks(time: string | null): Promise<Result<BookmarkReport>> {
    const now = this.ports.now()
    let forTime: BookmarkReport['forTime'] = null
    if (time !== null) {
      const at = this.parseTime(time)
      if (!at.ok) return at
      const bookmark = await this.bookmarkAt(at.value)
      if (!bookmark.ok) return bookmark
      forTime = { time: at.value.toISOString(), bookmark: bookmark.value }
    }
    const current = await this.currentBookmark()
    if (!current.ok) return current
    const recent = await this.recent()
    return ok({ current: current.value, at: now.toISOString(), forTime, ...recent })
  }

  /** Step 1: the owner names a bookmark or a time; nothing changes, and a token comes back. */
  async prepareRestore(input: { bookmark?: unknown; time?: unknown }, actor: string): Promise<Result<RestorePlan>> {
    if (actor !== this.ports.owner.email) return fail(403, onlyOwnerRestores(this.ports.owner.name))
    if (!this.ports.bucket) return fail(503, NO_BUCKET)
    const { bookmark, time } = input
    if ((bookmark === undefined) === (time === undefined)) {
      return fail(422, 'Say which: {"bookmark": "..."} or {"time": "2026-10-26T09:30:00-07:00"}, one of them.')
    }
    const now = this.ports.now()
    let target: string
    let targetTime: string | null = null
    if (typeof time === 'string') {
      const at = this.parseTime(time)
      if (!at.ok) return at
      const found = await this.bookmarkAt(at.value)
      if (!found.ok) return found
      target = found.value
      targetTime = at.value.toISOString()
    } else if (typeof bookmark === 'string' && BOOKMARK.test(bookmark)) {
      target = bookmark
    } else {
      return fail(422, 'That is not a bookmark or a time. A bookmark is the string `bookmark` prints.')
    }
    const current = await this.currentBookmark()
    if (!current.ok) return current

    const pending: Pending = {
      id: this.ports.newToken().slice(0, 12),
      token: this.ports.newToken(),
      target,
      targetTime,
      current: current.value,
      requestedBy: actor,
      expiresAt: new Date(now.getTime() + CONFIRM_WINDOW_MS).toISOString(),
    }
    try {
      await this.keep({
        kind: 'prepared',
        id: pending.id,
        at: now.toISOString(),
        actor,
        target,
        targetTime,
        current: current.value,
        undoBookmark: null,
        expiresAt: pending.expiresAt,
      })
      await this.ports.storage.put(PENDING_KEY, pending)
    } catch (error) {
      return fail(503, `The restore could not be prepared, so nothing was: ${describe(error)}`)
    }
    return ok({
      target,
      targetTime,
      current: current.value,
      token: pending.token,
      expiresAt: pending.expiresAt,
      next:
        `Nothing has changed. To restore the store to ${target}, send {"token": ..., "bookmark": "${target}"} to confirm ` +
        'within five minutes. The restore replaces everything the inbox holds with how it was then; mail since is gone from ' +
        'the store (its raw copy stays in the bucket), and the answer carries the bookmark that undoes it.',
    })
  }

  /** Step 2: the token and the bookmark sent back. Arms the restore and keeps the record; the route then restarts the object. */
  async confirmRestore(input: { token?: unknown; bookmark?: unknown }, actor: string): Promise<Result<RestoreDone>> {
    if (actor !== this.ports.owner.email) return fail(403, onlyOwnerRestores(this.ports.owner.name))
    if (!this.ports.bucket) return fail(503, NO_BUCKET)
    // Nothing inside may throw (see RestorePorts.exclusive), so every way out is a Result.
    return this.ports.exclusive(async () => {
      try {
        return await this.confirm(input, actor)
      } catch (error) {
        return fail(503, `The restore did not happen: ${describe(error)}`)
      }
    })
  }

  private async confirm(input: { token?: unknown; bookmark?: unknown }, actor: string): Promise<Result<RestoreDone>> {
    const { storage } = this.ports
    const pending = (await storage.get(PENDING_KEY)) as Pending | undefined
    if (!pending) {
      return fail(
        409,
        'Nothing is waiting to be confirmed. Prepare the restore first; a confirmation lasts five minutes.',
      )
    }
    // Single use, and the owner's: a token another person or another time prepared does not confirm.
    if (typeof input.token !== 'string' || input.token !== pending.token || pending.requestedBy !== actor) {
      return fail(409, 'That is not the current confirmation. Prepare the restore again and use the token it gives.')
    }
    const now = this.ports.now()
    if (now.getTime() > Date.parse(pending.expiresAt)) {
      await storage.delete(PENDING_KEY)
      return fail(409, 'That confirmation has expired. Prepare the restore again.')
    }
    if (input.bookmark !== pending.target) {
      return fail(
        422,
        `Send back the bookmark you are restoring to, ${pending.target}, with the token. Nothing was changed.`,
      )
    }
    await storage.delete(PENDING_KEY)

    let undo: string
    try {
      undo = await storage.armRestore(pending.target)
    } catch (error) {
      return fail(
        422,
        `Cloudflare would not arm a restore to ${pending.target}: ${describe(error)}. Nothing was changed.`,
      )
    }
    let record: string
    try {
      record = await this.keep({
        kind: 'restored',
        id: pending.id,
        at: now.toISOString(),
        actor,
        target: pending.target,
        targetTime: pending.targetTime,
        current: pending.current,
        undoBookmark: undo,
        expiresAt: null,
      })
    } catch (error) {
      // No record, no restore: put the arming back to the moment it was made, which is what the store is now. An arming
      // left pending applies at the next restart and erases every write in between, so either way the object restarts at
      // once (the route does it, and any call does if the route does not).
      this.restoring = true
      try {
        await storage.armRestore(undo)
      } catch (again) {
        return fail(
          503,
          `The restore could not be recorded and could not be cancelled (${describe(again)}). The store restarts now and ` +
            `comes back as it was at ${pending.target}; the bookmark that undoes it is ${undo}.`,
        )
      }
      return fail(
        503,
        `The restore could not be recorded, so it was cancelled and nothing changed (the store restarts once to settle that): ${describe(error)}`,
      )
    }
    this.restoring = true
    return ok({
      restoredTo: pending.target,
      targetTime: pending.targetTime,
      undoBookmark: undo,
      by: actor,
      at: now.toISOString(),
      record,
      next: `The store restarts now and comes back as it was at ${pending.target}. To undo this, restore to ${undo}.`,
    })
  }

  /**
   * The prompt restart the route asks for after a confirmation, answered or refused. Reached through `call`, which restarts an
   * armed object before getting here (`restartIfArmed`), so this body runs only to say that nothing is armed (409). It is a
   * method of its own so the route says what it means; the abort throws, as an abort does.
   */
  async restartForRestore(actor: string): Promise<Result<never>> {
    if (actor !== this.ports.owner.email) return fail(403, onlyOwnerRestores(this.ports.owner.name))
    if (!this.restoring) return fail(409, 'No restore is armed, so nothing is restarted.')
    this.ports.storage.restart()
    return fail(503, 'The store did not restart.')
  }

  private parseTime(text: string): Result<Date> {
    const at = ISO_WITH_ZONE.test(text) ? new Date(text) : null
    if (at === null || Number.isNaN(at.getTime())) {
      return fail(422, 'A time is written with its zone, like 2026-10-26T09:30:00-07:00 or 2026-10-26T16:30:00Z.')
    }
    if (at.getTime() > this.ports.now().getTime()) return fail(422, 'That time has not happened yet.')
    return ok(at)
  }

  private async currentBookmark(): Promise<Result<string>> {
    try {
      return ok(await this.ports.storage.currentBookmark())
    } catch (error) {
      return fail(503, `The store could not give its current bookmark: ${describe(error)}`)
    }
  }

  private async bookmarkAt(at: Date): Promise<Result<string>> {
    try {
      return ok(await this.ports.storage.bookmarkForTime(at))
    } catch (error) {
      return fail(
        422,
        `Cloudflare has no bookmark for ${at.toISOString()}: ${describe(error)}. It keeps 30 days of history, no more.`,
      )
    }
  }

  /** Write a record to R2 and answer its key. Throws when it cannot, which every caller treats as "do not go on". */
  private async keep(record: RestoreRecord): Promise<string> {
    const bucket = this.ports.bucket
    if (!bucket) throw new Error(NO_BUCKET)
    const key = `${RESTORE_PREFIX}${record.at}-${record.kind}-${record.id}.json`
    await bucket.put(key, JSON.stringify(record, null, 2), {
      customMetadata: { kind: record.kind, actor: record.actor, target: record.target },
    })
    return key
  }

  /** The latest records, newest first. A bucket that will not list leaves the bookmarks answerable and says why. */
  private async recent(): Promise<{ restores: RestoreRecord[]; restoresError: string | null }> {
    const bucket = this.ports.bucket
    if (!bucket) return { restores: [], restoresError: NO_BUCKET }
    try {
      const keys: string[] = []
      let cursor: string | undefined
      // Bounded: a record is a few hundred bytes and there will be a handful, so twenty pages is a loop, not a bucket.
      for (let page = 0; page < 20; page += 1) {
        const listed = await bucket.list({ prefix: RESTORE_PREFIX, ...(cursor ? { cursor } : {}) })
        keys.push(...listed.objects.map((o) => o.key))
        if (!listed.truncated || !listed.cursor) break
        cursor = listed.cursor
      }
      const latest = keys.sort().slice(-RECENT).reverse()
      const restores: RestoreRecord[] = []
      for (const key of latest) {
        const object = await bucket.get(key)
        if (!object) continue
        try {
          restores.push(JSON.parse(await object.text()) as RestoreRecord)
        } catch {
          // A record that is not ours to read is skipped; the key is still in the bucket.
        }
      }
      return { restores, restoresError: null }
    } catch (error) {
      return { restores: [], restoresError: `The records could not be read: ${describe(error)}` }
    }
  }
}
