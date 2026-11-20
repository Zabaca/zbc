/**
 * The busy blocks: a "Busy" event the calendar keeps on each of the owner's other calendars for every meeting that makes them busy on one (the space's ADR 0024). No runtime import, so `bun test` drives it over a real SQLite and a fake Google.
 *
 * ── A STANDING WRITE, AND THE ONLY ONE ───────────────────────────────────
 * The owner's switch (Settings, Calendars; off at first) is the owner's word for exactly this kind of write: a bare "Busy" on their own calendars, nobody told. It runs from the calendar's own alarm, after the sync, and nothing else here writes:
 * Claude's invites, moves and cancellations stay under the send rule (src/writes.ts). A run asks the inbox for a write token for an account when its first write needs one, through the run's writing client (`createRunWriter`), and drops it when the run ends.
 *
 * ── THE PLAN IS WORKED OUT AGAIN EVERY RUN ───────────────────────────────
 * What should exist is a function of the store alone: the meetings that make the owner busy (`CalendarStore.blockSources`), which accounts take part, and which can hold a block (live, with the permission to change events, their main calendar shown and read). What does
 * exist is the blocks the store holds, read back from Google like any event. The difference is the work: make what is missing, change an end that moved, remove what stands for nothing. So a crash, a lost notification or a write whose outcome nobody knows leaves
 * nothing to repair: the next run sees the same store and makes the same plan.
 *
 * ── ONE MEETING, ONE ID ──────────────────────────────────────────────────
 * A block's Google event id is derived from the meeting (its iCalendar id and its start, which is one occurrence of a repeating meeting) and the account it is on, in the letters Google allows (a to v and 0 to 9). Making the same block twice is therefore refused by
 * Google (409), and that is read as "it is already there" (or was removed once: the same request then makes it confirmed again). A block whose making had an unknown outcome is found again by its id, never doubled. A meeting that MOVES is a new meeting key: its
 * block is made at the new time and the old one is removed (the old one stands for nothing), and an end that moves alone is a patch.
 *
 * ── WHAT A BLOCK IS ──────────────────────────────────────────────────────
 * "Busy", and nothing of the meeting: no title, guests, place, description or link; private; opaque; no reminders; `sendUpdates=none`. Two private extended properties mark it (`BLOCK_PROPERTY`), which `parseEvent` reads back, so the store knows it for a block:
 * it is never drawn, never counted busy for Claude and never the source of another block (every read of `event` for a screen leaves it out).
 *
 * ── PACE AND FAILURE ─────────────────────────────────────────────────────
 * At most `BLOCKS_PER_RUN` writes a run (the rest is owed another run a few seconds on), the writes that protect the owner's time first (makes, then changes, then removals). A write Google answered with a decision about it (a 400) is kept as the sentence and
 * the run goes on; one that is not a decision (a 5xx, a rate limit, no answer) stops the run, and every failure backs the next run off (30 seconds, doubling to an hour). The owner's own change (the switch, an account) clears the backoff and is tried at once.
 */

import { CALENDAR_BLOCK_AHEAD_MS, CALENDAR_BLOCK_TITLE, type CalendarBlocking, type CalendarBlockingAccount, isoAt } from '@space/workspace'
import { BLOCK_FOR_PROPERTY, BLOCK_PROPERTY, parseEvent } from './event-parse'
import { CalendarAccessError, CalendarError, CalendarGone, CalendarNotFound, CalendarRefused, type RunWriter } from './google'
import type { AccountRow, BlockHeld, CalendarRow, CalendarStore } from './store'

/** The most writes one run makes. */
export const BLOCKS_PER_RUN = 20
/** When a run that left work owes the next one. */
export const BLOCKS_PACE_MS = 5000

export interface BlockDeps {
  store: CalendarStore
  /** A new writing client for one run, or absent where nothing is wired to write (every run with work to do then says so). */
  runWriter?: (() => RunWriter) | undefined
  now: () => number
  /** The company's time zone: the zone a block is made in. */
  zone: string
  /** Tell the page the calendar changed (after it is stored). */
  tell: () => void
  log?: ((line: string) => void) | undefined
}

// ── What a meeting and a block are called ───────────────────────────────────────────────────────────────────────────────────

const LETTERS = '0123456789abcdefghijklmnopqrstuv'

/** Bytes as lower case base32hex (the letters of a Google event id), five bits to a letter. */
function base32hex(bytes: Uint8Array): string {
  let bits = 0
  let held = 0
  let out = ''
  for (const b of bytes) {
    held = (held << 8) | b
    bits += 8
    while (bits >= 5) {
      out += LETTERS[(held >>> (bits - 5)) & 31]
      bits -= 5
    }
    held &= (1 << bits) - 1
  }
  if (bits > 0) out += LETTERS[(held << (5 - bits)) & 31]
  return out
}

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

/** The key of a meeting: what its iCalendar id (or, with none, its place in the store) and its start make, so one occurrence of a repeating meeting has a key of its own. 16 letters. */
export async function meetingKey(identity: string, start: number): Promise<string> {
  return base32hex((await digest(`meeting\n${identity}\n${start}`)).slice(0, 10))
}

/** The Google event id of the block that stands for a meeting on an account's calendar: 32 letters, a to v and 0 to 9, the same for the same meeting and account for ever. */
export async function blockEventId(meeting: string, target: string): Promise<string> {
  return base32hex((await digest(`block\n${meeting}\n${target}`)).slice(0, 20))
}

/** The body of a block, as Google is given it: "Busy" and the mark, nothing of the meeting. */
export function blockBody(eventId: string, meeting: string, target: string, start: number, end: number, zone: string): Record<string, unknown> {
  return {
    id: eventId,
    status: 'confirmed',
    summary: CALENDAR_BLOCK_TITLE,
    start: { dateTime: isoAt(start, zone), timeZone: zone },
    end: { dateTime: isoAt(end, zone), timeZone: zone },
    transparency: 'opaque',
    visibility: 'private',
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { [BLOCK_PROPERTY]: meeting, [BLOCK_FOR_PROPERTY]: target } },
  }
}

// ── The plan ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A target: an account that can hold a block now, and the main calendar the block goes on. */
interface Target {
  account: AccountRow
  calendar: CalendarRow
}

type Step =
  | { kind: 'make'; target: Target; eventId: string; meeting: string; start: number; end: number }
  | { kind: 'change'; held: BlockHeld; target: Target; meeting: string; end: number }
  | { kind: 'remove'; held: BlockHeld; target: Target }

const rank = { make: 0, change: 1, remove: 2 } as const

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300)

export class CalendarBlocks {
  /** A run left work that its pace did not allow: the next run is owed a few seconds on. In memory only: a restarted object runs at once anyway and works the plan out again. */
  private more = false

  constructor(private readonly d: BlockDeps) {}

  private get store(): CalendarStore {
    return this.d.store
  }

  /** Whether an account can hold a block now, and the main calendar it goes on; or why not (in the owner's words) and which button cures it. */
  private holder(a: AccountRow): { target: Target } | { skipped: string; fix: CalendarBlockingAccount['fix'] } {
    if (a.state === 'lapsed') return { skipped: `The sign-in of ${a.address} ended, so no block can be kept on it until it is connected again.`, fix: 'connect-again' }
    if (a.state === 'disconnected') return { skipped: `${a.address} is not connected, so no block can be kept on it.`, fix: 'connect-again' }
    if (a.state === 'needs-calendar') return { skipped: `${a.address} is connected for mail without the calendar permission, so no block can be kept on it. Press Connect calendar and accept it.`, fix: 'connect-calendar' }
    if (!a.events) return { skipped: `${a.address} was connected for reading only, so no block can be kept on it. Press Connect calendar and accept the permission to change events.`, fix: 'connect-calendar' }
    const main = this.store.calendars(a.address).find((c) => c.primary)
    if (!main || !main.shown) return { skipped: `The main calendar of ${a.address} is hidden, so no block can be kept on it. Show it above.`, fix: null }
    return { target: { account: a, calendar: main } }
  }

  /** Whether every account that takes part has had its calendars read once: until then a block that looks like it stands for nothing may stand for a meeting not yet read in, and nothing is removed for that reason. */
  private complete(accounts: readonly AccountRow[]): boolean {
    return accounts.every((a) => !a.blocks || a.state !== 'live' || (a.listToken !== null && this.store.calendars(a.address).every((c) => !c.shown || c.syncToken !== null)))
  }

  /** How the blocks stand, as Settings shows them. */
  view(): CalendarBlocking {
    const s = this.store.blocking()
    return {
      on: s.enabled,
      kept: this.store.keptBlocks(this.d.now()),
      problem: s.problem,
      accounts: this.store.accounts().map((a) => {
        const held = this.holder(a)
        return { address: a.address, label: a.label, hue: a.hue, takesPart: a.blocks, skipped: a.blocks && 'skipped' in held ? held.skipped : null, fix: a.blocks && 'skipped' in held ? held.fix : null }
      }),
    }
  }

  /** When the alarm should ring for the blocks: the end of a backoff, or the pace of a run that left work; never (infinity) when nothing is owed. */
  nextWake(): number {
    const s = this.store.blocking()
    const now = this.d.now()
    if (s.failures > 0 && s.retryAt !== null && s.retryAt > now) return s.retryAt
    return this.more ? now + BLOCKS_PACE_MS : Number.POSITIVE_INFINITY
  }

  /** What the store says should be done, in the order it is done: what protects the owner's time first. */
  private async plan(now: number): Promise<Step[]> {
    const s = this.store.blocking()
    const accounts = this.store.accounts()
    const takingPart = new Set(accounts.filter((a) => a.blocks).map((a) => a.address))
    const targets = new Map<string, Target>()
    for (const a of accounts) {
      if (!a.blocks) continue
      const held = this.holder(a)
      if ('target' in held) targets.set(a.address, held.target)
    }
    // Every block that is held on a calendar this can write to, by its id. One on a calendar that is not the main one of its account is not the calendar's own work to keep.
    const blocks = new Map<string, BlockHeld>()
    for (const b of this.store.blocksHeld()) if (b.primary) blocks.set(b.eventId, b)
    const holderOf = (address: string): Target | null => {
      const a = accounts.find((x) => x.address === address)
      if (!a) return null
      const held = this.holder(a)
      return 'target' in held ? held.target : null
    }

    // The meetings that make the owner busy, each with every participating account that holds a busy copy: a meeting is blocked where it is not.
    const meetings = new Map<string, { identity: string; start: number; end: number; holders: Set<string> }>()
    if (s.enabled) {
      for (const e of this.store.blockSources(now, now + CALENDAR_BLOCK_AHEAD_MS)) {
        if (!takingPart.has(e.account)) continue
        const identity = e.iCalUid ?? `k:${e.calendarId}|${e.eventId}`
        const at = `${identity}\n${e.start}`
        const m = meetings.get(at)
        if (m) {
          m.holders.add(e.account)
          m.end = Math.max(m.end, e.end)
        } else meetings.set(at, { identity, start: e.start, end: e.end, holders: new Set([e.account]) })
      }
    }

    const steps: Step[] = []
    const wanted = new Set<string>()
    for (const m of meetings.values()) {
      const meeting = await meetingKey(m.identity, m.start)
      for (const target of targets.values()) {
        if (m.holders.has(target.account.address)) continue
        // The target's main calendar must have been read once, or a block already there is not known and would be made again.
        if (target.calendar.syncToken === null) continue
        const eventId = await blockEventId(meeting, target.account.address)
        wanted.add(eventId)
        const have = blocks.get(eventId)
        if (!have) steps.push({ kind: 'make', target, eventId, meeting, start: m.start, end: m.end })
        else if (have.end !== m.end) steps.push({ kind: 'change', held: have, target, meeting, end: m.end })
      }
    }

    // What stands for nothing: everything when the switch is off or the account is taken out, and, with every account read once, a block of a future meeting that is not there any more (cancelled, declined, marked free, moved, out of a shown calendar).
    const complete = this.complete(accounts)
    for (const b of blocks.values()) {
      if (wanted.has(b.eventId)) continue
      const target = holderOf(b.account)
      if (!target) continue
      const unwanted = !s.enabled || !takingPart.has(b.account) || (complete && b.end > now)
      if (unwanted) steps.push({ kind: 'remove', held: b, target })
    }
    return steps.sort((x, y) => rank[x.kind] - rank[y.kind])
  }

  /**
   * Put what Google answered for a block into the store, marked, so `events` and the plan see it at once and the read Google's own notification wakes only confirms it (the calendar is not marked owed a read: a read that found no mark on a block would make
   * the block again at every wake). Whatever Google echoed of the mark, the row is the calendar's own block.
   */
  private keep(calendarId: string, meeting: string, raw: unknown): void {
    const parsed = parseEvent(raw, this.d.zone)
    if (parsed.kind === 'event') this.store.putEvent(calendarId, { ...parsed, block: meeting })
  }

  /** One step at Google, and in the store after Google has answered. A decision about the write throws nothing; anything that is not one is thrown. */
  private async apply(step: Step, writer: ReturnType<RunWriter['writer']>): Promise<void> {
    const { zone } = this.d
    if (step.kind === 'make') {
      const { target, eventId, meeting, start, end } = step
      const body = blockBody(eventId, meeting, target.account.address, start, end, zone)
      let raw: Record<string, unknown>
      try {
        raw = await writer.insertEvent(target.calendar.googleId, body, true)
      } catch (error) {
        if (!(error instanceof CalendarError) || error.status !== 409) throw error
        // Google has an event with this id: this very block (made before, its outcome unknown to us), or one that was removed. The same body confirms it either way, and is what a block is.
        const { id: _id, ...again } = body
        raw = await writer.patchEvent(target.calendar.googleId, eventId, again, true)
      }
      this.keep(target.calendar.id, meeting, raw)
      return
    }
    if (step.kind === 'change') {
      const { held, meeting, end } = step
      try {
        const raw = await writer.patchEvent(held.calendarGoogleId, held.eventId, { end: { dateTime: isoAt(end, zone), timeZone: zone } }, true)
        this.keep(held.calendarId, meeting, raw)
      } catch (error) {
        // Gone at Google since it was read: forget it, and the next run makes it.
        if (!(error instanceof CalendarNotFound || error instanceof CalendarGone)) throw error
        this.store.dropEvent(held.calendarId, held.eventId)
      }
      return
    }
    try {
      await writer.deleteEvent(step.held.calendarGoogleId, step.held.eventId, true)
    } catch (error) {
      if (!(error instanceof CalendarNotFound)) throw error
    }
    this.store.dropEvent(step.held.calendarId, step.held.eventId)
  }

  /**
   * One run: the plan, then as much of it as the pace allows. Answers whether the page should be told. Never throws: a failure is kept as a sentence with a backoff, and what was written before it stays written.
   */
  async run(): Promise<boolean> {
    try {
      return await this.runOnce()
    } catch (error) {
      this.d.log?.(`calendar: the busy blocks could not be worked out: ${describe(error)}`)
      this.more = false
      return false
    }
  }

  private async runOnce(): Promise<boolean> {
    const s = this.store.blocking()
    const now = this.d.now()
    this.more = false
    // Nothing to keep and nothing held: the common case of an owner who has not turned it on.
    if (!s.enabled && this.store.blocksHeld().length === 0) return this.store.clearBlockingFailure()
    if (s.failures > 0 && s.retryAt !== null && s.retryAt > now) return false

    const steps = await this.plan(now)
    if (steps.length === 0) return this.store.clearBlockingFailure()
    if (!this.d.runWriter) {
      this.store.recordBlockingFailure('This install cannot change calendar events from here, so the Busy blocks are not kept.')
      return true
    }

    const batch = steps.slice(0, BLOCKS_PER_RUN)
    this.more = steps.length > batch.length
    const run = this.d.runWriter()
    const problems: string[] = []
    const skipped = new Set<string>()
    let changed = false
    let done = 0
    try {
      for (const step of batch) {
        const account = step.kind === 'make' ? step.target.account.address : step.held.account
        if (skipped.has(account)) continue
        try {
          await this.apply(step, run.writer(account))
          changed = true
          done += 1
        } catch (error) {
          this.d.log?.(`calendar: a busy block could not be ${step.kind === 'make' ? 'made' : step.kind === 'change' ? 'changed' : 'removed'} on ${account}: ${describe(error)}`)
          if (error instanceof CalendarAccessError) {
            skipped.add(account)
            problems.push(error.message)
          } else if (error instanceof CalendarRefused) {
            skipped.add(account)
            problems.push(`${error.message} Press Connect calendar in Settings, Calendars and accept it.`)
          } else if (error instanceof CalendarNotFound || error instanceof CalendarGone || (error instanceof CalendarError && error.status >= 400 && error.status < 500 && error.status !== 403 && error.status !== 429)) {
            // Google decided about this one write; the others are not affected.
            problems.push(error.message)
          } else {
            // Not a decision (no answer, a server error, a rate limit): stop, and say that nothing is known of this one.
            problems.push(`Google did not answer cleanly (${describe(error)}); it will be tried again.`)
            this.more = false
            break
          }
        }
      }
    } finally {
      run.end()
    }
    if (problems.length > 0) {
      this.more = false
      this.store.recordBlockingFailure(`Could not keep every Busy block up to date: ${problems[0]}`)
      return true
    }
    if (done === 0) this.more = false
    this.store.clearBlockingFailure()
    if (changed) this.d.tell()
    return changed
  }
}
