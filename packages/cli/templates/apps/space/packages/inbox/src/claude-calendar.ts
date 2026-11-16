/**
 * Claude's calendar, as its script sees it: the words a time is written in, and the shapes the three writes and the read answer with (the space's ADR 0023). Pure, so a test holds each. The router that serves it is `createApp`
 * in src/app.ts, and the calendar behind it is `CalendarForInbox` (the workspace package's `src/calendar.ts`).
 *
 * TIMES go in as ISO text with an offset (`2026-11-17T09:30:00-08:00`, or `Z`), because a time with no offset means a different moment in every zone and Claude must not be left to guess the company's; a READ also takes a plain day
 * (`2026-11-17`), which is that day's midnight on the company's clock. They come out as ISO text on the company's clock with its offset (`isoAt`), so what a person reads and what a script sends are the same words.
 */

import {
  type CalendarClaudeAgenda,
  type CalendarEventCancelled,
  type CalendarEventMade,
  isoAt,
  momentAt,
} from '@space/workspace'

const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i
const A_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** What a bad time is told. */
export const TIME_WORDS =
  'A time is ISO text with an offset, like 2026-11-17T09:30:00-08:00 (or Z for UTC): a time with no offset is not a moment. A read may also name a day, like 2026-11-17, which is that day at midnight on the company’s clock.'

/** The moment (ms) a script's text names, or null for anything that is not one. A day is taken only where `allowDay` says so. */
export function momentOf(raw: unknown, zone: string, allowDay = false): number | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (WITH_OFFSET.test(text)) {
    const at = Date.parse(text)
    return Number.isFinite(at) ? at : null
  }
  const day = allowDay ? A_DAY.exec(text) : null
  if (day) {
    const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])]
    // A date that does not exist (the 31st of November, a thirteenth month) is not read as the next month's first.
    const real = new Date(Date.UTC(y, m - 1, d))
    if (real.getUTCMonth() !== m - 1 || real.getUTCDate() !== d) return null
    return momentAt(y, m, d, 0, 0, zone)
  }
  return null
}

/** The events Claude reads, as text: the times on the company's clock, each event with whether it blocks the owner's time and who answered. A description is left out: it is untrusted text a person typed, and free time does not need it. */
export function agendaOut(a: CalendarClaudeAgenda, zone: string) {
  return {
    zone,
    from: isoAt(a.from, zone),
    to: isoAt(a.to, zone),
    accounts: a.accounts,
    events: a.events.map((e) => ({
      id: e.id,
      title: e.title,
      start: isoAt(e.start, zone),
      end: isoAt(e.end, zone),
      allDay: e.allDay,
      ...(e.allDay && { startDate: e.startDate, endDate: e.endDate }),
      accounts: e.accounts.map((x) => x.address),
      busy: e.busy,
      free: e.free,
      status: e.status,
      response: e.response,
      location: e.location,
      videoLink: e.videoLink,
      htmlLink: e.htmlLink,
      organizer: e.organizer,
      guests: e.guests.map((g) => ({
        name: g.name,
        email: g.email,
        response: g.response,
        organizer: g.organizer,
        self: g.self,
      })),
      guestsLeft: e.guestsLeft,
      stale: e.stale,
    })),
  }
}

/** An event Claude made or moved, as text: the key `move` and `cancel` take, Google's link and the Meet link, and whether `calendar events` shows it already. `meetAsked` is whether a Meet link was asked for (an invite's, unless it said not). */
export function madeOut(w: CalendarEventMade, zone: string, meetAsked = false) {
  return {
    id: w.id,
    eventId: w.eventId,
    account: w.account,
    title: w.title,
    start: w.start === 0 ? null : isoAt(w.start, zone),
    end: w.end === 0 ? null : isoAt(w.end, zone),
    guests: w.guests,
    link: w.link,
    meetLink: w.meetLink,
    stored: w.stored,
    ...(meetAsked &&
      w.meetLink === null && {
        note: 'No Meet link yet: Google attaches it a moment after the event is made, and `calendar events` shows it once it has.',
      }),
  }
}

export function cancelledOut(c: CalendarEventCancelled) {
  return { cancelled: true, id: c.id, eventId: c.eventId, account: c.account, title: c.title }
}

/** The words a write that did not end cleanly is answered with: Google may or may not have done it, so the one safe next step is to look. */
export const OUTCOME_UNKNOWN =
  'The calendar did not say whether Google did that, so it may have been done. Read `calendar events` before trying again, and do not repeat it blindly.'
