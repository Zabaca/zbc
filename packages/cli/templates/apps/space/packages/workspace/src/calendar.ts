// What the calendar app answers: the interface of its one face, method by method (the package is packages/calendar).
//
// THE CALENDAR KEEPS ITS OWN COPY. Google's calendars are synced into the calendar's store (a first full read, then changes from Google's sync token, woken by Google's push notifications), the way the
// inbox holds mail. Every method here reads that store and none asks Google, so the tab and Today are as quick as the space and a Google outage shows as an old picture marked with when it was read.
//
// ONE FACE, for the space (`CalendarForSpace`): it runs INSIDE the space's Worker (the company layer's ADR 0003), over a store the Worker owns, and EVERY METHOD takes the person the space's one sign-in
// check named (`SignedIn`), then admits the install's owner and no one else (the accounts are the owner's). A service token is never a person, so none comes through. Claude has no door to it
// (the company layer's ADR 0002: Claude's one path leads to the inbox).
//
// TIMES are milliseconds since the epoch; an all-day event is also given as its calendar days, because it has no hour (Google gives it a date, and the days must not move with the reader's zone).
// EVENT TEXT IS UNTRUSTED (a title, a place, a description and a guest's name are whatever the organiser typed): the page draws it as text, never as markup.

import type { SignedIn, SpaceReply } from './asking'

/** The path of Google's push notifications, on the push host (the hostname the inbox's Gmail push already uses): `https://<push host>/calendar/push`. Answered by the space's Worker, which hands it to the calendar. */
export const CALENDAR_PUSH_PATH = '/calendar/push'

/** The Google permission that READS calendars. It is what "the calendar is connected" requires, and the only one the calendar's sync is ever handed a token for. */
export const CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'

/**
 * The Google permission that creates, changes and deletes events (asked with the reading one, once per account, so a later booking feature needs no second consent). Not the full `calendar` scope. Connect calendar
 * asks for it beside `CALENDAR_READONLY_SCOPE`; nothing uses it yet, and a grant that has the reading permission without it is connected for reading all the same (see `CalendarGrant.events`).
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
 * What a token from the inbox may do: `read` (the default and the only one the calendar's sync asks for: `calendar.readonly` alone) or `events` (`calendar.events` alone, to create and change events). A seam for a booking feature, used by
 * nothing yet; each is asked of Google as a scope of its own, so a token for one never carries the other.
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
}

/** The method names, so a stub, a test and the binding agree on exactly these and no others. */
export const CALENDAR_FOR_SPACE_METHODS = ['calendars', 'agenda', 'event', 'eventsByUid', 'setShown', 'syncNow'] as const satisfies readonly (keyof CalendarForSpace)[]
