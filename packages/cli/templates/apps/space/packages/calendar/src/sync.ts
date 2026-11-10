/**
 * The sync: how Google's calendars come into the store and stay current, with the order of operations around the awaits. The store (src/store.ts) holds every rule about what is kept; this asks Google and tells it.
 *
 * ── THE MODEL (like the inbox: no polling all the time) ──────────
 * For each SHOWN calendar of each live account: a first FULL read of a window (three months back, half a year ahead; repeats already expanded by Google), kept with Google's sync token; then INCREMENTAL reads from that token,
 * woken by Google's PUSH notifications (a watch channel per calendar, and one per account for its list of calendars) which are only hints: the notification carries no body, and the change is read from Google with the
 * token. Nothing polls. Three things keep it honest:
 *   - a channel lives a week at most and does not renew itself, so one with a day left is REPLACED (the new one first, then the old one stopped);
 *   - a notification can be lost ("a small percentage of messages get dropped": Google's own words), so every shown calendar is also read by its token every `SAFETY_RESYNC_MS` (a read that finds nothing is one cheap call);
 *   - Google answers 410 to a token it no longer honours, and that means a FULL read again (the store forgets the token and reads the window). The window is rolling and a token keeps the window it was made with, so a full
 *     read also happens every `FULL_RESYNC_MS`.
 * The tab and Today read the store and never Google.
 *
 * ── A READ THAT FAILS LEAVES THE PICTURE ALONE ──────────────────────────
 * A full read is applied in one transaction (events, token and window together), so a read that dies leaves the old events with the old token. A failure is kept as a sentence on the calendar with a backoff, and the events
 * already held stay and are drawn with when they were read.
 *
 * ── THE GRANT IS THE INBOX'S ─────────────────────────────────────────────
 * Who is connected, and whether the grant is lapsed or lacks the calendar permission, is the inbox's word (`grants`). An access token is asked of the inbox with every account's call (src/google.ts); when it is refused, the
 * account is marked with the reason and nothing is asked of Google for it until the inbox says it is live again. A lapse is NOT retried: it would only hammer Google (the inbox's rule too).
 *
 * ONE RUN AT A TIME. `run` is serialised by the caller (the Durable Object's alarm); the push and the screens' reads never wait on it.
 */

import type { CalendarGrant } from '@space/workspace'
import { parseEvent, type GoneEvent, type ParsedEvent } from './event-parse'
import {
  type CalendarApi,
  CalendarAccessError,
  CalendarGone,
  CalendarNotFound,
  CalendarRefused,
  MAX_PAGES,
  type RawList,
} from './google'
import {
  ACCOUNTS_CHECK_MS,
  type AccountRow,
  type CalendarRow,
  type CalendarStore,
  type ChannelRow,
  renewAtOf,
  listedCalendar,
  windowAround,
  type ListedCalendar,
} from './store'

export interface SyncDeps {
  store: CalendarStore
  /** Google, for one account at a time. */
  api: (address: string) => CalendarApi
  /** The inbox's word on who is connected. */
  grants: () => Promise<readonly CalendarGrant[]>
  now: () => number
  /** The company's time zone: where an all-day event's days begin and end. */
  zone: string
  /** The https address Google's notifications are sent to. Null: no channels are made, and the safety resync is all that wakes a read. */
  pushUrl: string | null
  /** A new channel's id (a UUID) and its secret. */
  newId: () => string
  newToken: () => string
  log?: (line: string) => void
}

/** What Google's notification says, as its headers (the body is empty). */
export interface PushHeaders {
  channelId: string
  token: string | null
  resourceId: string | null
  /** `sync` (the channel was made), `exists` (something changed) or `not_exists`. */
  state: string | null
}

/** Equal text in time that does not depend on where it differs. */
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

const describe = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').slice(0, 300)
}

export class CalendarSync {
  /** When the inbox was last asked who is connected, whether or not it answered. Null until the first ask (the object has just started): a look is then owed at once. */
  private lastAttempt: number | null = null

  constructor(private readonly d: SyncDeps) {}

  private get store(): CalendarStore {
    return this.d.store
  }

  // ── Who is connected ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** Ask the inbox who is connected and apply it. Answers whether anything the page draws changed. A failure to ask leaves things as they were. */
  async refreshAccounts(): Promise<boolean> {
    this.lastAttempt = this.d.now()
    try {
      return this.store.applyGrants(await this.d.grants()).changed
    } catch (error) {
      this.d.log?.(`calendar: could not ask the inbox who is connected: ${describe(error)}`)
      return false
    }
  }

  // ── Google's push ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * A notification arrived. Accepted only for a channel this store made, with the secret it chose and the resource Google named when it was made, and then it only says that changes are owed (the alarm reads them).
   * `false` for anything else, which the Worker answers as it answers every unknown path: with nothing to learn from. A `sync` message (the channel's first) is accepted and owes nothing.
   */
  receivePush(h: PushHeaders): boolean {
    const channel = this.store.channel(h.channelId)
    if (!channel) return false
    if (h.token === null || !sameSecret(channel.token, h.token)) return false
    if (h.resourceId === null || !sameSecret(channel.resourceId, h.resourceId)) return false
    this.store.recordPush(channel.id)
    if (h.state === 'sync' || channel.retire) return true
    if (channel.calendarId !== null) this.store.markCalendarDirty(channel.calendarId)
    else this.store.markListDirty(channel.account)
    return true
  }

  // ── The run ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Everything that is owed now, in order: who is connected; for each live account its list of calendars; for each shown calendar its push channel and then its events; the channels to stop. Answers whether the page
   * should be told. Never throws: each piece's failure is kept on the piece.
   */
  async run(): Promise<boolean> {
    let changed = await this.refreshAccounts()
    for (const start of this.store.accounts()) {
      if (start.state !== 'live') continue
      changed = (await this.runAccount(start.address)) || changed
    }
    changed = (await this.stopRetired()) || changed
    return changed
  }

  private async runAccount(address: string): Promise<boolean> {
    let changed = false
    const now = this.d.now()
    const account = () => this.store.account(address)
    const a = account()
    if (!a || a.state !== 'live') return false

    if (this.store.listDueAt(a) <= now) changed = (await this.syncList(a)) || changed
    if (account()?.state !== 'live') return changed

    // Channels first, so a change made between the read and the channel is not missed; then the events.
    await this.ensureChannel({ account: address, calendarId: null })
    for (const c of this.store.calendars(address)) {
      if (account()?.state !== 'live') return changed
      const fresh = this.store.calendar(c.id)
      if (!fresh?.shown) continue
      await this.ensureChannel({ account: address, calendarId: fresh.id })
      if (this.store.calendarDueAt(fresh, account()) <= this.d.now()) changed = (await this.syncCalendar(fresh)) || changed
    }
    return changed
  }

  // ── The list of calendars ─────────────────────────────────────────────────────────────────────────────────────────────

  private async syncList(a: AccountRow, again = true): Promise<boolean> {
    const api = this.d.api(a.address)
    const full = a.listToken === null
    this.store.beginListRead(a.address)
    try {
      const listed: ListedCalendar[] = []
      let last: RawList<unknown> | null = null
      let pageToken: string | null = null
      for (let pages = 0; pages < MAX_PAGES; pages++) {
        const page: RawList<unknown> = await api.listCalendars(a.listToken, pageToken)
        last = page
        for (const raw of page.items) {
          const c = listedCalendar(raw)
          if (c) listed.push(c)
        }
        pageToken = page.next
        if (pageToken === null) break
      }
      if (pageToken !== null || last === null) throw new Error('Google has more calendars than this reads')
      // A read with no token to keep would be owed again at once, for ever.
      if (last.syncToken === null) throw new Error('Google gave no sync token for the calendar list')
      return this.store.applyCalendarList(a.address, listed, { full, token: last.syncToken }).changed
    } catch (error) {
      if (error instanceof CalendarGone && again) {
        this.store.forgetListToken(a.address)
        const next = this.store.account(a.address)
        return next ? this.syncList(next, false) : false
      }
      return this.failed(a.address, null, error, 'the calendar list')
    }
  }

  // ── One calendar's events ─────────────────────────────────────────────────────────────────────────────────────────────

  private async syncCalendar(c: CalendarRow, again = true): Promise<boolean> {
    const api = this.d.api(c.account)
    const now = this.d.now()
    const full = this.store.needsFull(c, now)
    const window = windowAround(now)
    this.store.beginRead(c.id)
    try {
      const changes: (ParsedEvent | GoneEvent)[] = []
      let skipped = 0
      let last: RawList<unknown> | null = null
      let pageToken: string | null = null
      for (let pages = 0; pages < MAX_PAGES; pages++) {
        const page: RawList<unknown> = await api.listEvents(c.googleId, full ? { timeMin: window.from, timeMax: window.to, pageToken } : { syncToken: c.syncToken as string, pageToken })
        last = page
        for (const raw of page.items) {
          const parsed = parseEvent(raw, this.d.zone)
          if (parsed.kind === 'skipped') skipped++
          else changes.push(parsed)
        }
        pageToken = page.next
        if (pageToken === null) break
      }
      if (pageToken !== null || last === null) throw new Error('Google has more events than this reads')
      // A read with no token to keep would be owed again at once, for ever.
      if (last.syncToken === null) throw new Error('Google gave no sync token')
      if (skipped > 0) this.d.log?.(`calendar: ${skipped} event(s) of a calendar were not readable and left out`)
      return full ? this.store.replaceEvents(c.id, changes, last.syncToken, window).changed : this.store.applyEventChanges(c.id, changes, last.syncToken).changed
    } catch (error) {
      // The token is no longer honoured: forget it and read in full, once.
      if (error instanceof CalendarGone && !full && again) {
        this.store.forgetToken(c.id)
        const next = this.store.calendar(c.id)
        return next ? this.syncCalendar(next, false) : false
      }
      return this.failed(c.account, c, error, c.name)
    }
  }

  /** What a failed call means, and the one place that decides. Answers whether the page should be told. */
  private failed(address: string, calendar: CalendarRow | null, error: unknown, what: string): boolean {
    if (error instanceof CalendarAccessError) {
      if (error.why === 'lapsed') return this.store.markAccount(address, 'lapsed').changed
      if (error.why === 'disconnected') return this.store.markAccount(address, 'disconnected').changed
      if (error.why === 'no-calendar') return this.store.markAccount(address, 'needs-calendar').changed
    }
    if (error instanceof CalendarRefused) return this.store.markAccount(address, 'needs-calendar').changed
    if (error instanceof CalendarNotFound && calendar) {
      // Google has no such calendar any more (deleted, or no longer shared): it goes, with its events.
      this.store.removeCalendar(calendar.id)
      return true
    }
    const sentence = `${error instanceof CalendarAccessError ? 'Google would not give the calendar access just now' : `Could not read ${what}`}: ${describe(error)}`
    this.d.log?.(`calendar: ${address}: ${sentence}`)
    if (calendar) this.store.recordCalendarFailure(calendar.id, sentence)
    else this.store.recordListFailure(address, sentence)
    return true
  }

  // ── Channels ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Make sure the account's list (calendarId null) or one calendar's events has a channel with at least a day to live: none yet, or the newest is about to end, makes a new one FIRST and then marks the old one(s)
   * to be stopped, so there is no moment with none. A refusal is kept as a sentence on the target with a backoff, and the safety resync keeps reading meanwhile.
   */
  private async ensureChannel(target: { account: string; calendarId: string | null }): Promise<void> {
    if (this.d.pushUrl === null) return
    const now = this.d.now()
    const existing = this.store.channelsOf(target.account, target.calendarId)
    const newest = existing.reduce<ChannelRow | null>((best, ch) => (best === null || ch.expiresAt > best.expiresAt ? ch : best), null)
    if (newest !== null && renewAtOf(newest) > now) return
    const retryAt = target.calendarId === null ? this.store.account(target.account)?.channelRetryAt : this.store.calendar(target.calendarId)?.channelRetryAt
    if (retryAt !== null && retryAt !== undefined && retryAt > now) return
    const api = this.d.api(target.account)
    const request = { id: this.d.newId(), token: this.d.newToken(), address: this.d.pushUrl }
    try {
      const calendar = target.calendarId === null ? null : this.store.calendar(target.calendarId)
      if (target.calendarId !== null && !calendar) return
      const made = calendar ? await api.watchEvents(calendar.googleId, request) : await api.watchCalendarList(request)
      this.store.addChannel({ id: request.id, account: target.account, calendarId: target.calendarId, resourceId: made.resourceId, token: request.token, expiresAt: made.expiration })
      // What Google actually granted (the pages state a 7 day default and no maximum): the hand test reads it here (`wrangler tail space`). Neither the channel's secret nor its resource is in the line.
      this.d.log?.(`calendar: a push channel for ${target.account} (${target.calendarId === null ? 'its calendar list' : 'one calendar'}) lasts until ${new Date(made.expiration).toISOString()}`)
      for (const old of existing) this.store.retireChannel(old.id)
    } catch (error) {
      if (error instanceof CalendarAccessError || error instanceof CalendarRefused) {
        this.failed(target.account, null, error, 'a push channel')
        return
      }
      this.d.log?.(`calendar: ${target.account}: no push channel: ${describe(error)}`)
      this.store.recordChannelFailure(target, describe(error))
    }
  }

  /** Stop at Google every channel marked to be stopped, once, and forget it. A channel that cannot be stopped (no token to do it with) expires on its own within a week and is forgotten all the same. */
  private async stopRetired(): Promise<boolean> {
    for (const ch of this.store.channels()) {
      if (!ch.retire) continue
      try {
        await this.d.api(ch.account).stopChannel(ch.id, ch.resourceId)
      } catch (error) {
        this.d.log?.(`calendar: a push channel could not be stopped (it will end by itself): ${describe(error)}`)
      }
      this.store.removeChannel(ch.id)
    }
    return false
  }

  // ── What is owed next ─────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * When the alarm should next ring: the soonest of every read that is owed, every channel that is owed or is about to end, a channel to stop and the next look at who is connected. Never in the past of `now`.
   */
  nextWake(): number {
    const now = this.d.now()
    const times: number[] = []
    const accounts = this.store.accounts()
    // The next look at who is connected is timed from the last ATTEMPT, a failed one included: timed from an account's last success it would be in the past for as long as the inbox could not be reached, and the alarm
    // would ring every second for that whole time.
    times.push(this.lastAttempt === null ? 0 : this.lastAttempt + ACCOUNTS_CHECK_MS)
    for (const a of accounts) {
      times.push(this.store.listDueAt(a))
      if (a.state === 'live' && this.d.pushUrl !== null) times.push(this.channelDueAt(a.address, null, a.channelRetryAt))
    }
    const byAccount = new Map(accounts.map((a) => [a.address, a]))
    for (const c of this.store.calendars()) {
      const a = byAccount.get(c.account) ?? null
      times.push(this.store.calendarDueAt(c, a))
      if (c.shown && a?.state === 'live' && this.d.pushUrl !== null) times.push(this.channelDueAt(c.account, c.id, c.channelRetryAt))
    }
    if (this.store.channels().some((ch) => ch.retire)) times.push(0)
    const soonest = Math.min(...times.filter((t) => Number.isFinite(t)))
    return Number.isFinite(soonest) ? Math.max(now, soonest) : now + ACCOUNTS_CHECK_MS
  }

  /** When a target's channel is next owed: the retry time after a refusal, now when it has none, or when the newest one is within a day of ending. */
  private channelDueAt(account: string, calendarId: string | null, retryAt: number | null): number {
    const now = this.d.now()
    const existing = this.store.channelsOf(account, calendarId)
    const newest = existing.reduce<ChannelRow | null>((best, ch) => (best === null || ch.expiresAt > best.expiresAt ? ch : best), null)
    const due = newest === null ? 0 : renewAtOf(newest)
    return retryAt !== null && retryAt > now ? Math.max(due, retryAt) : due
  }
}
