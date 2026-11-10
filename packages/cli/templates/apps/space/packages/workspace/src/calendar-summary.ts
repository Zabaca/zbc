// What an email's calendar part says, kept short: the summary the inbox reads ONCE when the mail arrives (packages/inbox/src/calendar-summary.ts), keeps on the message, and hands to the space and to Claude's script, and the
// words every one of them says it in. A card in a conversation (an invitation, an update, a cancellation, a guest's answer), the line under a list row, and the line Claude's script prints are the same sentences, written here once.
//
// MAIL IS UNTRUSTED INPUT. A calendar part is a stranger's text: every string in a summary was cut to a length and stripped of control characters by the reader, no link is kept, and a page draws all of it as text. Nothing here follows or runs anything.
// TIMES are moments (milliseconds since the epoch) when the part's time could be resolved; an all-day event has days and no hour; a time the reader could not resolve is kept as written, with the zone it named, and said so: never guessed.
// Pure: no I/O and no clock of its own, so the wording is a table test.

import { wallAt } from './zoned'

/** What the calendar part is, from its method and sequence: a first invitation, an update of one, a cancellation, a guest's answer, or anything else with an event in it (a booking site's "add to calendar" file). */
export const CALENDAR_SUMMARY_KINDS = ['invitation', 'update', 'cancelled', 'reply', 'event'] as const
export type CalendarSummaryKind = (typeof CALENDAR_SUMMARY_KINDS)[number]

/** A guest's answer: yes, no, maybe, or "how about this time instead" (`counter`, whose time is the one proposed). */
export const CALENDAR_SUMMARY_ANSWERS = ['accepted', 'declined', 'tentative', 'counter'] as const
export type CalendarSummaryAnswer = (typeof CALENDAR_SUMMARY_ANSWERS)[number]

/** Longest text kept of each field, in characters, after control characters are removed. */
export const CALENDAR_SUMMARY_LIMITS = { title: 200, place: 200, note: 500, name: 100, address: 320, uid: 300, written: 40, zone: 100 } as const

/** How many guests are kept (the rest are counted in `guestsMore`), and the most bytes of a calendar part that is read at all. */
export const CALENDAR_SUMMARY_GUESTS = 10
export const CALENDAR_SUMMARY_PART_MAX = 256 * 1024

/** The farthest a moment may be from the epoch, in milliseconds: the range of a JavaScript Date. A time outside it cannot be worded (formatting it throws), so the reader drops it and the guard refuses it. */
export const CALENDAR_SUMMARY_MOMENT_MAX = 8.64e15

/** A person on an event, as the part names them: the name it gave (or their address when it gave none) and the address. */
export interface CalendarPerson {
  name: string
  address: string
}

/** A time the reader could not resolve to a moment: as written (`2026-11-13T10:00`), with the zone the part named (`Customized Time Zone`) or null for a floating time. */
export interface CalendarWritten {
  start: string
  end: string | null
  zone: string | null
}

/** The one occurrence of a repeating event a part is about: its day (all-day events, and a time that could not be resolved) or its moment. */
export interface CalendarOccurrence {
  at: number | null
  date: string | null
}

/**
 * What one calendar part says of the first event in it. Stored on the message as JSON (the inbox's migration 20), at most a few kilobytes (the limits above). `moreEvents` counts the other events the part holds,
 * and says nothing of them.
 */
export interface CalendarSummary {
  kind: CalendarSummaryKind
  /** Only on a `reply`: how the guest answered. */
  answer?: CalendarSummaryAnswer
  /** Only on a `reply`: who answered. */
  by?: CalendarPerson
  /** Only on a `reply`: what the guest wrote with the answer, in their words. */
  note?: string
  title: string
  allDay: boolean
  /** The moments the event starts and ends (a counter proposal's are the proposed ones); null for an all-day event and for a time that is `written`. */
  start: number | null
  end: number | null
  /** An all-day event's first day and its LAST day (inclusive), as `YYYY-MM-DD`; null for a timed event. */
  startDate: string | null
  endDate: string | null
  written: CalendarWritten | null
  location: string
  organizer: CalendarPerson | null
  guests: CalendarPerson[]
  guestsMore: number
  repeats: boolean
  occurrence: CalendarOccurrence | null
  /** The iCalendar id (UID): what the Calendar tab's copy of the event is found by. */
  uid: string
  moreEvents: number
}

/** A summary as the inbox hands it to the space: with whether the organizer is the person asking ("From you"). */
export interface InboxCalendar extends CalendarSummary {
  fromYou: boolean
}

// ── Reading what the store or an answer holds back ───────────────────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string'
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const isMoment = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && Math.abs(v) <= CALENDAR_SUMMARY_MOMENT_MAX
const orNull = (v: unknown, ok: (x: unknown) => boolean): boolean => v === null || ok(v)
const isPerson = (v: unknown): v is CalendarPerson => isRecord(v) && isText(v.name) && isText(v.address)
const isDay = (v: unknown): boolean => isText(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
const kinds = new Set<string>(CALENDAR_SUMMARY_KINDS)
const answers = new Set<string>(CALENDAR_SUMMARY_ANSWERS)

/** Whether a value is a summary as the reader writes it. The store's column and the inbox's answer are both read through this, so a row that is not one is no summary and never a throw. */
export function isCalendarSummary(v: unknown): v is CalendarSummary {
  return (
    isRecord(v) &&
    isText(v.kind) &&
    kinds.has(v.kind) &&
    (v.answer === undefined || (isText(v.answer) && answers.has(v.answer))) &&
    (v.by === undefined || isPerson(v.by)) &&
    (v.note === undefined || isText(v.note)) &&
    isText(v.title) &&
    typeof v.allDay === 'boolean' &&
    orNull(v.start, isMoment) &&
    orNull(v.end, isMoment) &&
    orNull(v.startDate, isDay) &&
    orNull(v.endDate, isDay) &&
    orNull(v.written, (w) => isRecord(w) && isText(w.start) && orNull(w.end, isText) && orNull(w.zone, isText)) &&
    isText(v.location) &&
    orNull(v.organizer, isPerson) &&
    Array.isArray(v.guests) &&
    v.guests.every(isPerson) &&
    isCount(v.guestsMore) &&
    typeof v.repeats === 'boolean' &&
    orNull(v.occurrence, (o) => isRecord(o) && orNull(o.at, isMoment) && orNull(o.date, isDay)) &&
    isText(v.uid) &&
    isCount(v.moreEvents)
  )
}

/** A summary an inbox answer carries: the summary and whether it is from the person asking. */
export const isInboxCalendar = (v: unknown): v is InboxCalendar => isCalendarSummary(v) && typeof (v as unknown as Record<string, unknown>).fromYou === 'boolean'

/** The summary a stored column holds, or null for no column, a column that says it was looked at and held none (`none`), and one that is not a summary. */
export function parseCalendarSummary(stored: unknown): CalendarSummary | null {
  if (typeof stored !== 'string' || stored === '' || stored === 'none') return null
  try {
    const parsed: unknown = JSON.parse(stored)
    return isCalendarSummary(parsed) ? parsed : null
  } catch {
    return null
  }
}

// ── The words ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Whose answer it is: the name the part gave, else the address, else "A guest". */
export const answererOf = (s: Pick<CalendarSummary, 'by'>): string => (s.by === undefined ? 'A guest' : s.by.name !== '' ? s.by.name : s.by.address !== '' ? s.by.address : 'A guest')

/** What a card heads itself with, without a time: "Invitation", "Updated invitation", "Cancelled", "Event", "Ana accepted", "Ana declined", "Ana said maybe", "Ana proposed a new time". */
export function summaryHeading(s: CalendarSummary): string {
  switch (s.kind) {
    case 'invitation':
      return 'Invitation'
    case 'update':
      return 'Updated invitation'
    case 'cancelled':
      return 'Cancelled'
    case 'event':
      return 'Event'
    case 'reply': {
      const who = answererOf(s)
      switch (s.answer) {
        case 'accepted':
          return `${who} accepted`
        case 'declined':
          return `${who} declined`
        case 'tentative':
          return `${who} said maybe`
        case 'counter':
          return `${who} proposed a new time`
        default:
          return `${who} answered`
      }
    }
  }
}

const p2 = (n: number): string => String(n).padStart(2, '0')

/** "Thu, Nov 13" from a day `2026-11-13`. A date has no zone: it is read as the day it names. */
export function dayWords(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
}

const clockWords = (ms: number, zone: string): string => new Date(ms).toLocaleTimeString('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' })
const dayKeyAt = (ms: number, zone: string): string => {
  const w = wallAt(ms, zone)
  return `${String(w.y).padStart(4, '0')}-${p2(w.m)}-${p2(w.d)}`
}
const zoneWords = (ms: number, zone: string): string => new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(ms).find((x) => x.type === 'timeZoneName')?.value ?? zone

/** "Thu, Nov 13, 10:00 AM" from `2026-11-13T10:00`, as written. */
function writtenWords(local: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(local)
  if (!m) return local
  const hour = Number(m[2])
  return `${dayWords(m[1] as string)}, ${hour % 12 === 0 ? 12 : hour % 12}:${m[3]} ${hour < 12 ? 'AM' : 'PM'}`
}

/**
 * When the event is, on the company's clock, in the words the Calendar tab's card uses: "Thu, Nov 13, 10:00 AM to 10:30 AM PST" (the day named once, the zone named), "Thu, Nov 13, all day", "Thu, Nov 13 to Sat, Nov 15, all day".
 * A time the reader could not resolve is said as the part wrote it and not converted: "Thu, Nov 13, 10:00 AM to 11:00 AM (the part gave no time zone)", or "(in Customized Time Zone, which the space could not read)". '' when the part gave no time at all.
 */
export function summaryWhen(s: CalendarSummary, zone: string): string {
  if (s.allDay) {
    if (s.startDate === null) return 'All day'
    return `${dayWords(s.startDate)}${s.endDate !== null && s.endDate !== s.startDate ? ` to ${dayWords(s.endDate)}` : ''}, all day`
  }
  if (s.start !== null) {
    const day = new Date(s.start).toLocaleDateString('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' })
    if (s.end === null || s.end <= s.start) return `${day}, ${clockWords(s.start, zone)} ${zoneWords(s.start, zone)}`
    const sameDay = dayKeyAt(s.start, zone) === dayKeyAt(s.end - 1, zone)
    const endDay = new Date(s.end).toLocaleDateString('en-US', { timeZone: zone, month: 'short', day: 'numeric' })
    return `${day}, ${clockWords(s.start, zone)} to ${sameDay ? '' : `${endDay}, `}${clockWords(s.end, zone)} ${zoneWords(s.start, zone)}`
  }
  if (s.written !== null) {
    const start = writtenWords(s.written.start)
    const sameDay = s.written.end !== null && s.written.end.slice(0, 10) === s.written.start.slice(0, 10)
    const end = s.written.end === null ? '' : sameDay ? ` to ${writtenWords(s.written.end).split(', ').slice(-1)[0]}` : ` to ${writtenWords(s.written.end)}`
    const note = s.written.zone === null ? 'the part gave no time zone' : `in ${s.written.zone}, which the space could not read`
    return `${start}${end} (${note})`
  }
  return ''
}

/** Which occurrence of a repeating event a part is about, in words: "the one on Thu, Nov 13". '' when it names none. */
export function occurrenceWords(s: CalendarSummary, zone: string): string {
  const o = s.occurrence
  if (o === null) return ''
  if (o.at !== null) return `the one on ${new Date(o.at).toLocaleDateString('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' })}`
  if (o.date !== null) return `the one on ${dayWords(o.date)}`
  return ''
}

// ── Two things a summary is made ready for its words by (never stored: a summary already kept is covered the same way) ──────────────

/** The person a From header names, or null: the display name (decoded as the inbox stores it, unquoted, on one line, at most 100 characters; '' when the header has none or it is only the address) and the address, lower case. */
export function senderOf(header: string | undefined): CalendarPerson | null {
  const h = (header ?? '').trim()
  if (h === '' || h.length > 600) return null
  const bracketed = /^(.*)<([^<>\s]+)>$/.exec(h)
  const bare = /^[^\s<>@]+@[^\s<>@]+$/.test(h)
  const address = (bracketed ? (bracketed[2] as string) : bare ? h : '').trim().toLowerCase()
  if (address === '' || !address.includes('@')) return null
  const quoted = ((bracketed?.[1] ?? '').trim().replace(/^"(.*)"$/s, '$1').replace(/\\(.)/g, '$1'))
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove control characters
  const name = quoted.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CALENDAR_SUMMARY_LIMITS.name).trim()
  return { name: name.toLowerCase() === address ? '' : name, address }
}

/** The answer words some calendar programs write at the front of an answer's title ("Accepted: Roadmap review"): English, and German as Outlook writes it. */
const ANSWER_TITLE = /^(?:accepted|declined|tentative|angenommen|abgelehnt|mit vorbehalt)\s*:\s*/i

/**
 * What a summary is worded from: the same summary, with (1) a guest or organizer who has no name in the part filled in with the display name of the email's From header when their address is the address the email came from (the
 * name comes from nowhere else: not from the part's own text, not from another message), and (2) for an answer, the answer word and colon another calendar program wrote at the front of the title taken off ("Accepted: Roadmap review" is
 * "Roadmap review", because the heading already says who accepted), unless nothing would be left. An invitation titled "Accepted: ..." is not an answer and is left alone. `from` is the email's From header as the inbox stores it.
 */
export function forWords<T extends CalendarSummary>(s: T, from?: string): T {
  const sender = from === undefined ? null : senderOf(from)
  const named = <P extends CalendarPerson | null | undefined>(p: P): P =>
    p && sender && sender.name !== '' && p.name === '' && p.address !== '' && p.address === sender.address ? { ...p, name: sender.name } : p
  const stripped = s.kind === 'reply' ? s.title.replace(ANSWER_TITLE, '').trim() : s.title
  return {
    ...s,
    title: stripped === '' ? s.title : stripped,
    ...(s.by !== undefined && { by: named(s.by) }),
    organizer: named(s.organizer),
  }
}

/**
 * The one line for a list row whose newest email has no words of its own, and for Claude's script: "Ana accepted: Advisory board intro, Thu, Nov 13, 10:00 AM to 10:30 AM PST". The heading, then the title and the time. A counter
 * proposal's time is the one proposed. Cut to `max` characters (the list's own line is cut at 160).
 */
export function summaryLine(summary: CalendarSummary, zone: string, max = 160, from?: string): string {
  const s = forWords(summary, from)
  const rest = [s.title, summaryWhen(s, zone)].filter((x) => x !== '').join(', ')
  const line = rest === '' ? summaryHeading(s) : `${summaryHeading(s)}: ${rest}`
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`
}

/** "Ana, Ben and Cal" / "Ana, Ben, Cal and 4 more": the guests a card names. */
export function guestsWords(s: Pick<CalendarSummary, 'guests' | 'guestsMore'>): string {
  const names = s.guests.map((g) => (g.name !== '' ? g.name : g.address))
  if (names.length === 0) return s.guestsMore > 0 ? `${s.guestsMore} guest${s.guestsMore === 1 ? '' : 's'}` : ''
  if (s.guestsMore > 0) return `${names.join(', ')} and ${s.guestsMore} more`
  if (names.length === 1) return names[0] as string
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * `summaryLine`, or '' when wording the summary throws (a summary that passed the guard but cannot be said on this clock). A list row, Claude's script and the card use this, so a stored summary can never break a list or a page: the
 * email is then listed and drawn as it was before the summary existed.
 */
export function safeSummaryLine(s: CalendarSummary, zone: string, max = 160, from?: string): string {
  try {
    return summaryLine(s, zone, max, from)
  } catch {
    return ''
  }
}
