// The stand-in for the calendar app (packages/calendar, `createSpaceCalendar`, which runs in the space's Worker): what `bun test` asks instead of the real one, and what a local page shows with fixture data
// (`SPACE_FIXTURES`, src/app.ts) so the Calendar tab, Today's events and Settings, Calendars can be seen and photographed with no Google and no store.
//
// It keeps the shape of the real answers (packages/workspace/src/calendar.ts) and the rules the screens lean on: an event is shown only while one of its calendars is, the same meeting in two calendars is ONE event naming
// both accounts, a lapsed account's events are the last picture and say so, and showing or hiding a calendar answers the calendar as it now stands. It checks nothing about who is asking: the real app admits the owner only,
// and the space's own tests prove the person its one sign-in check named is the one handed over (`calls[].asker`). Every call is recorded.
//
// The booking links (the space's ADR 0025) are kept here as the calendar keeps them, with the real rules (`readBookingLink`, `readGuestBooking` and `slotStarts`, which are pure) over the stand-in's own events: a link made in Settings is a page a visitor can open, a booking
// a visitor makes is an event in the Calendar tab and a line under its link in Settings, and a move or a cancellation is the visitor's own. Nothing is at Google, and the visitor's secret is kept as it is (this is not a store).
//
// The invented days are laid on the company's clock around `now`: two events soon, a few later today and tomorrow, and a week of others, so Today's lists and the agenda have something at any hour (a little after 22:00 the
// "soon" ones fall on tomorrow).

import { slotStarts } from '@space/calendar/src/booking-slots'
import { CLOSED_WORDS, readBookingLink, readGuestBooking, TAKEN_WORDS } from '@space/calendar/src/bookings'
import {
  answered,
  BOOKING_DEFAULTS,
  BOOKING_LIMITS,
  type BookingLinkView,
  type BookingRecord,
  bookingLinkPath,
  CALENDAR_BY_UID_MOST,
  type CalendarAccountMark,
  type CalendarAccountView,
  CALENDAR_BLOCK_AHEAD_MS,
  type CalendarAgenda,
  type CalendarBlocking,
  type CalendarEvent,
  type CalendarBookingLinks,
  type CalendarForGuests,
  type CalendarForSpace,
  type CalendarGuest,
  type CalendarResponse,
  type CalendarView,
  failed,
  type GuestBookingLink,
  type GuestBookingView,
  isoAt,
  momentAt,
  refused,
  type SignedIn,
  type SpaceReply,
  wallAt,
} from '@space/workspace'

const HOUR = 3_600_000
const MIN = 60_000

export type CalendarFixtureMode = '1' | 'lapsed' | 'down' | 'empty'

interface StandInCalendar {
  id: string
  account: string
  name: string
  color: string | null
  primary: boolean
  shown: boolean
  problem: string | null
}

interface StandInEvent extends Omit<CalendarEvent, 'accounts' | 'stale' | 'readAt'> {
  /** Calendars that hold a copy (ids), the first being the one drawn. */
  on: string[]
  /** The event's iCalendar id, which a mail's calendar card is joined to it by (`eventsByUid`); never given to the page. */
  uid?: string
}

export interface StandInCalendarApp {
  calls: { method: string; args: unknown[]; asker?: string }[]
  /** What the next call does instead of the normal thing: `throw` (the binding fails), `hang` (never answers), `broken` (a fault). */
  script: ('throw' | 'hang' | 'broken')[]
  accounts: { address: string; label: string; hue: number; events: boolean; state: CalendarAccountView['state']; reason: string | null }[]
  calendars: StandInCalendar[]
  events: StandInEvent[]
  /** The busy blocks as the stand-in keeps them: the switch (off at first), the accounts taken out, and a sentence when blocks could not be written. */
  blocking: { on: boolean; out: Set<string>; problem: string | null }
  /** The booking links and bookings as the stand-in keeps them (see the header). */
  booking: { links: StandInLink[]; bookings: StandInBooking[] }
  methods: CalendarForSpace
  /** The visitor's face, over the same links and bookings: what the open path's door (src/booking.ts) is handed in a local run with the fixtures. */
  guests: CalendarForGuests
}

/** A link as the stand-in keeps it: what the owner set. */
interface StandInLink {
  id: string
  slug: string
  name: string
  description: string
  account: string
  minutes: number
  hours: BookingLinkView['hours']
  noticeMinutes: number
  aheadDays: number
  gapMinutes: number
  perDay: number | null
  enabled: boolean
  where: BookingLinkView['where']
}

/** A booking as the stand-in keeps it: the visitor's own secret is kept as it is. */
interface StandInBooking {
  id: string
  linkId: string
  linkName: string
  secret: string
  name: string
  email: string
  note: string | null
  start: number
  end: number
  bookedAt: number
  state: 'booked' | 'cancelled'
  moves: number
  eventId: string
  /** Where it was booked to be held, and (a call in the space) the call's address. */
  where: BookingLinkView['where']
  callLink: string | null
}

const guest = (name: string, email: string, response: CalendarResponse, extra: Partial<CalendarGuest> = {}): CalendarGuest => ({ name, email, response, organizer: false, self: false, ...extra })

export function standInCalendar(now: number, zone: string, mode: CalendarFixtureMode = '1'): StandInCalendarApp {
  const w = wallAt(now, zone)
  /** A moment on the company's clock: `d` days from today at `h`:`m`. */
  const at = (d: number, h: number, m = 0): number => momentAt(w.y, w.m, w.d + d, h, m, zone)
  const date = (d: number): string => new Date(Date.UTC(w.y, w.m - 1, w.d + d)).toISOString().slice(0, 10)
  let n = 0
  const timed = (title: string, start: number, minutes: number, on: string[], extra: Partial<StandInEvent> = {}): StandInEvent => ({
    id: `${on[0]}|ev${++n}`,
    title,
    start,
    end: start + minutes * MIN,
    allDay: false,
    startDate: null,
    endDate: null,
    location: null,
    videoLink: null,
    htmlLink: 'https://www.google.com/calendar/event?eid=standin',
    description: null,
    status: 'confirmed',
    response: null,
    organizer: null,
    guests: [],
    guestsLeft: 0,
    free: false,
    on,
    ...extra,
  })
  const allDay = (title: string, firstDay: number, days: number, on: string[], extra: Partial<StandInEvent> = {}): StandInEvent =>
    timed(title, at(firstDay, 0), 0, on, { allDay: true, start: at(firstDay, 0), end: at(firstDay + days, 0), startDate: date(firstDay), endDate: date(firstDay + days - 1), ...extra })

  const accounts: StandInCalendarApp['accounts'] = [
    { address: 'tessa@northfield.example', label: 'northfield', hue: 0, events: true, state: 'live', reason: null },
    { address: 'tessa@ashgrove.example', label: 'ashgrove', hue: 1, events: true, state: 'live', reason: null },
    { address: 'tessa_marlow@gmail.com', label: 'tessa_marlow', hue: 2, events: true, state: 'live', reason: null },
    { address: 'tessa.marlow@fernway.example', label: 'fernway', hue: 3, events: true, state: 'live', reason: null },
  ]
  // Tessa's ashgrove account is the one whose sign-in has lapsed in the inbox's own fixtures too (src/fixture-views.ts): the grant is one, so mail and calendar lapse together.
  if (mode === 'lapsed') {
    const a = accounts[1]
    if (a) {
      a.state = 'lapsed'
      a.reason = 'Google no longer accepts the saved sign-in for tessa@ashgrove.example (a Google app in testing mode loses its grants after 7 days), so what is shown for it is the last picture and nothing new arrives. Connect it again.'
    }
  }
  // And tessa_marlow is connected for mail without the calendar permission: it says so, has no calendars here, and offers Connect calendar.
  if (mode === 'lapsed') {
    const a = accounts[2]
    if (a) {
      a.state = 'needs-calendar'
      a.reason = 'tessa_marlow@gmail.com is connected for mail without the calendar permission. Press Connect calendar and accept it.'
    }
  }
  // And fernway reads but was connected before the permission to change events was asked for: Settings says editing needs Connect calendar again.
  if (mode === 'lapsed') {
    const a = accounts[3]
    if (a) a.events = false
  }
  const Z = 'tessa@northfield.example|tessa@northfield.example'
  const ZT = 'tessa@northfield.example|team-northfield@group.calendar.google.com'
  const ZH = 'tessa@northfield.example|en.usa#holiday@group.v.calendar.google.com'
  const F = 'tessa@ashgrove.example|tessa@ashgrove.example'
  const U = 'tessa_marlow@gmail.com|tessa_marlow@gmail.com'
  const UB = 'tessa_marlow@gmail.com|addressbook#contacts@group.v.calendar.google.com'
  const H = 'tessa.marlow@fernway.example|tessa.marlow@fernway.example'
  const allCalendars: StandInCalendar[] = [
    { id: Z, account: 'tessa@northfield.example', name: 'Tessa Marlow', color: '#4285f4', primary: true, shown: true, problem: null },
    { id: ZT, account: 'tessa@northfield.example', name: 'Northfield Works team', color: '#8e24aa', primary: false, shown: true, problem: null },
    { id: ZH, account: 'tessa@northfield.example', name: 'Holidays in United States', color: '#0b8043', primary: false, shown: false, problem: null },
    { id: F, account: 'tessa@ashgrove.example', name: 'Tessa Marlow', color: '#d81b60', primary: true, shown: true, problem: null },
    { id: U, account: 'tessa_marlow@gmail.com', name: 'tessa_marlow@gmail.com', color: '#33b679', primary: true, shown: true, problem: null },
    { id: UB, account: 'tessa_marlow@gmail.com', name: 'Birthdays', color: '#f4511e', primary: false, shown: false, problem: null },
    { id: H, account: 'tessa.marlow@fernway.example', name: 'Tessa Marlow', color: '#039be5', primary: true, shown: true, problem: null },
  ]

  // An account with no calendar permission has no calendars here, and so no events.
  const calendars = allCalendars.filter((c) => accounts.find((a) => a.address === c.account)?.state !== 'needs-calendar')

  const events: StandInEvent[] =
    mode === 'empty'
      ? []
      : [
          // Soon: what Later today draws.
          timed('Northfield Works standup', now + 40 * MIN, 30, [Z], {
            videoLink: 'https://meet.google.com/abc-defg-hij',
            organizer: { name: 'Tessa Marlow', email: 'tessa@northfield.example' },
            guests: [guest('Tessa Marlow', 'tessa@northfield.example', 'accepted', { organizer: true, self: true }), guest('Priya Natarajan', 'priya@northfield.example', 'accepted')],
            response: 'accepted',
          }),
          timed('Intro chat with Arun Mehta', now + 2 * HOUR, 30, [F], {
            location: 'Juniper Coffee, 3 Main St, Alder Bend',
            description: 'Arun came in through the advisory list. Ask what he would want a board to do for Ashgrove.\nBring the one-page summary.',
            response: 'needsAction',
            organizer: { name: 'Arun Mehta', email: 'arun@example.org' },
            guests: [guest('Arun Mehta', 'arun@example.org', 'accepted', { organizer: true }), guest('Tessa Marlow', 'tessa@ashgrove.example', 'needsAction', { self: true })],
          }),
          // The same board call is on two of his calendars: one event, naming both.
          timed('Board call', now + 4 * HOUR, 60, [F, Z], {
            videoLink: 'https://meet.google.com/xyz-board-call',
            response: 'accepted',
            organizer: { name: 'Milo Brandt', email: 'milo@ashgrove.example' },
            guests: [guest('Milo Brandt', 'milo@ashgrove.example', 'accepted', { organizer: true }), guest('Tessa Marlow', 'tessa@ashgrove.example', 'accepted', { self: true }), guest('Tessa Marlow', 'tessa@northfield.example', 'accepted')],
          }),
          timed('Dentist', now - 3 * HOUR, 60, [U], { location: '120 Mill Rd, Alder Bend' }),
          allDay('Ashgrove board packet due', 0, 1, [F]),
          // Tomorrow.
          timed('Weekly planning', at(1, 9), 45, [Z], { response: 'accepted' }),
          timed('Fernway sync', at(1, 11, 30), 30, [H], { response: 'declined', guests: [guest('Teo Ortiz', 'teo@fernway.example', 'accepted', { organizer: true })] }),
          timed('Lunch with Dana', at(1, 12, 30), 60, [U], { status: 'tentative', location: 'Lark Cafe' }),
          timed('Advisory intro: Maria Lopez', at(1, 16), 30, [Z], { response: 'needsAction', videoLink: 'https://meet.google.com/adv-maria-lop', uid: 'advisory-intro-maria@example.test' }),
          // The rest of the week.
          allDay('Offsite', 2, 2, [F], { location: 'Santa Barbara' }),
          timed('Harbor Dental walkthrough', at(2, 10), 90, [Z], { location: 'Harbor Dental, Alder Bend', response: 'accepted' }),
          timed('Fernway board prep', at(3, 14), 60, [H]),
          timed('Ashgrove all-hands', at(4, 9, 30), 60, [F], { videoLink: 'https://meet.google.com/all-hands-fre' }),
          timed('Call with the accountant', at(5, 15), 30, [Z, U], { response: 'accepted' }),
          allDay('Dana’s birthday', 6, 1, [U]),
          // On calendars that are hidden to begin with (holidays, other people's birthdays): not in the agenda until the calendar is shown.
          allDay('Observed holiday', 5, 1, [ZH]),
          allDay('Arun’s birthday', 3, 1, [UB]),
          timed('Planning review', at(8, 13), 60, [Z], { response: 'accepted' }),
          timed('Quarterly check-in', at(10, 11), 45, [H, F], { response: 'accepted' }),
          // Three that overlap the day after tomorrow (with Harbor Dental walkthrough, 10:00 to 11:30), so the week draws them side by side; and a crowded day (the 3rd from now) that the month cuts to "+N more".
          timed('Design review', at(2, 10, 15), 60, [F], { videoLink: 'https://meet.google.com/design-rev-x' }),
          timed('Quick sync', at(2, 10, 30), 30, [U]),
          timed('Standup with the Fernway crew', at(3, 9), 30, [H]),
          timed('Pipeline review', at(3, 10), 60, [Z], { response: 'accepted' }),
          timed('Coffee with Abel', at(3, 11, 30), 45, [U], { location: 'Cedar Street Coffee, Alder Bend' }),
          timed('Ashgrove finance check', at(3, 16), 45, [F]),
          // An evening that runs past midnight, drawn on both days.
          timed('Late call with the Singapore team', at(4, 22), 150, [Z], { videoLink: 'https://meet.google.com/sg-late-call' }),
          // The past weeks, so Previous has something to show.
          timed('Retro', at(-1, 15), 45, [Z], { response: 'accepted' }),
          timed('Client call: Harbor Dental', at(-2, 10), 60, [Z, F], { response: 'accepted' }),
          allDay('Travel to LA', -3, 2, [F]),
          timed('Lunch with Priya', at(-4, 12), 60, [U]),
          timed('Pipeline review', at(-4, 14), 60, [Z], { response: 'accepted' }),
          timed('Weekly planning', at(-6, 9), 45, [Z], { response: 'accepted' }),
          timed('Board prep', at(-9, 13), 90, [F]),
          timed('Fernway sync', at(-12, 11), 30, [H], { response: 'accepted' }),
          allDay('Dentist (rescheduled)', -15, 1, [U]),
          timed('Quarterly planning', at(-20, 9), 120, [Z, F], { response: 'accepted' }),
          timed('Ashgrove all-hands', at(-34, 9, 30), 60, [F]),
          // The weeks and months ahead.
          timed('Offsite dinner', at(12, 18, 30), 120, [F], { location: 'Santa Barbara' }),
          timed('Planning review', at(15, 13), 60, [Z], { response: 'accepted' }),
          timed('Fernway board meeting', at(21, 10), 90, [H], { response: 'needsAction', guests: [guest('Teo Ortiz', 'teo@fernway.example', 'accepted', { organizer: true })] }),
          allDay('Thanksgiving (observed)', 22, 1, [Z]),
          timed('Year-end planning', at(34, 14), 60, [Z, F], { response: 'accepted' }),
          timed('Ashgrove all-hands', at(48, 9, 30), 60, [F]),
        ]

  const calls: StandInCalendarApp['calls'] = []
  const script: StandInCalendarApp['script'] = []
  const blocking: StandInCalendarApp['blocking'] = { on: false, out: new Set(), problem: null }

  async function enter<T>(asker: SignedIn, method: string, args: unknown[]): Promise<SpaceReply<T> | null> {
    calls.push({ method, args, asker: asker.person.address })
    if (mode === 'down') throw new Error('stand-in calendar app is down')
    const step = script.shift()
    if (step === 'throw') throw new Error('stand-in calendar app lost the connection')
    if (step === 'hang') return new Promise(() => undefined)
    if (step === 'broken') return failed('The calendar could not answer that. Nothing was changed.')
    return null
  }

  const accountOf = (address: string) => accounts.find((a) => a.address === address)
  const mark = (a: { address: string; label: string; hue: number }): CalendarAccountMark => ({ address: a.address, label: a.label, hue: a.hue })
  const shownCalendar = (id: string) => calendars.find((c) => c.id === id && c.shown)
  const viewOf = (c: StandInCalendar): CalendarView => ({ id: c.id, name: c.name, color: c.color, primary: c.primary, shown: c.shown, readAt: c.shown ? now - 4 * MIN : null, problem: c.shown ? c.problem : null, note: null })

  /** An event as the page is given it: only the copies on shown calendars, naming those accounts, the last picture marked when its account is lapsed. */
  function present(e: StandInEvent): CalendarEvent | null {
    const held = e.on.map(shownCalendar).filter((c): c is StandInCalendar => c !== undefined)
    if (held.length === 0) return null
    const marks = [...new Map(held.map((c) => [c.account, accountOf(c.account)])).values()].filter((a): a is NonNullable<typeof a> => a !== undefined).sort((a, b) => a.hue - b.hue)
    const { on: _on, uid: _uid, ...rest } = e
    const lapsed = marks.every((a) => a.state === 'lapsed')
    return { ...rest, accounts: marks.map(mark), stale: lapsed, readAt: lapsed ? now - 3 * 24 * HOUR : now - 4 * MIN }
  }

  /** How the busy blocks stand, as the real calendar words it: the accounts that cannot hold one say why, and the count is the blocks that would be kept (every timed, busy meeting still to come on a shown calendar of a taking-part account, on each other taking-part account that can hold one). */
  function blockingView(): CalendarBlocking {
    const holds = (acct: (typeof accounts)[number]) => acct.state === 'live' && acct.events
    const skipped = (acct: (typeof accounts)[number]): Pick<CalendarBlocking['accounts'][number], 'skipped' | 'fix'> => {
      if (acct.state === 'lapsed') return { skipped: `The sign-in of ${acct.address} ended, so no block can be kept on it until it is connected again.`, fix: 'connect-again' }
      if (acct.state === 'needs-calendar') return { skipped: `${acct.address} is connected for mail without the calendar permission, so no block can be kept on it. Press Connect calendar and accept it.`, fix: 'connect-calendar' }
      if (!holds(acct)) return { skipped: `${acct.address} was connected for reading only, so no block can be kept on it. Press Connect calendar and accept the permission to change events.`, fix: 'connect-calendar' }
      return { skipped: null, fix: null }
    }
    let kept = 0
    if (blocking.on) {
      for (const e of events) {
        if (e.allDay || e.free || e.response === 'declined' || e.end <= now || e.start >= now + CALENDAR_BLOCK_AHEAD_MS) continue
        const held = new Set(e.on.filter((id) => shownCalendar(id)).map((id) => calendars.find((c) => c.id === id)?.account))
        if (![...held].some((address) => address !== undefined && !blocking.out.has(address))) continue
        kept += accounts.filter((acct) => !blocking.out.has(acct.address) && holds(acct) && !held.has(acct.address)).length
      }
    }
    return {
      on: blocking.on,
      kept,
      problem: blocking.problem,
      accounts: accounts.map((acct) => ({ address: acct.address, label: acct.label, hue: acct.hue, takesPart: !blocking.out.has(acct.address), ...(blocking.out.has(acct.address) ? { skipped: null, fix: null } : skipped(acct)) })),
    }
  }

  // ── The booking links (see the header) ────────────────────────────────────────────────────────────────────────────────────────

  const started = Date.now()
  /** The stand-in's clock: the moment it was laid out around, moving as real time does, so a page left open sees times pass. */
  const clock = (): number => now + (Date.now() - started)
  const booking: StandInCalendarApp['booking'] = { links: [], bookings: [] }
  const ORIGIN = 'https://space.northfield.example'
  const COMPANY = 'Northfield Works'
  let linkNo = 0
  let bookingNo = 0

  /** Why a link cannot be booked now, in the owner's words, or null. */
  function problemOf(l: StandInLink): string | null {
    const acct = accountOf(l.account)
    if (!acct) return `${l.account} is not a connected Google account.`
    if (acct.state === 'lapsed') return `The sign-in of ${acct.address} ended, so nothing can be booked on it until it is connected again.`
    if (acct.state === 'needs-calendar') return `${acct.address} is connected for mail without the calendar permission, so nothing can be booked on it. Press Connect calendar and accept it.`
    if (!acct.events) return `${acct.address} was connected for reading only, so nothing can be booked on it. Press Connect calendar and accept the permission to change events.`
    return null
  }

  const recordOf = (b: StandInBooking): BookingRecord => ({ id: b.id, where: b.where, linkName: b.linkName, name: b.name, email: b.email, note: b.note, start: b.start, end: b.end, bookedAt: b.bookedAt, state: b.state, checked: 'google', link: b.state === 'booked' ? 'https://www.google.com/calendar/event?eid=standin' : null })

  function linkViewOf(l: StandInLink): BookingLinkView {
    const acct = accountOf(l.account)
    const { id, slug, name, description, account, minutes, hours, noticeMinutes, aheadDays, gapMinutes, perDay, enabled, where } = l
    return {
      id,
      where,
      slug,
      name,
      description,
      account,
      accountLabel: acct?.label ?? account,
      minutes,
      hours,
      noticeMinutes,
      aheadDays,
      gapMinutes,
      perDay,
      enabled,
      url: `${ORIGIN}${bookingLinkPath(slug)}`,
      problem: problemOf(l),
      bookings: booking.bookings
        .filter((b) => b.linkId === l.id && b.end > clock() - 30 * 24 * HOUR)
        .sort((x, y) => Number(y.end > clock()) - Number(x.end > clock()) || (x.end > clock() ? x.start - y.start : y.start - x.start))
        .map(recordOf),
    }
  }

  /** The free starting times of a link: the real rules over the stand-in's events that make the owner busy on a shown calendar, and the link's own bookings. `except` is a booking asking to move: its own time is free to itself. */
  function slotsOf(l: StandInLink, except?: StandInBooking): number[] {
    const busy = events
      .map(present)
      .filter((e): e is CalendarEvent => e !== null && !e.free && e.response !== 'declined' && e.id !== except?.eventId)
      .map((e) => ({ start: e.start, end: e.end }))
    return slotStarts({
      rules: { hours: l.hours, noticeMinutes: l.noticeMinutes, aheadDays: l.aheadDays, gapMinutes: l.gapMinutes, perDay: l.perDay },
      minutes: l.minutes,
      now: clock(),
      zone,
      busy,
      taken: booking.bookings.filter((b) => b.linkId === l.id && b.state === 'booked' && b !== except).map((b) => b.start),
    })
  }

  /** A booking is an event on its link's account's main calendar, so the Calendar tab shows it and later free times leave it out. */
  function putEvent(l: StandInLink, b: StandInBooking): void {
    const primary = calendars.find((c) => c.account === l.account && c.primary)
    const made = timed(`${b.linkName}: ${b.name}`, b.start, (b.end - b.start) / MIN, [primary?.id ?? `${l.account}|${l.account}`], { videoLink: b.callLink ?? 'https://meet.google.com/standin-book', response: null })
    const old = events.findIndex((e) => e.id === b.eventId)
    if (old >= 0) events.splice(old, 1)
    b.eventId = made.id
    events.push(made)
  }

  const bookingFor = (secret: unknown): StandInBooking | undefined => (typeof secret === 'string' && secret.length >= 8 ? booking.bookings.find((b) => b.secret === secret) : undefined)

  function guestViewOf(b: StandInBooking): GuestBookingView {
    const l = booking.links.find((x) => x.id === b.linkId)
    const state: GuestBookingView['state'] = b.state === 'cancelled' ? 'cancelled' : b.end <= clock() ? 'past' : 'booked'
    const open = l !== undefined && l.enabled && problemOf(l) === null
    return {
      company: COMPANY,
      title: b.linkName,
      slug: l?.slug ?? null,
      minutes: Math.round((b.end - b.start) / MIN),
      start: b.start,
      end: b.end,
      name: b.name,
      email: b.email,
      state,
      zone,
      where: b.where,
      meetLink: state === 'cancelled' ? null : (b.callLink ?? 'https://meet.google.com/standin-book'),
      canMove: state === 'booked' && b.start > clock() && b.moves < BOOKING_LIMITS.moves && open,
      canCancel: state === 'booked',
      linkOpen: open,
    }
  }

  const guests: CalendarForGuests = {
    async link(slug) {
      const l = booking.links.find((x) => x.slug === slug)
      if (!l) return refused('not-found', 'There is no such booking link.')
      const out: GuestBookingLink = { company: COMPANY, name: l.name, description: l.description, minutes: l.minutes, zone, open: l.enabled && problemOf(l) === null, where: l.where }
      return answered(out)
    },
    async slots(slug) {
      const l = booking.links.find((x) => x.slug === slug)
      if (!l) return refused('not-found', 'There is no such booking link.')
      if (!l.enabled || problemOf(l) !== null) return refused('conflict', CLOSED_WORDS)
      return answered({ from: clock(), to: clock() + l.aheadDays * 24 * HOUR, starts: slotsOf(l) })
    },
    async book(slug, input) {
      const l = booking.links.find((x) => x.slug === slug)
      if (!l) return refused('not-found', 'There is no such booking link.')
      const read = readGuestBooking(input)
      if (!read.ok) return refused(read.reason, read.error)
      if (!l.enabled || problemOf(l) !== null) return refused('conflict', CLOSED_WORDS)
      if (!slotsOf(l).includes(read.value.start)) return refused('conflict', TAKEN_WORDS)
      const b: StandInBooking = {
        id: `booking-${++bookingNo}`,
        linkId: l.id,
        linkName: l.name,
        secret: `standin-secret-${bookingNo}-${Math.random().toString(36).slice(2, 12)}`,
        name: read.value.name,
        email: read.value.email,
        note: read.value.note === '' ? null : read.value.note,
        start: read.value.start,
        end: read.value.start + l.minutes * MIN,
        bookedAt: clock(),
        state: 'booked',
        moves: 0,
        eventId: '',
        where: l.where,
        callLink: l.where === 'space' ? `${ORIGIN}/r/standin-call-${bookingNo}` : null,
      }
      booking.bookings.push(b)
      putEvent(l, b)
      return answered({ secret: b.secret, booking: guestViewOf(b) })
    },
    async booking(secret) {
      const b = bookingFor(secret)
      return b ? answered(guestViewOf(b)) : refused('not-found', 'There is no such booking.')
    },
    async bookingSlots(secret) {
      const b = bookingFor(secret)
      const l = b ? booking.links.find((x) => x.id === b.linkId) : undefined
      if (!b || !l) return refused('not-found', 'There is no such booking.')
      if (!guestViewOf(b).canMove) return refused('conflict', 'This booking cannot be moved.')
      return answered({ from: clock(), to: clock() + l.aheadDays * 24 * HOUR, starts: slotsOf(l, b) })
    },
    async move(secret, start) {
      const b = bookingFor(secret)
      const l = b ? booking.links.find((x) => x.id === b.linkId) : undefined
      if (!b || !l) return refused('not-found', 'There is no such booking.')
      if (!guestViewOf(b).canMove) return refused('conflict', 'This booking cannot be moved.')
      if (start === b.start) return refused('bad-request', 'That is the time it already has.')
      if (!slotsOf(l, b).includes(start)) return refused('conflict', TAKEN_WORDS)
      b.end = start + (b.end - b.start)
      b.start = start
      b.moves += 1
      putEvent(l, b)
      return answered(guestViewOf(b))
    },
    async cancel(secret) {
      const b = bookingFor(secret)
      if (!b) return refused('not-found', 'There is no such booking.')
      if (b.state === 'cancelled') return answered(guestViewOf(b))
      if (!guestViewOf(b).canCancel) return refused('conflict', 'That meeting has been.')
      b.state = 'cancelled'
      const at = events.findIndex((e) => e.id === b.eventId)
      if (at >= 0) events.splice(at, 1)
      return answered(guestViewOf(b))
    },
  }

  const methods: CalendarForSpace = {
    async calendars(a) {
      const early = await enter<CalendarAccountView[]>(a, 'calendars', [])
      if (early) return early
      return answered(
        accounts.map((acct): CalendarAccountView => {
          const own = calendars.filter((c) => c.account === acct.address)
          return { address: acct.address, label: acct.label, hue: acct.hue, events: acct.events, state: acct.state, reason: acct.reason, readAt: acct.state === 'live' ? now - 4 * MIN : acct.state === 'lapsed' ? now - 3 * 24 * HOUR : null, note: null, calendars: own.map(viewOf) }
        }),
      )
    },
    async agenda(a, from, to) {
      const early = await enter<CalendarAgenda>(a, 'agenda', [from, to])
      if (early) return early
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from) return refused('bad-request', 'An agenda is from one moment to a later one.')
      const found = events
        .map(present)
        .filter((e): e is CalendarEvent => e !== null && e.end > from && e.start < to)
        .sort((x, y) => x.start - y.start || x.end - y.end || x.title.localeCompare(y.title))
      return answered({
        from,
        to,
        events: structuredClone(found),
        accounts: accounts.map((acct) => ({ ...mark(acct), state: acct.state, reason: acct.reason, readAt: acct.state === 'live' ? now - 4 * MIN : acct.state === 'lapsed' ? now - 3 * 24 * HOUR : null })),
      })
    },
    async event(a, id) {
      const early = await enter<CalendarEvent>(a, 'event', [id])
      if (early) return early
      const found = events.find((e) => e.id === id)
      const shown = found ? present(found) : null
      return shown ? answered(structuredClone(shown)) : refused('not-found', 'That event is gone: it was changed or removed in Google Calendar.')
    },
    async eventsByUid(a, asks) {
      const early = await enter<(CalendarEvent | null)[]>(a, 'eventsByUid', [asks])
      if (early) return early
      if (!Array.isArray(asks) || asks.length > CALENDAR_BY_UID_MOST) return refused('bad-request', `Ask for at most ${CALENDAR_BY_UID_MOST} events at a time.`)
      return answered(
        asks.map((ask) => {
          const held = events.filter((e) => ask.uid !== '' && e.uid === ask.uid)
          const named = ask.occurrence?.at !== null && ask.occurrence?.at !== undefined ? held.find((e) => e.start === ask.occurrence?.at) : ask.occurrence?.date !== null && ask.occurrence?.date !== undefined ? held.find((e) => e.allDay && e.startDate === ask.occurrence?.date) : (held.find((e) => e.start >= now) ?? held[held.length - 1])
          const shown = named ? present(named) : null
          return shown ? structuredClone(shown) : null
        }),
      )
    },
    async setShown(a, calendarId, shown) {
      const early = await enter<CalendarView>(a, 'setShown', [calendarId, shown])
      if (early) return early
      const c = calendars.find((x) => x.id === calendarId)
      if (!c) return refused('not-found', 'No such calendar.')
      c.shown = shown
      return answered(viewOf(c))
    },
    async syncNow(a) {
      const early = await enter<{ asked: number }>(a, 'syncNow', [])
      if (early) return early
      return answered({ asked: calendars.filter((c) => c.shown).length })
    },
    async blocking(a) {
      const early = await enter<CalendarBlocking>(a, 'blocking', [])
      if (early) return early
      return answered(blockingView())
    },
    async setBlocking(a, on) {
      const early = await enter<CalendarBlocking>(a, 'setBlocking', [on])
      if (early) return early
      if (typeof on !== 'boolean') return refused('bad-request', 'Say whether the busy blocks are on.')
      blocking.on = on
      return answered(blockingView())
    },
    async setBlockingAccount(a, address, takesPart) {
      const early = await enter<CalendarBlocking>(a, 'setBlockingAccount', [address, takesPart])
      if (early) return early
      if (!accountOf(address)) return refused('not-found', 'No such account.')
      if (takesPart) blocking.out.delete(address)
      else blocking.out.add(address)
      return answered(blockingView())
    },
    async bookingLinks(a) {
      const early = await enter<CalendarBookingLinks>(a, 'bookingLinks', [])
      if (early) return early
      return answered({
        links: booking.links.map(linkViewOf),
        accounts: accounts.map((acct) => {
          const why = problemOf({ account: acct.address } as StandInLink)
          return { address: acct.address, label: acct.label, canBook: why === null, why }
        }),
        defaults: BOOKING_DEFAULTS,
        zone,
        origin: ORIGIN,
        // The stand-in's space has calls on, so a link can hold its meetings in one.
        calls: true,
      })
    },
    async makeBookingLink(a, input) {
      const early = await enter<BookingLinkView>(a, 'makeBookingLink', [input])
      if (early) return early
      const read = readBookingLink(input)
      if (!read.ok) return refused(read.reason, read.error)
      if (!accountOf(read.value.account)) return refused('bad-request', `${read.value.account} is not a connected Google account.`)
      if (booking.links.some((l) => l.slug === read.value.slug)) return refused('conflict', `The address ${read.value.slug} is used by another link. Pick another.`)
      if (booking.links.length >= BOOKING_LIMITS.linksMax) return refused('limit', `A space holds at most ${BOOKING_LIMITS.linksMax} booking links. Delete one first.`)
      const made: StandInLink = { id: `link-${++linkNo}`, ...read.value }
      booking.links.push(made)
      return answered(linkViewOf(made))
    },
    async changeBookingLink(a, id, input) {
      const early = await enter<BookingLinkView>(a, 'changeBookingLink', [id, input])
      if (early) return early
      const held = booking.links.find((l) => l.id === id)
      if (!held) return refused('not-found', 'No such link.')
      const read = readBookingLink(input)
      if (!read.ok) return refused(read.reason, read.error)
      if (!accountOf(read.value.account)) return refused('bad-request', `${read.value.account} is not a connected Google account.`)
      if (booking.links.some((l) => l.slug === read.value.slug && l.id !== id)) return refused('conflict', `The address ${read.value.slug} is used by another link. Pick another.`)
      Object.assign(held, read.value)
      return answered(linkViewOf(held))
    },
    async deleteBookingLink(a, id) {
      const early = await enter<{ id: string }>(a, 'deleteBookingLink', [id])
      if (early) return early
      const at = booking.links.findIndex((l) => l.id === id)
      if (at < 0) return refused('not-found', 'No such link.')
      booking.links.splice(at, 1)
      return answered({ id })
    },
  }

  return { calls, script, accounts, calendars, events, blocking, booking, methods, guests }
}
