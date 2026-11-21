// What the calendar app answers: the interface of its one face, method by method (the package is packages/calendar).
//
// THE CALENDAR KEEPS ITS OWN COPY. Google's calendars are synced into the calendar's store (a first full read, then changes from Google's sync token, woken by Google's push notifications), the way the
// inbox holds mail. Every method here reads that store and none asks Google, so the tab and Today are as quick as the space and a Google outage shows as an old picture marked with when it was read.
//
// ONE FACE, for the space (`CalendarForSpace`): it runs INSIDE the space's Worker (the company layer's ADR 0003), over a store the Worker owns, and EVERY METHOD takes the person the space's one sign-in
// check named (`SignedIn`), then admits the install's owner and no one else (the accounts are the owner's). A service token is never a person, so none comes through. None of its methods writes an event at Google: the ones that
// change anything change the owner's SETTINGS (a calendar shown, the busy-block switch and an account's part in it, the booking links), and the writes that follow from the blocking switch are the calendar's own, from its alarm (the space's ADR 0024). Claude has no door to it
// (the company layer's ADR 0002: Claude's one path leads to the inbox), and reaches the calendar through the inbox's router instead, by the second face further down (`CalendarForInbox`): the free time read from
// the store, and invites made, moved and cancelled under the rule a send of mail is under (the owner's instruction and the owner's switch; the space's ADR 0023). A THIRD face, at the foot of the file (`CalendarForGuests`), is the open path's: the visitor of a
// booking link, who is nobody the space knows (the space's ADR 0025).
//
// TIMES are milliseconds since the epoch; an all-day event is also given as its calendar days, because it has no hour (Google gives it a date, and the days must not move with the reader's zone).
// EVENT TEXT IS UNTRUSTED (a title, a place, a description and a guest's name are whatever the organiser typed): the page draws it as text, never as markup.

import type { SignedIn, SpaceReply } from './asking'

/** The path of Google's push notifications, on the push host (the hostname the inbox's Gmail push already uses): `https://<push host>/calendar/push`. Answered by the space's Worker, which hands it to the calendar. */
export const CALENDAR_PUSH_PATH = '/calendar/push'

/** The Google permission that READS calendars. It is what "the calendar is connected" requires, and the only one the calendar's sync is ever handed a token for. */
export const CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'

/**
 * The Google permission that creates, changes and deletes events (asked with the reading one, once per account, so a feature that writes events needs no second consent). Not the full `calendar` scope. Connect calendar
 * asks for it beside `CALENDAR_READONLY_SCOPE`. The sync never uses it; only Claude's invites, moves and cancellations do (`CalendarForInbox`), one call at a time, the "Busy" blocks the owner's own switch keeps on their other calendars
 * (the space's ADR 0024), one token for each run of the alarm, and a visitor's booking, move and cancellation (`CalendarForGuests`, the space's ADR 0025), each asking for its own. A grant that has the reading permission without it is connected for reading all the same (see `CalendarGrant.events`) and cannot take one.
 */
export const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events'

// ── What the inbox's part tells the calendar about the Google accounts ─────────────────────────────────────────────────────────────

/**
 * A Google account as the calendar is told of it by the inbox's part, which holds the grant (one per account, shared with mail). NO TOKEN: the refresh token never leaves the inbox's store. The calendar asks
 * the inbox for a short-lived access token instead (`CalendarAccess`), limited to the calendar permission alone.
 */
export interface CalendarGrant {
  /** The account's address, lower case. */
  address: string
  /** The short name its mail wears as a pill (northfield, brightwater). */
  label: string
  /** A token is held. False after a disconnect. */
  connected: boolean
  /** Google no longer accepts the saved grant (a Google app in testing mode loses its grants after 7 days). Mail is lapsed on the same grant. */
  lapsed: boolean
  /** The grant includes the calendar permission. False for an account connected for mail alone (before the calendar was added, or with the permission unticked): its calendar is connected from Settings, Calendars, which asks for that one permission incrementally. */
  calendar: boolean
  /** The grant also includes the permission to create and change events (`CALENDAR_EVENTS_SCOPE`). Reading does not need it: a grant with `calendar` and without this is connected for reading, and a booking feature tells it apart by this flag. */
  events: boolean
}

/**
 * What a token from the inbox may do: `read` (the default and the only one the calendar's sync asks for: `calendar.readonly` alone) or `events` (`calendar.events` alone, to create, change and delete events: asked only for the one
 * call of an invite, a move or a cancellation that Claude makes on the owner's instruction, and used for that call alone). Each is asked of Google as a scope of its own, so a token for one never carries the other.
 */
export type CalendarAccessLevel = 'read' | 'events'

/** Why the inbox gave no access token for an account. `no-events` is only for a token asked for at the events level (a grant that reads but cannot edit). */
export const CALENDAR_ACCESS_REFUSALS = ['disconnected', 'lapsed', 'no-calendar', 'no-events', 'failed'] as const
export type CalendarAccessRefusal = (typeof CALENDAR_ACCESS_REFUSALS)[number]

/**
 * The inbox's answer to "give me an access token for this account": a token that carries the calendar permission ONLY (Google is asked for that scope alone when the refresh token is used, so a token
 * the calendar holds cannot read or change mail), with when it ends; or why not. The words are the inbox's own and never hold a token.
 */
export type CalendarAccess = { ok: true; accessToken: string; expiresAt: number } | { ok: false; why: CalendarAccessRefusal; message: string }

// ── What the page is shown ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** How an account stands, as the calendar sees it. `needs-calendar`: connected for mail, and the calendar permission is not in the grant yet (Connect it again). */
export const CALENDAR_ACCOUNT_STATES = ['syncing', 'live', 'lapsed', 'needs-calendar', 'disconnected'] as const
export type CalendarAccountState = (typeof CALENDAR_ACCOUNT_STATES)[number]

/** One calendar of an account, as Settings lists it. */
export interface CalendarView {
  /** The calendar's key in the store: the account's address and Google's calendar id. Opaque to the page. */
  id: string
  name: string
  /** Google's colour for it (`#rrggbb`), or null. */
  color: string | null
  /** The account's own calendar. */
  primary: boolean
  /** Whether its events are in the agenda and Today. Owned and primary calendars are shown at first; holidays, birthdays and other people's are hidden. */
  shown: boolean
  /** When its events were last brought up to date, or null before the first full read ends. */
  readAt: number | null
  /** A sentence when the last read of this calendar failed. */
  problem: string | null
  /** A quiet sentence when Google would not make this calendar's push channel: it still reads, by the slow safety resync, and says so. Null when push works (or the calendar is hidden). */
  note: string | null
}

/** One account in Settings › Calendars: its calendars, and one amber sentence when the view of it is not whole. */
export interface CalendarAccountView {
  address: string
  label: string
  /** The account's colour slot, 0 to 5: events of the account are drawn in it. */
  hue: number
  /** The grant also lets the calendar create and change events. False for an account connected for reading only (Connect calendar again adds it); only meaningful when `state` is live or syncing. */
  events: boolean
  state: CalendarAccountState
  /** The one sentence for an account whose events are not current (lapsed, needing the calendar permission, disconnected), or null. */
  reason: string | null
  /** When any of its shown calendars was last brought up to date. */
  readAt: number | null
  /** A quiet sentence when Google would not make the push channel for the account's list of calendars (a new calendar is then found by the slow safety resync). Null otherwise. */
  note: string | null
  calendars: CalendarView[]
}

/** The part of an account an event wears. */
export interface CalendarAccountMark {
  address: string
  label: string
  hue: number
}

export const CALENDAR_RESPONSES = ['accepted', 'declined', 'tentative', 'needsAction'] as const
export type CalendarResponse = (typeof CALENDAR_RESPONSES)[number]

export interface CalendarGuest {
  name: string | null
  email: string | null
  response: CalendarResponse
  organizer: boolean
  /** This guest is the account's own address. */
  self: boolean
}

/** An event. The same meeting in two of the owner's calendars is ONE event naming both accounts (Google gives copies one iCalendar id). */
export interface CalendarEvent {
  /** The event's key in the store (its calendar's key and Google's event id): what the card is opened by. Opaque to the page. */
  id: string
  title: string
  /** When it starts and ends, milliseconds. For an all-day event: midnight to midnight on the company's clock. */
  start: number
  end: number
  allDay: boolean
  /** For an all-day event, its first day and its LAST day (inclusive) as `YYYY-MM-DD`; null for a timed one. */
  startDate: string | null
  endDate: string | null
  location: string | null
  /** The video call link Google holds for it (an https address), or null. */
  videoLink: string | null
  /** The event in Google Calendar (an https address on Google's own host), or null. */
  htmlLink: string | null
  /** Plain text, at most `CALENDAR_DESCRIPTION_MAX` characters. */
  description: string | null
  /** `tentative` is an event Google marks as such. A cancelled event is never here. */
  status: 'confirmed' | 'tentative'
  /** How the account's own address answered, or null when it was not invited (its own event). `needsAction` is "not answered". */
  response: CalendarResponse | null
  organizer: { name: string | null; email: string | null } | null
  guests: CalendarGuest[]
  /** More guests than `CALENDAR_GUESTS_MAX`: the rest are left out. */
  guestsLeft: number
  /** Every account that holds a copy, the first being the one drawn. */
  accounts: CalendarAccountMark[]
  /** Free time, not busy (Google's "show as available"). */
  free: boolean
  /** Brought up to date at, the oldest of the copies' calendars: an old time is drawn as such. */
  readAt: number | null
  /** The account that holds it is lapsed or disconnected: this is the last picture of it. */
  stale: boolean
}

export const CALENDAR_DESCRIPTION_MAX = 2000
export const CALENDAR_GUESTS_MAX = 50

/** An account as the agenda names it: enough to draw the amber line and the legend. */
export interface CalendarAgendaAccount extends CalendarAccountMark {
  state: CalendarAccountState
  reason: string | null
  readAt: number | null
}

/** The events between two moments, merged across the shown calendars of every account, earliest first. */
export interface CalendarAgenda {
  from: number
  to: number
  events: CalendarEvent[]
  accounts: CalendarAgendaAccount[]
}

/**
 * The widest span an agenda is asked for (a month grid of six weeks is 42 days; the agenda's longest read is 60), and how far back and ahead the store reaches: 92 days back, so the month before last is
 * mostly there when a month grid is paged backward, and 180 ahead. An agenda asked for outside what the store holds is answered with what it has (nothing, for a week never read); only a span wider than
 * `CALENDAR_WINDOW_MAX_MS` or backward is `bad-request`.
 */
export const CALENDAR_WINDOW_MAX_MS = 62 * 24 * 60 * 60 * 1000
export const CALENDAR_BACK_MS = 92 * 24 * 60 * 60 * 1000
export const CALENDAR_AHEAD_MS = 180 * 24 * 60 * 60 * 1000

/**
 * One event a mail's calendar part names, to be found in the calendar's copy: by its iCalendar id (`CalendarSummary.uid`), and, for a part about ONE occurrence of a repeating event, by which (`CalendarSummary.occurrence`: its moment, or its
 * day for an all-day event). With no occurrence, a repeating event is found at its next occurrence from now, else its latest.
 */
export interface CalendarEventAsk {
  uid: string
  occurrence: { at: number | null; date: string | null } | null
}

/** The most events one `eventsByUid` is asked for (a page of a conversation holds at most 50 messages), and the longest iCalendar id taken. */
export const CALENDAR_BY_UID_MOST = 50
export const CALENDAR_UID_MAX = 1024

// ── The busy blocks (the space's ADR 0024) ───────────────────────────────────────────────────────────────────────────────────────

/** What a block says: nothing of the meeting it stands for. */
export const CALENDAR_BLOCK_TITLE = 'Busy'
/** A block is made for a meeting that starts within this long from now (and has not ended); a meeting further out is blocked when it comes inside. */
export const CALENDAR_BLOCK_AHEAD_MS = 60 * 24 * 60 * 60 * 1000

/** Which button cures an account's trouble in Settings: its sign-in ended (Connect again), or it lacks the permission to change events (Connect calendar). */
export type CalendarBlockingFix = 'connect-again' | 'connect-calendar'

/** One account in the blocking setting. */
export interface CalendarBlockingAccount {
  address: string
  label: string
  hue: number
  /** The owner's choice: the account gives its busy times and receives blocks. Every connected account takes part at first. */
  takesPart: boolean
  /** One sentence when the account is chosen and cannot take part now (its sign-in ended, it lacks the permission to change events, its main calendar is not read), else null. */
  skipped: string | null
  /** The button that cures `skipped`, or null (nothing to press: a main calendar that is hidden is the owner's choice, shown in the list above). */
  fix: CalendarBlockingFix | null
}

/** How the owner's other calendars are kept busy, as Settings, Calendars shows it. */
export interface CalendarBlocking {
  /** The one switch. Off at first; only the owner flips it. */
  on: boolean
  /** How many blocks are held that have not ended. */
  kept: number
  /** One sentence when blocks could not be written or removed, else null. */
  problem: string | null
  accounts: CalendarBlockingAccount[]
}

/** What the space calls in-process for the Calendar tab, Today's events and Settings › Calendars. Owner only. */
export interface CalendarForSpace {
  /** The accounts and their calendars. Asks the inbox who is connected first (a few seconds old at most). */
  calendars(asker: SignedIn): Promise<SpaceReply<CalendarAccountView[]>>
  /** The events from `from` (inclusive) to `to` (exclusive), from the store. */
  agenda(asker: SignedIn, from: number, to: number): Promise<SpaceReply<CalendarAgenda>>
  /** One event by its key, from the store. `not-found` once it is gone. */
  event(asker: SignedIn, id: string): Promise<SpaceReply<CalendarEvent>>
  /**
   * The events a conversation's calendar mail names, by iCalendar id, from the store: one answer per ask, in order, `null` for an event the calendar does not hold (not a connected account's, in a hidden calendar, outside the three months back
   * and six ahead it keeps, or gone). The one read the space joins an email's card to the owner's Calendar tab with ("Open in Calendar", and the title and time a bare answer leaves out). Owner only like the rest, and a read: nothing is asked of Google.
   * At most `CALENDAR_BY_UID_MOST` asks; more is `bad-request`.
   */
  eventsByUid(asker: SignedIn, asks: readonly CalendarEventAsk[]): Promise<SpaceReply<(CalendarEvent | null)[]>>
  /** Show or hide a calendar. Showing reads it in full; hiding drops its events from the store. Answers the calendar as it now stands. */
  setShown(asker: SignedIn, calendarId: string, shown: boolean): Promise<SpaceReply<CalendarView>>
  /** Ask for every account's calendars to be read again now (the alarm does it in a moment). Answers how many calendars were asked. */
  syncNow(asker: SignedIn): Promise<SpaceReply<{ asked: number }>>
  /** How the busy blocks stand: the switch, each account's part in it and why one cannot take part, how many blocks are held, and a sentence when they could not be written. */
  blocking(asker: SignedIn): Promise<SpaceReply<CalendarBlocking>>
  /** Turn the busy blocks on or off. A setting only: the alarm makes or removes the blocks in a moment (the space's ADR 0024). Answers how it now stands. */
  setBlocking(asker: SignedIn, on: boolean): Promise<SpaceReply<CalendarBlocking>>
  /** Take an account in or out of the blocks (both ways: it gives its busy times and receives blocks). `not-found` for an address that is not an account. Answers how it now stands. */
  setBlockingAccount(asker: SignedIn, address: string, takesPart: boolean): Promise<SpaceReply<CalendarBlocking>>
  /** The booking links (the space's ADR 0025) with each one's rules, why it cannot be booked now if it cannot, and its upcoming and recent bookings. Settings only: nothing here asks Google. */
  bookingLinks(asker: SignedIn): Promise<SpaceReply<CalendarBookingLinks>>
  /** Make a booking link. A setting only: no event is made until a visitor books. `bad-request` says which field is wrong. */
  makeBookingLink(asker: SignedIn, input: BookingLinkInput): Promise<SpaceReply<BookingLinkView>>
  /** Change a link (its rules, its account, whether it is on). Bookings already made are not touched. `not-found` for a link that is gone. */
  changeBookingLink(asker: SignedIn, id: string, input: BookingLinkInput): Promise<SpaceReply<BookingLinkView>>
  /** Delete a link. It books nothing from now on; the bookings it made stay as ordinary events, and their visitors can still cancel from their invitation. */
  deleteBookingLink(asker: SignedIn, id: string): Promise<SpaceReply<{ id: string }>>
}

/** The method names, so a stub, a test and the binding agree on exactly these and no others. */
export const CALENDAR_FOR_SPACE_METHODS = ['calendars', 'agenda', 'event', 'eventsByUid', 'setShown', 'syncNow', 'blocking', 'setBlocking', 'setBlockingAccount', 'bookingLinks', 'makeBookingLink', 'changeBookingLink', 'deleteBookingLink'] as const satisfies readonly (keyof CalendarForSpace)[]

// ── What Claude's script does with the calendar, through the inbox (the space's ADR 0023) ────────────────────────────────────────────

/** The most guests one invite names (Google allows far more; an invite sent from a session stays a meeting and not a mailing), and the longest title it carries. */
export const CALENDAR_INVITE_GUESTS_MAX = 50
export const CALENDAR_INVITE_TITLE_MAX = 300
/** The longest an event Claude makes or moves may run: a day and a half is a conference, and past it is a mistake in a date. */
export const CALENDAR_INVITE_LONGEST_MS = 36 * 60 * 60 * 1000

/** An account as Claude reads it: whether the calendar is current for it, and whether an invite can be made on it. */
export interface CalendarClaudeAccount {
  address: string
  label: string
  state: CalendarAccountState
  /** The one sentence for an account whose events are not current, or null. */
  reason: string | null
  /** The grant also lets the calendar create and change events (`CalendarGrant.events`): an invite, a move or a cancellation on this account is possible. */
  canEdit: boolean
}

/** An event as Claude reads it: the event as the Calendar tab shows it, and whether it blocks the owner's time. */
export interface CalendarClaudeEvent extends CalendarEvent {
  /**
   * Whether the owner is busy: false for an event Google marks as free time (transparent) and for one the owner declined; true for everything else, a tentative event and one not yet answered included. The same meeting in two
   * of the owner's calendars is free only when it is free in each.
   */
  busy: boolean
}

/** The events Claude reads between two moments, from the store (nothing is asked of Google), with the accounts they come from. */
export interface CalendarClaudeAgenda {
  from: number
  to: number
  accounts: CalendarClaudeAccount[]
  events: CalendarClaudeEvent[]
}

/** An invite Claude makes: on one connected account's primary calendar, Google sending the invitations. Each field is checked by the face; times are moments (ms). */
export interface CalendarInvite {
  /** The account's address, as `events` lists it under `accounts`. */
  account: string
  title: string
  start: number
  end: number
  /** The guests' addresses (the account's own is dropped). */
  guests: string[]
  description: string | null
  /** A Google Meet link on the event. */
  meet: boolean
}

/** The new time of an event Claude moves. */
export interface CalendarMove {
  start: number
  end: number
}

/** What an invite or a move answers: the event as Google now has it. */
export interface CalendarEventMade {
  /** The event's key in the calendar's store: what `move` and `cancel` take, and what `events` prints as `id`. */
  id: string
  /** Google's id for it. */
  eventId: string
  account: string
  title: string
  start: number
  end: number
  guests: string[]
  /** The event in Google Calendar, or null. */
  link: string | null
  /** The Meet link, or null (asked for and not yet attached by Google, or not asked for). */
  meetLink: string | null
  /** The event is in the calendar's store now, so `events` shows it at once. False when the account's primary calendar is not one the store keeps: the next read of it finds the event within moments. */
  stored: boolean
}

/** What a cancellation answers. */
export interface CalendarEventCancelled {
  id: string
  eventId: string
  account: string
  title: string
}

/**
 * The calendar as the inbox is given it, IN-PROCESS (the space's ADR 0023), the way it is given the Clients and the knowledge app: for Claude's script, through the inbox's router, and for nothing else. It takes no person. The ONE
 * RULE that stands in front of the three writes is the inbox's, in its router, before any of them is asked: the owner's switch is on and the call carries the owner's instruction, which the inbox records. The face can be reached
 * only from there, because only the inbox's part is handed it (packages/space/src/parts.ts). It is the send rule for mail, applied again; the calendar does not decide it.
 *
 * `events` reads the store and never Google. Each write asks Google once, with an access token for `calendar.events` alone, asked of the inbox for that call and not kept, and Google sends the invitations (`sendUpdates=all`).
 * Each answers a `SpaceReply` as data. An account that cannot take a write (disconnected, lapsed, without the permission) is `conflict`, with the inbox's own sentence.
 */
export interface CalendarForInbox {
  events(from: number, to: number): Promise<SpaceReply<CalendarClaudeAgenda>>
  invite(input: CalendarInvite): Promise<SpaceReply<CalendarEventMade>>
  /** Move an event the account organises. `id` is the key `events` or an earlier invite printed. */
  move(id: string, input: CalendarMove): Promise<SpaceReply<CalendarEventMade>>
  /** Delete an event the account organises, Google telling the guests. */
  cancel(id: string): Promise<SpaceReply<CalendarEventCancelled>>
}

export const CALENDAR_FOR_INBOX_METHODS = ['events', 'invite', 'move', 'cancel'] as const satisfies readonly (keyof CalendarForInbox)[]

// ── Booking links (the space's ADR 0025) ─────────────────────────────────────────────────────────────────────────────────────────

/** The days of a link's week, Monday first, as the owner sets the hours of each. */
export const BOOKING_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type BookingWeekday = (typeof BOOKING_WEEKDAYS)[number]

/** One stretch of a day a link can be booked in, in minutes after midnight on the company's clock: a meeting may start at `from` or later and must END by `to`. */
export interface BookingSpan {
  from: number
  to: number
}

/** The hours of each weekday: none for a day it cannot be booked. */
export type BookingHours = Record<BookingWeekday, BookingSpan[]>

/** What a link lets a visitor book, besides its length: the hours of each weekday (on the company's clock), the least notice, how far ahead, the gap kept around other meetings, and an optional most-per-day. */
export interface BookingRules {
  hours: BookingHours
  /** The least time between now and a meeting's start, in minutes. */
  noticeMinutes: number
  /** How many days ahead a meeting may be booked. */
  aheadDays: number
  /** The gap kept before and after any other meeting, in minutes. */
  gapMinutes: number
  /** The most meetings one day of this link holds, or null for no limit. */
  perDay: number | null
}

/** The limits of what a link, a visitor's words and a visitor's use of the page may be. One list, for the calendar, the page and the tests. */
export const BOOKING_LIMITS = {
  /** A link's name and description, as the visitor reads them. */
  nameMax: 80,
  descriptionMax: 600,
  /** The last part of a link's address. */
  slugMin: 3,
  slugMax: 40,
  /** A meeting's length, in minutes. */
  minutesMin: 5,
  minutesMax: 240,
  noticeMaxMinutes: 30 * 24 * 60,
  aheadMaxDays: 90,
  gapMaxMinutes: 120,
  perDayMax: 20,
  spansPerDayMax: 4,
  /** The most links one install holds. */
  linksMax: 20,
  /** A visitor's name and note. */
  visitorNameMax: 80,
  visitorNoteMax: 1000,
  /**
   * What keeps a link from being used to send invitations to people who did not ask: in any 24 hours, one visitor's address is invited at most `perVisitor` times (and holds at most `upcomingPerVisitor` meetings that have not ended), one network address
   * makes at most `perNetwork` bookings, and one link takes at most `perLink`. A booking is moved at most `moves` times.
   */
  perVisitor: 3,
  upcomingPerVisitor: 5,
  perNetwork: 10,
  perLink: 30,
  moves: 3,
} as const

/** The slugs a link cannot take: the open path's own folders. */
export const BOOKING_RESERVED_SLUGS = ['api', '_', 'manage', 'm'] as const

/**
 * Where a link's meetings are held (the space's ADR 0026): on Google Meet (every link made before, and the default), or in a call of the space's own Meet, made for the booking, with its link in the invitation where Google's Meet link would be. The second is offered
 * only where the install has calls switched on.
 */
export const BOOKING_WHERES = ['meet', 'space'] as const
export type BookingWhere = (typeof BOOKING_WHERES)[number]

/** A call made for a booking is open to new people from this long before the booked start to this long after its end (people already in carry on); it is closed when the booking is cancelled. */
export const BOOKING_CALL_OPENS_BEFORE_MS = 30 * 60_000
export const BOOKING_CALL_CLOSES_AFTER_MS = 2 * 60 * 60_000

/** What a new link starts as (Monday to Friday, 9am to 5pm; four hours' notice, thirty days ahead, fifteen minutes around other meetings, no daily limit, thirty minutes long). */
export const BOOKING_DEFAULTS: BookingRules & { minutes: number } = {
  minutes: 30,
  hours: { mon: [{ from: 540, to: 1020 }], tue: [{ from: 540, to: 1020 }], wed: [{ from: 540, to: 1020 }], thu: [{ from: 540, to: 1020 }], fri: [{ from: 540, to: 1020 }], sat: [], sun: [] },
  noticeMinutes: 240,
  aheadDays: 30,
  gapMinutes: 15,
  perDay: null,
}

/** The path of a link's page on the space's host, and of a booking's own page (the secret is the visitor's alone). */
export const bookingLinkPath = (slug: string): string => `/book/${slug}`
export const bookingManagePath = (secret: string): string => `/book/manage/${secret}`

/** What the owner sets for a link. The same fields make and change one. */
export interface BookingLinkInput extends BookingRules {
  /** The last part of the address, lower case letters, digits and hyphens. */
  slug: string
  /** What the visitor reads as the link's name ("Intro call"); it is also the title of the event, with the visitor's name. */
  name: string
  description: string
  /** The Google account whose own calendar a booking is made on. */
  account: string
  minutes: number
  enabled: boolean
  /** Where its meetings are held. Left out: Google Meet. */
  where?: BookingWhere
}

/** What a booking is, to the owner. `pending`: the time is held and Google has not said (it is looked for in the next reads and let go after an hour); `removed`: the event is no longer in the calendar (the owner cancelled it there). */
export const BOOKING_STATES = ['pending', 'booked', 'cancelled', 'removed'] as const
export type BookingState = (typeof BOOKING_STATES)[number]

/** One booking, as Settings lists it under its link: who, when, and when it was booked. */
export interface BookingRecord {
  id: string
  /** Where it was booked to be held: a booking keeps what it was booked with, whatever the link says now. */
  where: BookingWhere
  /** The link's name when it was booked (a renamed link keeps the old one here). */
  linkName: string
  name: string
  email: string
  note: string | null
  start: number
  end: number
  bookedAt: number
  state: BookingState
  /** How the time was checked at the moment of booking: with Google (`google`), or, for an account Google could not be asked about, against the calendar's own copy of it (`copy`). */
  checked: 'google' | 'copy'
  /** The event in Google Calendar, or null. */
  link: string | null
}

/** One link in Settings: what the owner set, whether it can be booked now (and why not), the address, and its bookings. */
export interface BookingLinkView extends Omit<BookingLinkInput, 'where'> {
  id: string
  where: BookingWhere
  accountLabel: string
  /** The address the owner sends: the space's host and `bookingLinkPath(slug)`. */
  url: string
  /** Why the link cannot be booked now, in the owner's words (its account's sign-in ended, it cannot change events, its main calendar is hidden or not read yet), else null. */
  problem: string | null
  /** The most recent bookings, upcoming first: those that have not ended, then those of the last 30 days. */
  bookings: BookingRecord[]
}

/** The Booking links card: every link, the accounts a link can be made on, and what a new one starts as. */
export interface CalendarBookingLinks {
  links: BookingLinkView[]
  accounts: { address: string; label: string; canBook: boolean; why: string | null }[]
  defaults: BookingRules & { minutes: number }
  /** The company's time zone: the hours are on its clock. */
  zone: string
  /** `https://<space host>`, which a link's address is made from. */
  origin: string
  /** Whether a link can be held in a call in the space: the install has calls switched on and the calendar was handed a way to make one. Only then is "Where" offered. */
  calls: boolean
}

// ── What a visitor is shown and may do (the open path's face) ────────────────────────────────────────────────────────────────────

/** A link as a visitor sees it. Nothing of the owner's calendars is in it. */
export interface GuestBookingLink {
  company: string
  name: string
  description: string
  minutes: number
  /** The company's clock, which the hours are on. */
  zone: string
  /** False for a link that is turned off or whose account cannot be written to (or, for a link held in the space's call, where no call can be made now): the page then says it cannot be booked right now. */
  open: boolean
  /** Where its meetings are held, so the page can say so. */
  where: BookingWhere
}

/** The starting times a link offers, in order (milliseconds), and the span they cover. A time is free only: nothing says what the owner is doing otherwise. */
export interface GuestBookingSlots {
  from: number
  to: number
  starts: number[]
}

/** What a visitor gives to book. */
export interface GuestBookingInput {
  /** One of the starting times the link offered. */
  start: number
  name: string
  email: string
  note: string
}

/** What a visitor's booking page shows. `pending`: the invitation is not confirmed yet (Google has not answered); `removed`: the host removed it from their calendar; `past`: it has been. */
export interface GuestBookingView {
  company: string
  /** The link's name when it was booked. */
  title: string
  slug: string | null
  minutes: number
  start: number
  end: number
  name: string
  email: string
  state: 'booked' | 'pending' | 'cancelled' | 'removed' | 'past'
  zone: string
  /** Where it is held: Google Meet, or a call in the space (a video call in the browser, no account needed). */
  where: BookingWhere
  /** The link to join: the Google Meet link, or the call's address on the space's host. Null while there is none yet. */
  meetLink: string | null
  canMove: boolean
  canCancel: boolean
  /** The link is still open, so another time can be picked. */
  linkOpen: boolean
}

/** What a booking answers: the booking's own page, with the secret that is its address (shown once: the calendar keeps only a hash of it). */
export interface GuestBooked {
  secret: string
  booking: GuestBookingView
}

/**
 * The calendar as the OPEN PATH is given it (the space's ADR 0025): for the visitor of a booking link and for nothing else. It takes NO PERSON, because a visitor is nobody the space knows: what lets a visitor do anything is the link's address
 * (public, and the owner's word that it may be booked) or a booking's own secret (the one thing that moves or cancels it). It is handed to the guest door of the space's Worker (packages/space/src/booking.ts) and to nothing else, never to the inbox,
 * and it is the third thing in the calendar that writes an event to Google, after Claude's three writes and the owner's busy blocks: a booking makes, moves and deletes the one event it is, and Google sends the guest the invitation.
 * `network` is the visitor's network address as the edge gave it; the calendar keeps only a keyed hash of it, to limit use of the page.
 */
export interface CalendarForGuests {
  link(slug: string): Promise<SpaceReply<GuestBookingLink>>
  slots(slug: string): Promise<SpaceReply<GuestBookingSlots>>
  book(slug: string, input: GuestBookingInput, network: string): Promise<SpaceReply<GuestBooked>>
  booking(secret: string): Promise<SpaceReply<GuestBookingView>>
  /** The times a booking can be moved to: the link's own, with the booking's own time counted as free. */
  bookingSlots(secret: string): Promise<SpaceReply<GuestBookingSlots>>
  move(secret: string, start: number): Promise<SpaceReply<GuestBookingView>>
  cancel(secret: string): Promise<SpaceReply<GuestBookingView>>
}

export const CALENDAR_FOR_GUESTS_METHODS = ['link', 'slots', 'book', 'booking', 'bookingSlots', 'move', 'cancel'] as const satisfies readonly (keyof CalendarForGuests)[]

// ── Holding a booking's meeting in the space's own call (the space's ADR 0026) ──────────────────────────────────────────────────

/**
 * What the calendar is handed to hold a booking in a call of the space's Meet: to make one, move its window with the booking, and close it when the booking is cancelled. The calendar NEVER IMPORTS MEET: the space's Worker makes this over Meet's code and gives it to the
 * calendar's object (packages/space/src/calendar-do.ts), as the inbox's are given what a part needs from outside. It takes no person and acts as the install's declared owner, which is the point and the whole of the rule it is under: a booking link the owner made, left on
 * and set to the space call is the owner's word for exactly one call per booking, as it already is for one event and invitation. The call it makes is open only around the booked time, and only a call made here can be moved or closed here: no other call can.
 * Each method answers data and never throws for a refusal; a fault (the object did not answer) is thrown, and the calendar reads it as an outcome nobody knows.
 */
export interface BookingCalls {
  /** Whether the install has calls switched on: only then is "Where" offered for a link. */
  readonly on: boolean
  /** Whether a call can be made now: the install has calls and this month's allowance is not used up. `why` is in the owner's words. */
  check(): Promise<{ ok: true } | { ok: false; why: string }>
  /** Make the call for a booking, once for each `key` (the booking's own id, so a retry makes none): a meeting titled `title` at `startsAt` for the guest, open from `opensAt` to `closesAt`. `link` is its address on the space's host. */
  make(call: { key: string; title: string; startsAt: number; guest: { name: string; email: string }; opensAt: number; closesAt: number }): Promise<{ ok: true; name: string; link: string } | { ok: false; why: string }>
  /** The booking moved: the same call and link, at the new time. */
  move(name: string, when: { startsAt: number; opensAt: number; closesAt: number }): Promise<{ ok: true } | { ok: false; why: string }>
  /** The booking was cancelled (or never made): the call's link says there is no such call from now on. People already in carry on. Closing twice is the same as once. */
  close(name: string): Promise<{ ok: true } | { ok: false; why: string }>
}
