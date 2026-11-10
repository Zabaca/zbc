// Storage: one SQLite-backed Durable Object per call, addressed by
// idFromName(<call name>). Nothing crosses calls, so there is no global table of
// them: a call exists exactly when its DO has a `room` row.
//
// One extra instance, idFromName(LEDGER_NAME) (room.ts), holds the service-wide
// usage ledger.
//
// All the rules live in RoomCore (room.ts), which runs here over the DO's
// synchronous SQL. This file only adapts storage and exposes `invoke`; see the
// note in room.ts for why that is one method rather than one per operation.
//
// THE SPACE'S WORKER DEFINES THIS CLASS from this one file and OWNS the objects: it runs the Meet tab in-process and answers the guests' pages, the phone's webhook and the call API. Meet has no
// Worker of its own; while the objects were being moved, the old Worker kept the class in its code, as Cloudflare's transfer requires of the Worker that gave it, and reached the objects through a
// binding to the space's class. The objects are found by the name `idFromName` gets (a call's name, or LEDGER_NAME).

import { DurableObject } from 'cloudflare:workers'
import { EVERYONE, liveOf, tellLive } from '@space/workspace'
import { armsReap, changesPresence, shouldTell } from './room-live'
import { LEDGER_NAME, ROOM_COUNTED, RoomCore, countRows, invokeCore, type InvokeResult, type Sql } from './room'

// The three functions below are not methods of the class: the runtime exposes every method of a Durable Object over RPC.

/** How many are in the call right now, counted WITHOUT dropping anyone who has timed out (a count that reaped first would never see them go), or null when it cannot be counted. */
function presentIn(core: RoomCore): number | null {
  try {
    return core.presentNow()
  } catch {
    return null
  }
}

/** Tell the space's live object that who is in a call changed. The message names no call: a call's name is its link. */
const tellCalls = (env: unknown): void => tellLive(liveOf(env), { part: 'calls', people: EVERYONE })

/**
 * Set the alarm for when the next person present would be dropped for not being heard from. The last person to go (a tab closed, a phone out of signal) is never followed by another call to this object, so
 * nothing else would drop them or tell anyone: the alarm does, and sets itself again while anyone is left. Never throws into the call that asked.
 */
function armReap(ctx: DurableObjectState, core: RoomCore): Promise<void> {
  const at = core.nextReapAt()
  return at === null ? Promise.resolve() : ctx.storage.setAlarm(Math.max(at, Date.now() + 1000)).catch((err: unknown) => console.warn('live: a call could not set its alarm:', err instanceof Error ? err.message : String(err)))
}

export class RoomDO extends DurableObject {
  private readonly core: RoomCore
  private readonly sql: Sql

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never)
    const sql: Sql = {
      all: <T>(q: string, ...params: unknown[]) => ctx.storage.sql.exec(q, ...(params as never[])).toArray() as T[],
      run: (q: string, ...params: unknown[]) => {
        ctx.storage.sql.exec(q, ...(params as never[]))
      },
    }
    this.sql = sql
    // The schema is IF NOT EXISTS throughout, so constructing on every boot is safe.
    this.core = new RoomCore(sql)
    // The line the move's check reads in `wrangler tail space` (the space's ADR 0016): a moved object keeps running its old Worker's code until it
    // restarts, so the first start under the space's code is the proof it has. Only the ledger names itself: a call's name is its link, and stays out of the log.
    if ((ctx.id as { name?: string }).name === LEDGER_NAME) console.log('meet: the ledger object started')
  }

  invoke(method: string, args: unknown[]): InvokeResult {
    if (!changesPresence(method)) return invokeCore(this.core, method, args)
    // Who is in the call may change: count before and after (neither count drops anyone: the call itself reaps, and a person it drops is seen to go), and tell the space's live object once the change is
    // stored (src/room-live.ts). Counting cannot fail the call.
    const before = presentIn(this.core)
    const out = invokeCore(this.core, method, args)
    if (out.ok && shouldTell(method, before, presentIn(this.core))) tellCalls(this.env)
    // Someone joined: the alarm is set for when they would be dropped if they went quiet (it sets itself again while anyone is left).
    if (out.ok && armsReap(method)) void armReap(this.ctx, this.core)
    return out
  }

  /** The alarm: drop whoever has not been heard from for too long and tell the live object if that changed who is in the call, in a call that nobody is calling any more. */
  override async alarm(): Promise<void> {
    const before = presentIn(this.core)
    this.core.reapNow(Date.now())
    if (before !== presentIn(this.core)) tellCalls(this.env)
    await armReap(this.ctx, this.core)
  }

  // THE OPERATOR'S FOUR, for a move of this class between Workers. Like `invoke` they are meant for the Workers that own or bind the class alone; the only caller
  // that reaches them for a person is the space's owner-only routes, and only for the ledger (a call's own object is never named). They touch no call.

  /** How many rows each table holds: numbers under names, read before and after a move. */
  counts(): Record<string, number> {
    return countRows(this.sql, ROOM_COUNTED)
  }

  /** Cloudflare's bookmark of this object's history now: what a restore goes back to. */
  bookmark(): Promise<string> {
    return this.ctx.storage.getCurrentBookmark()
  }

  /** Arm a restore to `bookmark` for the object's next start. Nothing changes until the object restarts (`restart`). */
  restoreTo(bookmark: string): Promise<string> {
    return this.ctx.storage.onNextSessionRestoreBookmark(bookmark)
  }

  /** Drop this object's in-memory state; its next call starts it afresh, under the code of the Worker that owns the class. The caller sees an error (the object was reset under it), which is the answer. */
  restart(): void {
    this.ctx.abort('restarted on the owner’s word')
  }
}
