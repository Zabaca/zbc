/**
 * Booking links, as the engine does them (the space's ADR 0025): the owner makes a link; a visitor with no sign-in picks a free time on its page; the calendar takes the time, asks Google whether the owner is still free, makes the event with a Meet link
 * on the link's account and has Google send the invitation. No runtime import, so `bun test` drives it over a real SQLite and a fake Google.
 *
 * ── A STANDING WRITE THE OWNER'S LINK IS THE WORD FOR ────────────────────
 * This is the third thing in the calendar that writes an event to Google, after Claude's three (src/writes.ts, under the send rule) and the owner's busy blocks (src/blocks.ts, under the owner's switch). A booking makes, moves and deletes exactly one event,
 * the one a visitor asked for: of the link's length and name, on the link's account, with one guest who asked for it, inside the link's rules, and Google sends that guest the invitation. A link the owner made and left on is the owner's word for exactly this.
 * Nothing else is opened by it: the face the visitor is handed (`CalendarForGuests`) has these seven methods and no others, and nothing in this file can be asked to write anything but a booking.
 *
 * ── WHO IS ASKING ────────────────────────────────────────────────────────
 * Nobody the space knows. What lets a visitor do anything is the link's address (public) or a booking's own SECRET: long and random, shown once, kept only as a hash, and the only thing that moves or cancels a booking from outside. The write token is asked for
 * with each call (the writer's own rule, src/google.ts) and never kept.
 *
 * ── THE TIME IS TAKEN BEFORE GOOGLE IS ASKED ─────────────────────────────
 * The object takes one request at a time between awaits, so a row written in the same turn as the check that the time is free cannot be written twice for one time: that is the hold. The check with Google comes after it (`freeBusy`, for every live account's shown
 * calendars, for the time and the gap), and a time Google says is taken, or an insert Google refuses, lets the hold go. An insert whose outcome nobody knows keeps the hold: the event's id is DERIVED from the booking's id, so the next read of the calendar finds it
 * (and a booking whose event never appears within an hour lets the time go), and it is never made twice. A move holds the time it asks for the same way.
 *
 * ── WHAT IS FREE ─────────────────────────────────────────────────────────
 * The same busy rule as the free time Claude reads (not free time, not declined; blocks are not events), over every connected account's shown calendars, from the calendar's own copy (`CalendarStore.agenda`), plus the times other bookings hold. An account Google cannot be
 * asked about at the moment of booking (its sign-in ended, Google did not answer) is checked against the copy, as old as its last read, and the booking says so (`checked`).
 */

import {
  BOOKING_CALL_CLOSES_AFTER_MS,
  BOOKING_CALL_OPENS_BEFORE_MS,
  BOOKING_DEFAULTS,
  BOOKING_LIMITS,
  BOOKING_RESERVED_SLUGS,
  BOOKING_WEEKDAYS,
  BOOKING_WHERES,
  type BookingCalls,
  type BookingHours,
  type BookingLinkView,
  type BookingRecord,
  type BookingRules,
  type BookingSpan,
  bookingManagePath,
  type CalendarBookingLinks,
  type GuestBooked,
  type GuestBookingInput,
  type GuestBookingLink,
  type GuestBookingSlots,
  type GuestBookingView,
  isoAt,
  normalizeAddress,
  type RefusalReason,
} from '@space/workspace'
import { type Busy, slotStarts } from './booking-slots'
import type { LinkRow, LinkWrite, BookingRow } from './booking-store'
import type { Result } from './engine'
import { cleanText, parseEvent } from './event-parse'
import { CalendarAccessError, CalendarError, CalendarGone, type CalendarApi, CalendarNotFound, CalendarRefused, type CalendarWriteApi } from './google'
import { type AccountRow, type CalendarRow, type CalendarStore, eventKey } from './store'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** How long a time is held for a booking Google has not answered (or a move it has not answered), and how long a booking's event is waited for before the time is let go. */
export const BOOKING_HOLD_MS = HOUR
/** How often the alarm looks again for the event of a booking that is waiting on Google. */
export const BOOKING_LOOK_MS = MIN
/** How long the record of a past booking stays in a link's list. */
export const BOOKING_RECENT_MS = 30 * DAY
/** The most bookings a link's list shows. */
export const BOOKING_LIST_MAX = 40

const EM_DASH = '\u2014'

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const no = (reason: RefusalReason, error: string): Result<never> => ({ ok: false, reason, error })

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max

/** What a visitor is told when a link cannot be booked, whatever the reason (the owner's Settings says why). */
export const CLOSED_WORDS = 'This link cannot be booked right now. Please try again later, or ask the person who sent it.'
/**
 * What a visitor is told when a booking is refused for who they are or how much they have used the link (the owner's own address, one address invited too often or holding too many meetings, one network or one link over its day): ONE sentence and one reason for
 * all of them, so a stranger cannot tell by the words which it was, nor learn whether an address has booked here.
 */
export const NOT_NOW_WORDS = 'That could not be booked just now. Please try again later.'
/** What a visitor is told when the time they picked has gone. */
export const TAKEN_WORDS = 'That time is no longer free. Please pick another one.'
/** What a visitor is told when Google did not answer a request that may or may not have been done. */
export const UNSURE_WORDS = 'The calendar could not tell whether that was done. Look for the invitation in your email before trying again: it may have been done.'

// ── Reading what the owner sets ─────────────────────────────────────────────────────────────────────────────────────────

/** A slug: lower case letters, digits and single hyphens, not at either end, of a length, and not one of the open path's own folders. */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

function readHours(raw: unknown): Result<BookingHours> {
  if (!isRecord(raw)) return no('bad-request', 'hours is an object with a list of spans for each weekday (mon to sun).')
  const extra = Object.keys(raw).filter((k) => !(BOOKING_WEEKDAYS as readonly string[]).includes(k))
  if (extra.length > 0) return no('bad-request', `hours has the weekdays ${BOOKING_WEEKDAYS.join(', ')}, never ${extra.join(', ')}.`)
  const hours = {} as BookingHours
  let any = false
  for (const day of BOOKING_WEEKDAYS) {
    const list = raw[day] ?? []
    if (!Array.isArray(list)) return no('bad-request', `The hours of ${day} are a list of spans, empty for a day with none.`)
    if (list.length > BOOKING_LIMITS.spansPerDayMax) return no('bad-request', `A day has at most ${BOOKING_LIMITS.spansPerDayMax} spans of hours.`)
    const spans: BookingSpan[] = []
    for (const s of list) {
      if (!isRecord(s) || !whole(s.from, 0, 1440) || !whole(s.to, 0, 1440) || s.to <= s.from) return no('bad-request', `A span of hours on ${day} runs from one time to a later one (minutes after midnight, 0 to 1440).`)
      spans.push({ from: s.from, to: s.to })
    }
    spans.sort((a, b) => a.from - b.from)
    for (let i = 1; i < spans.length; i++) if ((spans[i] as BookingSpan).from < (spans[i - 1] as BookingSpan).to) return no('bad-request', `Two spans of hours on ${day} overlap.`)
    if (spans.length > 0) any = true
    hours[day] = spans
  }
  if (!any) return no('bad-request', 'Give at least one weekday some hours, or the link has no time to offer.')
  return ok(hours)
}

/** What the owner sets, checked: the link as it will be stored, or the sentence that refuses it. Unknown fields are refused, so a misspelt rule is not a link with a default. */
export function readBookingLink(raw: unknown): Result<LinkWrite> {
  if (!isRecord(raw)) return no('bad-request', 'A link is an object: slug, name, description, account, minutes, hours, noticeMinutes, aheadDays, gapMinutes, perDay, enabled and where.')
  const known = ['slug', 'name', 'description', 'account', 'minutes', 'hours', 'noticeMinutes', 'aheadDays', 'gapMinutes', 'perDay', 'enabled', 'where']
  const extra = Object.keys(raw).filter((k) => !known.includes(k))
  if (extra.length > 0) return no('bad-request', `A link carries ${known.join(', ')} only, never ${extra.join(', ')}.`)
  const slug = typeof raw.slug === 'string' ? raw.slug.trim().toLowerCase() : ''
  if (slug.length < BOOKING_LIMITS.slugMin || slug.length > BOOKING_LIMITS.slugMax || !SLUG.test(slug)) {
    return no('bad-request', `The address is ${BOOKING_LIMITS.slugMin} to ${BOOKING_LIMITS.slugMax} lower case letters, digits and hyphens, with no hyphen at either end or two together.`)
  }
  if ((BOOKING_RESERVED_SLUGS as readonly string[]).includes(slug)) return no('bad-request', `${slug} cannot be an address: it is one of the booking page's own folders.`)
  const name = typeof raw.name === 'string' ? cleanText(raw.name, BOOKING_LIMITS.nameMax + 1) : ''
  if (name === '' || name.length > BOOKING_LIMITS.nameMax) return no('bad-request', `The name is what the visitor reads, at most ${BOOKING_LIMITS.nameMax} characters.`)
  const description = raw.description === undefined || raw.description === null ? '' : typeof raw.description === 'string' ? cleanText(raw.description, BOOKING_LIMITS.descriptionMax + 1, true) : null
  if (description === null || description.length > BOOKING_LIMITS.descriptionMax) return no('bad-request', `The description is text of at most ${BOOKING_LIMITS.descriptionMax} characters.`)
  if (name.includes(EM_DASH) || description.includes(EM_DASH)) return no('bad-request', 'Remove the em dash from the name and the description: they go out in the owner’s name.')
  const account = normalizeAddress(raw.account)
  if (account === null) return no('bad-request', 'account is the address of a connected Google account.')
  if (!whole(raw.minutes, BOOKING_LIMITS.minutesMin, BOOKING_LIMITS.minutesMax)) return no('bad-request', `A meeting is ${BOOKING_LIMITS.minutesMin} to ${BOOKING_LIMITS.minutesMax} minutes long.`)
  const hours = readHours(raw.hours)
  if (!hours.ok) return hours
  if (!whole(raw.noticeMinutes, 0, BOOKING_LIMITS.noticeMaxMinutes)) return no('bad-request', 'The least notice is from 0 minutes to 30 days.')
  if (!whole(raw.aheadDays, 1, BOOKING_LIMITS.aheadMaxDays)) return no('bad-request', `How far ahead is 1 to ${BOOKING_LIMITS.aheadMaxDays} days.`)
  if (!whole(raw.gapMinutes, 0, BOOKING_LIMITS.gapMaxMinutes)) return no('bad-request', `The gap around other meetings is 0 to ${BOOKING_LIMITS.gapMaxMinutes} minutes.`)
  if (raw.perDay !== null && raw.perDay !== undefined && !whole(raw.perDay, 1, BOOKING_LIMITS.perDayMax)) return no('bad-request', `The most in a day is 1 to ${BOOKING_LIMITS.perDayMax}, or no limit.`)
  if (typeof raw.enabled !== 'boolean') return no('bad-request', 'Say whether the link is on.')
  // Where its meetings are held: Google Meet when it is left out (every link made before this was asked), or a call in the space.
  const where = raw.where === undefined ? 'meet' : (BOOKING_WHERES as readonly unknown[]).includes(raw.where) ? (raw.where as 'meet' | 'space') : null
  if (where === null) return no('bad-request', 'Where is Google Meet or a call in the space.')
  return ok({
    slug,
    name,
    description,
    account,
    minutes: raw.minutes,
    hours: hours.value,
    noticeMinutes: raw.noticeMinutes,
    aheadDays: raw.aheadDays,
    gapMinutes: raw.gapMinutes,
    perDay: raw.perDay === undefined ? null : (raw.perDay as number | null),
    enabled: raw.enabled,
    where,
  })
}

/** What a visitor's words become: cut short, control characters out, an em dash made a hyphen (the text lands in the owner's calendar and in an invitation sent in their name). */
const visitorText = (v: unknown, max: number, keepBreaks = false): string => cleanText(v, max, keepBreaks).replaceAll(EM_DASH, '-')

/** What a visitor gives, checked: the booking's words, or the sentence that refuses it. */
export function readGuestBooking(raw: unknown): Result<GuestBookingInput> {
  if (!isRecord(raw)) return no('bad-request', 'Give a start, a name, an email and, if you like, a note.')
  const known = ['start', 'name', 'email', 'note']
  const extra = Object.keys(raw).filter((k) => !known.includes(k))
  if (extra.length > 0) return no('bad-request', 'That is not something this page takes.')
  if (!whole(raw.start, 1, Number.MAX_SAFE_INTEGER)) return no('bad-request', 'Pick one of the times offered.')
  const name = visitorText(raw.name, BOOKING_LIMITS.visitorNameMax).replace(/\s+/g, ' ')
  if (name === '') return no('bad-request', 'Please give your name.')
  // A name is a name: an address in it is a link in an invitation sent in the owner's name.
  if (/https?:\/\/|www\./i.test(name)) return no('bad-request', 'Please give your name, not an address.')
  const email = normalizeAddress(raw.email)
  if (email === null) return no('bad-request', 'Please give an email address the invitation can be sent to.')
  const note = raw.note === undefined || raw.note === null ? '' : typeof raw.note === 'string' ? visitorText(raw.note, BOOKING_LIMITS.visitorNoteMax, true) : null
  if (note === null) return no('bad-request', 'The note is text.')
  return ok({ start: raw.start, name, email, note })
}

// ── What a limit counts ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** An address in the form the per-address limits count it: lower case, no `+tag`, and no dots (nor the other domain's name) for Gmail's own domains, so one inbox written several ways is one key. The invitation still goes to the address as typed. */
export function canonicalAddress(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 0) return email.toLowerCase()
  let local = email.slice(0, at).toLowerCase()
  let domain = email.slice(at + 1).toLowerCase()
  const plus = local.indexOf('+')
  if (plus > 0) local = local.slice(0, plus)
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    domain = 'gmail.com'
    local = local.replaceAll('.', '')
  }
  return `${local}@${domain}`
}

/** A network address in the form the per-network limit counts it: an IPv4 address as it is, an IPv6 address by its /64 (the part one subscriber's line holds all of), so rotating through the addresses of one line is one key. */
export function networkKeyOf(address: string): string {
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address)
  if (address.includes(':') && v4 && /^(::ffff:|::)/i.test(address)) return v4[1] as string
  if (!address.includes(':')) return address
  const [head = '', tail = ''] = address.toLowerCase().split('::')
  const left = head === '' ? [] : head.split(':')
  const right = tail === '' || address.indexOf('::') < 0 ? [] : tail.split(':')
  const groups = address.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left
  return `v6:${groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':')}`
}

// ── Names ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

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

const sha256 = async (text: string): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

/** The Google event id of a booking: 32 letters, a to v and 0 to 9, the same for the same install and booking for ever, so an insert whose outcome was lost is found again and never made twice. */
export async function bookingEventId(installId: string, bookingId: string): Promise<string> {
  return base32hex((await sha256(`booking\n${installId}\n${bookingId}`)).slice(0, 20))
}

/** What a booking's secret is kept as: its SHA-256, in hex. The secret itself is kept nowhere. */
export const secretHash = async (secret: string): Promise<string> => hex(await sha256(`booking-secret\n${secret}`))

/** What the owner's notification says of a booking: `Booked: Ada Quill, Fri, Nov 6, 10:00 AM PST` over the link's name. The time is on the company's clock. */
export function bookingNote(b: { name: string; start: number; linkName: string }, zone: string): { title: string; body: string } {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' }).format(b.start)
  const time = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(b.start)
  return { title: `Booked: ${b.name}, ${day}, ${time}`, body: b.linkName }
}

// ── The engine's part ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface BookingDeps {
  store: CalendarStore
  /** Google's reading client, for the check at the moment of booking (`freeBusy`). */
  api: (address: string) => CalendarApi
  /** Google's writing client for one account: its token for `calendar.events` is asked for each call and dropped (src/google.ts). Absent where nothing is wired to write: no link can be booked. */
  writer?: ((address: string) => CalendarWriteApi) | undefined
  now: () => number
  /** The company's time zone: the hours of a link are on its clock and an event is made in it. */
  zone: string
  /** The install's declared company id, which a booking's event id is derived with. */
  installId: string
  /** The company's name, as a visitor reads it. */
  company: string
  /** `https://<space host>`: what a link's address and a booking's own address are made from. */
  origin: string
  newId: () => string
  /** A new random secret, long enough to be a credential (24 random bytes as hex). */
  newToken: () => string
  tell: () => void
  alarmAt: (at: number) => void | Promise<void>
  /** A way to make, move and close a call in the space's own Meet, for a link set to hold its meetings there (the space's ADR 0026). Absent where nothing is wired: such a link cannot be booked, and "Where" is not offered. */
  calls?: BookingCalls | undefined
  /** Tell the owner a booking was made, in their own notifications. Best effort: a booking is made whether or not anyone could be told. */
  notify?: ((booking: { id: string; name: string; start: number; end: number; linkName: string }) => Promise<void>) | undefined
  log?: ((line: string) => void) | undefined
}

/** What an account needs to hold a booking: or why it cannot, in the owner's words. */
type Holder = { account: AccountRow; calendar: CalendarRow } | { problem: string }

/** How long what the call allowance said is believed: a public page asks it for every visitor, and it is one read of Meet's ledger. */
const METER_FRESH_MS = 30_000

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300)

export class CalendarBookings {
  constructor(private readonly d: BookingDeps) {}

  private get store(): CalendarStore {
    return this.d.store
  }

  private get rows() {
    return this.d.store.bookings
  }

  // ── Whether a link can be booked ──────────────────────────────────────────────────────────────────────────────────────

  /** The account's main calendar, if a booking can be made on it now; or why not, in the owner's words. */
  private holder(address: string): Holder {
    const account = this.store.account(address)
    if (!account) return { problem: `${address} is not a connected Google account.` }
    if (!this.d.writer) return { problem: 'This install cannot change calendar events from here.' }
    if (account.state === 'lapsed') return { problem: `The sign-in of ${address} ended, so nothing can be booked on it until it is connected again.` }
    if (account.state === 'disconnected') return { problem: `${address} is not connected, so nothing can be booked on it.` }
    if (account.state === 'needs-calendar') return { problem: `${address} is connected for mail without the calendar permission, so nothing can be booked on it. Press Connect calendar and accept it.` }
    if (!account.events) return { problem: `${address} was connected for reading only, so nothing can be booked on it. Press Connect calendar and accept the permission to change events.` }
    const main = this.store.calendars(address).find((c) => c.primary)
    if (!main || !main.shown) return { problem: `The main calendar of ${address} is hidden, so nothing can be booked on it. Show it above.` }
    if (main.syncToken === null) return { problem: `The main calendar of ${address} is still being read in, so nothing can be booked on it yet.` }
    return { account, calendar: main }
  }

  /** The sentence for why a link cannot be booked, or null when it can: its account, and for a link held in the space's call, that calls are switched on. */
  private problemOf(link: LinkRow): string | null {
    const held = this.holder(link.account)
    if ('problem' in held) return held.problem
    if (link.where === 'space' && this.d.calls?.on !== true) return 'Calls are not turned on in this space, so a meeting cannot be held in a call. Choose Google Meet for this link, or turn calls on.'
    return null
  }

  /** What the call allowance says, asked of Meet at most every half minute: why no call can be made now (the month's allowance is used up), or null. Only a link held in the space's call asks it. */
  private meter: { at: number; why: string | null } | null = null
  private async meterWhy(): Promise<string | null> {
    const calls = this.d.calls
    if (calls === undefined) return null
    const now = this.d.now()
    if (this.meter !== null && now - this.meter.at < METER_FRESH_MS) return this.meter.why
    let why: string | null
    try {
      const c = await calls.check()
      why = c.ok ? null : c.why
    } catch (error) {
      // Meet did not answer: no call can be made now, and the owner is told no more than that.
      this.d.log?.(`calendar: whether a call can be made could not be asked: ${describe(error)}`)
      why = 'The space\'s calls did not answer just now.'
    }
    this.meter = { at: now, why }
    return why
  }

  /** `problemOf`, and for a link held in the space's call whether the month's allowance lets a call be made. */
  private async problemNow(link: LinkRow): Promise<string | null> {
    const fixed = this.problemOf(link)
    if (fixed !== null || link.where !== 'space') return fixed
    return this.meterWhy()
  }

  // ── The owner's side ──────────────────────────────────────────────────────────────────────────────────────────────────

  private recordOf(b: BookingRow): BookingRecord {
    const event = b.state === 'booked' ? this.store.eventOf(b.calendarId, b.eventId) : null
    const calendar = this.store.calendar(b.calendarId)
    // Booked and no longer in the calendar's copy, which has been read since: the owner removed it there.
    const removed = b.state === 'booked' && event === null && calendar !== null && calendar.syncedAt !== null && b.bookedAt !== null && calendar.syncedAt > b.bookedAt
    return {
      id: b.id,
      where: b.where,
      linkName: b.linkName,
      name: b.visitorName,
      email: b.visitorEmail,
      note: b.note,
      start: event?.start ?? b.start,
      end: event?.end ?? b.end,
      bookedAt: b.bookedAt ?? b.createdAt,
      state: removed ? 'removed' : b.state === 'held' ? 'pending' : b.state === 'cancelled' ? 'cancelled' : 'booked',
      checked: b.checked,
      link: event?.htmlLink ?? null,
    }
  }

  private viewOf(link: LinkRow, problem: string | null): BookingLinkView {
    const now = this.d.now()
    const account = this.store.account(link.account)
    return {
      id: link.id,
      slug: link.slug,
      name: link.name,
      description: link.description,
      account: link.account,
      accountLabel: account?.label ?? link.account,
      minutes: link.minutes,
      hours: link.hours,
      noticeMinutes: link.noticeMinutes,
      aheadDays: link.aheadDays,
      gapMinutes: link.gapMinutes,
      perDay: link.perDay,
      enabled: link.enabled,
      where: link.where,
      url: `${this.d.origin}/book/${link.slug}`,
      problem,
      bookings: this.rows.recentOf(link.id, now, now - BOOKING_RECENT_MS, BOOKING_LIST_MAX).map((b) => this.recordOf(b)),
    }
  }

  async links(): Promise<Result<CalendarBookingLinks>> {
    const links: BookingLinkView[] = []
    for (const l of this.rows.links()) links.push(this.viewOf(l, await this.problemNow(l)))
    return ok({
      links,
      accounts: this.store.accounts().map((a) => {
        const held = this.holder(a.address)
        return { address: a.address, label: a.label, canBook: !('problem' in held), why: 'problem' in held ? held.problem : null }
      }),
      defaults: BOOKING_DEFAULTS,
      zone: this.d.zone,
      origin: this.d.origin,
      calls: this.d.calls?.on === true,
    })
  }

  /** A link's fields checked against what the store knows: the account is one of the owner's, and the address is free. */
  private checked(input: unknown, except: string | null): Result<LinkWrite> {
    const read = readBookingLink(input)
    if (!read.ok) return read
    const w = read.value
    if (!this.store.account(w.account)) return no('bad-request', `${w.account} is not a connected Google account.`)
    // A call in the space is offered only where calls are on; a link already set to it may be saved as it is (its problem is said in Settings), but not newly set to it.
    if (w.where === 'space' && this.d.calls?.on !== true && (except === null || this.rows.link(except)?.where !== 'space')) return no('bad-request', 'Calls are not turned on in this space, so a link cannot hold its meetings in a call.')
    const taken = this.rows.linkBySlug(w.slug)
    if (taken && taken.id !== except) return no('conflict', `The address ${w.slug} is used by another link. Pick another.`)
    return ok(w)
  }

  async makeLink(input: unknown): Promise<Result<BookingLinkView>> {
    const read = this.checked(input, null)
    if (!read.ok) return read
    if (this.rows.links().length >= BOOKING_LIMITS.linksMax) return no('limit', `A space holds at most ${BOOKING_LIMITS.linksMax} booking links. Delete one first.`)
    const id = this.d.newId()
    this.rows.addLink(id, read.value)
    this.d.tell()
    const made = this.rows.link(id) as LinkRow
    return ok(this.viewOf(made, await this.problemNow(made)))
  }

  async changeLink(id: unknown, input: unknown): Promise<Result<BookingLinkView>> {
    if (typeof id !== 'string' || !this.rows.link(id)) return no('not-found', 'No such link.')
    const read = this.checked(input, id)
    if (!read.ok) return read
    this.rows.changeLink(id, read.value)
    this.d.tell()
    const changed = this.rows.link(id) as LinkRow
    return ok(this.viewOf(changed, await this.problemNow(changed)))
  }

  deleteLink(id: unknown): Result<{ id: string }> {
    if (typeof id !== 'string' || !this.rows.deleteLink(id)) return no('not-found', 'No such link.')
    this.d.tell()
    return ok({ id })
  }

  // ── What is free ──────────────────────────────────────────────────────────────────────────────────────────────────────

  private rulesOf(link: LinkRow): BookingRules {
    return { hours: link.hours, noticeMinutes: link.noticeMinutes, aheadDays: link.aheadDays, gapMinutes: link.gapMinutes, perDay: link.perDay }
  }

  /** The starting times the link offers from now. `except` is a booking that asks to move: its own time is free to itself. */
  private slotsFor(link: LinkRow, except?: BookingRow): number[] {
    const now = this.d.now()
    const gap = link.gapMinutes * MIN
    const earliest = now + link.noticeMinutes * MIN
    const latest = now + link.aheadDays * DAY
    const own = except === undefined ? null : eventKey(except.calendarId, except.eventId)
    // The calendar's own copy of every connected account, the same busy rule as the free time Claude reads: a block is never in it, and the same meeting on two accounts is one event.
    const busy: Busy[] = this.store
      .agenda(earliest - gap - 1, latest + link.minutes * MIN + gap + 1)
      .events.filter((e) => !e.free && e.response !== 'declined' && e.id !== own)
      .map((e) => ({ start: e.start, end: e.end }))
    for (const h of this.rows.holds(now, BOOKING_HOLD_MS, except?.id)) busy.push({ start: h.start, end: h.end })
    return slotStarts({ rules: this.rulesOf(link), minutes: link.minutes, now, zone: this.d.zone, busy, taken: this.rows.activeStarts(link.id, now - 2 * DAY, latest + 2 * DAY, except?.id) })
  }

  /** Whether Google says the owner is busy for a time, on every live account's shown calendars; and whether the copy had to stand in for any account. Never throws: an account Google cannot be asked about is checked from the copy, which the slots already were. */
  private async askGoogle(start: number, end: number, gapMs: number, own: { start: number; end: number } | null): Promise<{ busy: boolean; checked: 'google' | 'copy' }> {
    const from = start - gapMs
    const to = end + gapMs
    let checked: 'google' | 'copy' = 'google'
    const asked = await Promise.all(
      this.store
        .accounts()
        // An account with no picture (disconnected, no calendar permission) has nothing in the copy either; a lapsed one has its last picture and cannot be asked.
        .filter((a) => a.state === 'live' || a.state === 'lapsed')
        .map(async (a): Promise<boolean> => {
          if (a.state === 'lapsed') {
            checked = 'copy'
            return false
          }
          const ids = this.store.calendars(a.address).filter((c) => c.shown).map((c) => c.googleId)
          if (ids.length === 0) return false
          try {
            const got = await this.d.api(a.address).freeBusy(ids, from, to)
            let busy = false
            for (const id of ids) {
              const list = got[id]
              if (list === null || list === undefined) {
                checked = 'copy'
                continue
              }
              // The booking's own event (a move) is busy for itself: it is the stretch exactly its own time.
              if (list.some((b) => b.start < to && b.end > from && !(own !== null && b.start === own.start && b.end === own.end))) busy = true
            }
            return busy
          } catch (error) {
            this.d.log?.(`calendar: Google could not be asked for the free time of ${a.address}: ${describe(error)}`)
            checked = 'copy'
            return false
          }
        }),
    )
    return { busy: asked.some(Boolean), checked }
  }

  // ── A visitor's view ──────────────────────────────────────────────────────────────────────────────────────────────────

  private open(link: LinkRow): boolean {
    return link.enabled && this.problemOf(link) === null
  }

  /** `open`, and for a link held in the space's call whether a call can be made now (the month's allowance): what decides whether a NEW booking may be taken. A booking already made does not ask it. */
  private async openNow(link: LinkRow): Promise<boolean> {
    return this.open(link) && (link.where !== 'space' || (await this.meterWhy()) === null)
  }

  async guestLink(slug: unknown): Promise<Result<GuestBookingLink>> {
    const link = typeof slug === 'string' ? this.rows.linkBySlug(slug) : null
    if (!link) return no('not-found', 'There is no such booking link.')
    return ok({ company: this.d.company, name: link.name, description: link.description, minutes: link.minutes, zone: this.d.zone, open: await this.openNow(link), where: link.where })
  }

  async guestSlots(slug: unknown): Promise<Result<GuestBookingSlots>> {
    const link = typeof slug === 'string' ? this.rows.linkBySlug(slug) : null
    if (!link) return no('not-found', 'There is no such booking link.')
    if (!(await this.openNow(link))) return no('conflict', CLOSED_WORDS)
    const now = this.d.now()
    return ok({ from: now, to: now + link.aheadDays * DAY, starts: this.slotsFor(link) })
  }

  private viewFor(b: BookingRow): GuestBookingView {
    const now = this.d.now()
    const link = this.rows.link(b.linkId)
    const event = b.state === 'booked' ? this.store.eventOf(b.calendarId, b.eventId) : null
    const calendar = this.store.calendar(b.calendarId)
    const start = event?.start ?? b.start
    const end = event?.end ?? b.end
    const removed = b.state === 'booked' && event === null && calendar !== null && calendar.syncedAt !== null && b.bookedAt !== null && calendar.syncedAt > b.bookedAt
    const state: GuestBookingView['state'] = b.state === 'cancelled' ? 'cancelled' : removed ? 'removed' : b.state === 'held' ? 'pending' : end <= now ? 'past' : 'booked'
    const linkOpen = link !== null && this.open(link)
    return {
      company: this.d.company,
      title: b.linkName,
      slug: link?.slug ?? null,
      minutes: b.minutes,
      start,
      end,
      name: b.visitorName,
      email: b.visitorEmail,
      state,
      zone: this.d.zone,
      where: b.where,
      // Where it is held: Google's Meet link, or the call made for the booking (which is gone when the booking is).
      meetLink: b.where === 'space' ? (state === 'cancelled' ? null : b.callLink) : (event?.videoLink ?? null),
      canMove: state === 'booked' && start > now && b.moves < BOOKING_LIMITS.moves && linkOpen,
      canCancel: state === 'booked' && end > now,
      linkOpen,
    }
  }

  private async byHash(secret: unknown): Promise<BookingRow | null> {
    if (typeof secret !== 'string' || secret.length < 8 || secret.length > 200) return null
    return this.rows.bookingByHash(await secretHash(secret))
  }

  async guestBooking(secret: unknown): Promise<Result<GuestBookingView>> {
    const b = await this.byHash(secret)
    return b ? ok(this.viewFor(b)) : no('not-found', 'There is no such booking.')
  }

  async guestBookingSlots(secret: unknown): Promise<Result<GuestBookingSlots>> {
    const b = await this.byHash(secret)
    if (!b) return no('not-found', 'There is no such booking.')
    const view = this.viewFor(b)
    const link = this.rows.link(b.linkId)
    if (!view.canMove || !link) return no('conflict', 'This booking cannot be moved.')
    const now = this.d.now()
    return ok({ from: now, to: now + link.aheadDays * DAY, starts: this.slotsFor(link, b) })
  }

  // ── Booking ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The limits that keep a link from being used to send invitations to people who did not ask. A sentence for the first one reached, or null. */
  private overLimit(link: LinkRow, key: string, network: string): boolean {
    const now = this.d.now()
    const since = now - DAY
    return (
      this.rows.madeByVisitor(key, since) >= BOOKING_LIMITS.perVisitor ||
      this.rows.upcomingOfVisitor(key, now) >= BOOKING_LIMITS.upcomingPerVisitor ||
      this.rows.madeFromNetwork(network, since) >= BOOKING_LIMITS.perNetwork ||
      this.rows.madeOnLink(link.id, since) >= BOOKING_LIMITS.perLink
    )
  }

  /**
   * The description of the event: what the link is and the address only that visitor has. NEVER the visitor's note: the invitation goes in the owner's name to an address the visitor typed, and a note could carry a link or a claim into it. The owner reads the note in
   * Settings, Calendars (the booking's record), not in the event.
   */
  private descriptionOf(link: LinkRow, secret: string, callLink: string | null): string {
    const manage = `To move or cancel this meeting, use this address: ${this.d.origin}${bookingManagePath(secret)}`
    // A call in the space is joined from a browser with no account: the description says so, and where.
    return callLink === null ? `Booked through "${link.name}". ${manage}` : `Booked through "${link.name}". Join the video call in your browser, no account needed: ${callLink}\n${manage}`
  }

  /** The window a call is open for, from the booked time: from 30 minutes before the start until 2 hours after the end. */
  private windowOf(start: number, end: number): { startsAt: number; opensAt: number; closesAt: number } {
    return { startsAt: start, opensAt: start - BOOKING_CALL_OPENS_BEFORE_MS, closesAt: end + BOOKING_CALL_CLOSES_AFTER_MS }
  }

  /** A booking's call is closed (its link says there is no such call), now or, when Meet does not answer, by the alarm. Answers whether it is closed. */
  private async closeCall(b: BookingRow): Promise<boolean> {
    if (b.callName === null) return true
    if (b.callClosed) return true
    const calls = this.d.calls
    if (calls === undefined) return false
    try {
      const done = await calls.close(b.callName)
      if (!done.ok) this.d.log?.(`calendar: the call of a booking would not close: ${done.why}`)
      // A refusal ("there is no such call") leaves nothing open to close: it is not tried again.
      this.rows.markCallClosed(b.id)
      return true
    } catch (error) {
      this.d.log?.(`calendar: the call of a booking could not be closed, it will be tried again: ${describe(error)}`)
      return false
    }
  }

  /** A booking moved: its call's window follows. When Meet does not answer, the call keeps the old time and the alarm tries again (the start the window was set for is what says it is behind). */
  private async followCall(b: BookingRow): Promise<boolean> {
    if (b.callName === null || b.callClosed || b.callStart === b.start) return true
    const calls = this.d.calls
    if (calls === undefined) return false
    try {
      const done = await calls.move(b.callName, this.windowOf(b.start, b.end))
      if (!done.ok) this.d.log?.(`calendar: the call of a moved booking would not move: ${done.why}`)
      // A refusal leaves nothing to move (the call is gone): not tried again.
      this.rows.setCallStart(b.id, b.start)
      return true
    } catch (error) {
      this.d.log?.(`calendar: the call of a moved booking could not be moved, it will be tried again: ${describe(error)}`)
      return false
    }
  }

  /** The calls waiting on Meet: those of cancelled bookings (to close) and of moved ones (to follow). */
  private callsBehind(): BookingRow[] {
    return this.rows.openCalls(this.d.now() - BOOKING_CALL_CLOSES_AFTER_MS).filter((b) => b.state === 'cancelled' || b.callStart !== b.start)
  }

  private async owe(calendarId: string): Promise<void> {
    this.store.markCalendarDirty(calendarId)
    try {
      await this.d.alarmAt(this.d.now())
    } catch (error) {
      this.d.log?.(`calendar: the read owed after a booking could not be asked for: ${describe(error)}`)
    }
  }

  private async told(b: { id: string; visitorName: string; start: number; end: number; linkName: string }): Promise<void> {
    this.d.tell()
    try {
      await this.d.notify?.({ id: b.id, name: b.visitorName, start: b.start, end: b.end, linkName: b.linkName })
    } catch (error) {
      this.d.log?.(`calendar: the owner could not be told of a booking: ${describe(error)}`)
    }
  }

  /**
   * Google answered an insert: the event is kept and, once the calendar's copy HOLDS it, the booking is booked and the owner told. A booking whose event the copy does not hold (Google's answer was not an event, or it said the id exists) stays held, so
   * its time is never offered in between, and the next read of the calendar finds it (`run`). Answers whether it is booked.
   */
  private async made(b: BookingRow, raw: unknown, checked: 'google' | 'copy'): Promise<boolean> {
    const parsed = raw === null ? null : parseEvent(raw, this.d.zone)
    if (parsed?.kind === 'event') this.store.putEvent(b.calendarId, parsed)
    await this.owe(b.calendarId)
    if (this.store.eventOf(b.calendarId, b.eventId) === null) return false
    this.rows.markBooked(b.id, checked, this.d.now())
    await this.told(b)
    return true
  }

  async book(slug: unknown, input: unknown, network: unknown): Promise<Result<GuestBooked>> {
    const read = readGuestBooking(input)
    if (!read.ok) return read
    if (typeof network !== 'string' || network === '' || network.length > 100) return no('bad-request', 'No network address came with that.')
    const asked = read.value
    // Everything that needs an await is done before the time is taken: from the check that it is free to the hold's row there is none.
    const id = this.d.newId()
    const secret = this.d.newToken()
    const pepper = this.rows.pepper(() => this.d.newToken())
    const [eventId, manageHash, networkHash] = await Promise.all([bookingEventId(this.d.installId, id), secretHash(secret), sha256(`${pepper}\nnetwork\n${networkKeyOf(network)}`).then((b) => hex(b).slice(0, 32))])

    // A link held in the space's call asks, before the time is taken, whether a call can be made (the month's allowance).
    const meterStops = typeof slug === 'string' && this.rows.linkBySlug(slug)?.where === 'space' ? (await this.meterWhy()) !== null : false

    const link = typeof slug === 'string' ? this.rows.linkBySlug(slug) : null
    if (!link) return no('not-found', 'There is no such booking link.')
    const holder = this.holder(link.account)
    if (!link.enabled || 'problem' in holder || this.problemOf(link) !== null || (link.where === 'space' && meterStops)) return no('conflict', CLOSED_WORDS)
    if (!this.slotsFor(link).includes(asked.start)) return no('conflict', TAKEN_WORDS)
    // After the slot check, so a probe needs a time the link really offers, and with one sentence for all of them: nothing here says whether an address is the owner's, or has booked.
    const key = canonicalAddress(asked.email)
    if (asked.email === link.account || this.store.account(asked.email) || this.overLimit(link, key, networkHash)) return no('limit', NOT_NOW_WORDS)
    const end = asked.start + link.minutes * MIN
    // THE HOLD: written in the same turn as the check above, so no other visitor can be given this time.
    this.rows.addBooking({
      id,
      linkId: link.id,
      linkName: link.name,
      account: link.account,
      calendarId: holder.calendar.id,
      calendarGoogleId: holder.calendar.googleId,
      eventId,
      minutes: link.minutes,
      start: asked.start,
      end,
      visitorName: asked.name,
      visitorEmail: asked.email,
      visitorKey: key,
      note: asked.note === '' ? null : asked.note,
      manageHash,
      checked: 'copy',
      where: link.where,
      network: networkHash,
      createdAt: this.d.now(),
    })
    const held = this.rows.booking(id) as BookingRow

    // Google is asked now whether the owner is still free: the copy can be seconds to hours behind.
    const verdict = await this.askGoogle(asked.start, end, link.gapMinutes * MIN, null)
    if (verdict.busy) {
      this.rows.removeBooking(id)
      return no('conflict', TAKEN_WORDS)
    }
    // How it was checked is kept with the hold, so a booking found later by its event is still said to have been checked as it was.
    this.rows.setChecked(id, verdict.checked)

    const writer = this.d.writer?.(link.account)
    if (!writer) {
      this.rows.removeBooking(id)
      return no('conflict', CLOSED_WORDS)
    }
    // A call in the space is made now: after the time is held and Google has said the owner is free, and before the event, which carries its link as the place. The booking's own id is the call's key, so a retry makes no second one.
    let call: { name: string; link: string } | null = null
    if (link.where === 'space') {
      const title = `${link.name}: ${asked.name}`
      let made: Awaited<ReturnType<BookingCalls['make']>>
      try {
        made = this.d.calls === undefined ? { ok: false, why: 'No calls are wired.' } : await this.d.calls.make({ key: id, title, guest: { name: asked.name, email: asked.email }, ...this.windowOf(asked.start, end) })
      } catch (error) {
        // Not known whether it was made: nobody has its address (no invitation went out), so the time is let go and nothing is open to anyone.
        this.d.log?.(`calendar: a call for a booking could not be made: ${describe(error)}`)
        this.rows.removeBooking(id)
        return no('conflict', CLOSED_WORDS)
      }
      if (!made.ok) {
        this.d.log?.(`calendar: a call for a booking was refused: ${made.why}`)
        this.rows.removeBooking(id)
        return no('conflict', CLOSED_WORDS)
      }
      call = { name: made.name, link: made.link }
      this.rows.setCall(id, made.name, made.link, asked.start)
    }
    // A booking that fails after its call was made leaves no open call.
    const letGo = async (): Promise<void> => {
      const b = this.rows.booking(id)
      if (b !== null && !(await this.closeCall(b))) this.d.log?.('calendar: the call of a booking that failed could not be closed; nobody has its address')
      this.rows.removeBooking(id)
    }
    const body = {
      id: eventId,
      summary: `${link.name}: ${asked.name}`,
      description: this.descriptionOf(link, secret, call === null ? null : call.link),
      start: { dateTime: isoAt(asked.start, this.d.zone), timeZone: this.d.zone },
      end: { dateTime: isoAt(end, this.d.zone), timeZone: this.d.zone },
      attendees: [{ email: asked.email, displayName: asked.name }],
      guestsCanInviteOthers: false,
      // Google Meet: the request's own id is the booking's, so a Meet link asked for twice is one. A call in the space: its link is the place, and no Google Meet is asked for.
      ...(call === null ? { conferenceData: { createRequest: { requestId: id, conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : { location: call.link }),
    }
    let raw: Record<string, unknown> | null = null
    try {
      raw = await writer.insertEvent(holder.calendar.googleId, body)
    } catch (error) {
      if (error instanceof CalendarAccessError || error instanceof CalendarRefused || (error instanceof CalendarError && (error.status === 400 || error.status === 403))) {
        // A decision about the write: nothing was made, and the time is let go.
        this.d.log?.(`calendar: a booking was refused by Google: ${describe(error)}`)
        await letGo()
        return no('conflict', CLOSED_WORDS)
      }
      if (error instanceof CalendarError && error.status === 409) {
        // The event is already there under its own id: it is this very booking, made before the answer was lost.
        raw = null
      } else {
        // Not a decision (no answer, a server fault): the time stays held, and the next reads of the calendar find the event by its id.
        this.d.log?.(`calendar: a booking's outcome is not known: ${describe(error)}`)
        await this.owe(holder.calendar.id)
        await this.d.alarmAt(this.d.now() + BOOKING_LOOK_MS)
        return ok({ secret, booking: this.viewFor(held) })
      }
    }
    // Booked once the copy holds the event; until then it is held, and `run` books it when the next read brings the event in.
    await this.made(held, raw, verdict.checked)
    return ok({ secret, booking: this.viewFor(this.rows.booking(id) as BookingRow) })
  }

  // ── Moving and cancelling ─────────────────────────────────────────────────────────────────────────────────────────────

  async move(secret: unknown, start: unknown): Promise<Result<GuestBookingView>> {
    const b = await this.byHash(secret)
    if (!b) return no('not-found', 'There is no such booking.')
    if (!whole(start, 1, Number.MAX_SAFE_INTEGER)) return no('bad-request', 'Pick one of the times offered.')
    const view = this.viewFor(b)
    const link = this.rows.link(b.linkId)
    if (!view.canMove || !link) return no('conflict', view.state === 'past' ? 'That meeting has been.' : view.state === 'cancelled' ? 'That booking was cancelled.' : view.state === 'removed' ? 'This meeting was removed from the host’s calendar.' : view.state === 'pending' ? 'This booking is still being confirmed.' : view.linkOpen ? 'This booking cannot be moved.' : 'This link is no longer taking bookings, so this meeting cannot be moved. You can still cancel it.')
    if (start === b.start) return no('bad-request', 'That is the time it already has.')
    if (!this.slotsFor(link, b).includes(start)) return no('conflict', TAKEN_WORDS)
    const end = start + link.minutes * MIN
    // THE HOLD of the new time, in the same turn as the check.
    this.rows.startMove(b.id, start, end, this.d.now())

    const current = this.store.eventOf(b.calendarId, b.eventId)
    const verdict = await this.askGoogle(start, end, link.gapMinutes * MIN, { start: current?.start ?? b.start, end: current?.end ?? b.end })
    if (verdict.busy) {
      this.rows.endMove(b.id)
      return no('conflict', TAKEN_WORDS)
    }
    const writer = this.d.writer?.(b.account)
    if (!writer) {
      this.rows.endMove(b.id)
      return no('conflict', CLOSED_WORDS)
    }
    try {
      const raw = await writer.patchEvent(b.calendarGoogleId, b.eventId, { start: { dateTime: isoAt(start, this.d.zone), timeZone: this.d.zone }, end: { dateTime: isoAt(end, this.d.zone), timeZone: this.d.zone } })
      const parsed = parseEvent(raw, this.d.zone)
      if (parsed.kind === 'event') this.store.putEvent(b.calendarId, parsed)
      this.rows.finishMove(b.id, start, end)
    } catch (error) {
      if (error instanceof CalendarNotFound || error instanceof CalendarGone) {
        this.rows.endMove(b.id)
        return no('conflict', 'This meeting was removed from the calendar it was on, so it cannot be moved.')
      }
      if (error instanceof CalendarAccessError || error instanceof CalendarRefused || (error instanceof CalendarError && error.status >= 400 && error.status < 500 && error.status !== 429)) {
        this.d.log?.(`calendar: a move was refused by Google: ${describe(error)}`)
        this.rows.endMove(b.id)
        return no('conflict', CLOSED_WORDS)
      }
      // Not a decision: the new time stays held for a while, and the calendar's own copy shows which time the event has once it is read.
      this.d.log?.(`calendar: a move's outcome is not known: ${describe(error)}`)
      await this.owe(b.calendarId)
      return { ok: false, reason: 'conflict', error: UNSURE_WORDS }
    }
    await this.owe(b.calendarId)
    this.d.tell()
    // The same call, at the new time: now, or by the alarm when Meet does not answer.
    await this.followCall(this.rows.booking(b.id) as BookingRow)
    return ok(this.viewFor(this.rows.booking(b.id) as BookingRow))
  }

  async cancel(secret: unknown): Promise<Result<GuestBookingView>> {
    const b = await this.byHash(secret)
    if (!b) return no('not-found', 'There is no such booking.')
    const view = this.viewFor(b)
    if (view.state === 'cancelled' || view.state === 'removed') return ok(view)
    if (view.state === 'pending') return no('conflict', 'This booking is still being confirmed. Please try again in a few minutes.')
    if (!view.canCancel) return no('conflict', view.state === 'past' ? 'That meeting has been.' : 'This booking cannot be cancelled here.')
    const writer = this.d.writer?.(b.account)
    if (!writer) return no('conflict', CLOSED_WORDS)
    try {
      await writer.deleteEvent(b.calendarGoogleId, b.eventId)
    } catch (error) {
      // Already gone at Google is as good as deleted.
      if (!(error instanceof CalendarNotFound || error instanceof CalendarGone)) {
        if (error instanceof CalendarAccessError || error instanceof CalendarRefused || (error instanceof CalendarError && error.status >= 400 && error.status < 500 && error.status !== 429)) {
          this.d.log?.(`calendar: a cancellation was refused by Google: ${describe(error)}`)
          return no('conflict', CLOSED_WORDS)
        }
        this.d.log?.(`calendar: a cancellation's outcome is not known: ${describe(error)}`)
        await this.owe(b.calendarId)
        return no('conflict', UNSURE_WORDS)
      }
    }
    this.store.dropEvent(b.calendarId, b.eventId)
    this.rows.markCancelled(b.id, this.d.now())
    await this.owe(b.calendarId)
    this.d.tell()
    // Its call is closed: now, or by the alarm when Meet does not answer.
    await this.closeCall(this.rows.booking(b.id) as BookingRow)
    return ok(this.viewFor(this.rows.booking(b.id) as BookingRow))
  }

  // ── The alarm ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * What is waiting on Google. A booking whose event has appeared in the calendar's copy (found by its derived id) is booked. One whose event has not appeared lets its time go only when an hour has passed AND the calendar has been read successfully since it
   * was made (it was never made); while reads keep failing the time stays held, so it is never offered again behind a booking that may exist. A move whose answer was lost is settled the same way: the event's times, once the copy has them, become the booking's
   * and the move is counted; a move the copy never shows is let go after the hour and a read. Never throws. Answers whether the page should be told.
   */
  async run(): Promise<boolean> {
    try {
      let changed = false
      const now = this.d.now()
      const readSince = (calendarId: string, at: number): boolean => {
        const c = this.store.calendar(calendarId)
        // A calendar that is gone or hidden is not read any more: nothing waited for will come.
        return c === null || !c.shown || (c.syncedAt !== null && c.syncedAt > at)
      }
      for (const b of this.rows.held()) {
        if (this.store.eventOf(b.calendarId, b.eventId) !== null) {
          this.rows.markBooked(b.id, b.checked, now)
          await this.told(b)
          changed = true
        } else if (now - b.createdAt >= BOOKING_HOLD_MS && readSince(b.calendarId, b.createdAt)) {
          // A held booking that is let go has no open call: it is closed first, and while Meet does not answer the hold stays and is looked at again.
          if (!(await this.closeCall(b))) continue
          this.rows.removeBooking(b.id)
          changed = true
        }
      }
      for (const b of this.rows.moving()) {
        const event = this.store.eventOf(b.calendarId, b.eventId)
        if (event !== null && event.start === b.movingStart && event.end === b.movingEnd) {
          this.rows.finishMove(b.id, event.start, event.end)
          changed = true
        } else if (now - (b.movingAt ?? 0) >= BOOKING_HOLD_MS && readSince(b.calendarId, b.movingAt ?? 0)) {
          this.rows.endMove(b.id)
          changed = true
        }
      }
      // Calls Meet did not answer for: a cancelled booking's (to close) and a moved one's (to follow).
      for (const b of this.callsBehind()) {
        const done = b.state === 'cancelled' ? await this.closeCall(b) : await this.followCall(b)
        if (done) changed = true
      }
      return changed
    } catch (error) {
      this.d.log?.(`calendar: the bookings waiting on Google could not be looked at: ${describe(error)}`)
      return false
    }
  }

  /** When the alarm should ring for the bookings: while one is waiting on Google, soon; never (infinity) when none is. */
  nextWake(): number {
    return this.rows.held().length > 0 || this.rows.moving().length > 0 || this.callsBehind().length > 0 ? this.d.now() + BOOKING_LOOK_MS : Number.POSITIVE_INFINITY
  }
}
