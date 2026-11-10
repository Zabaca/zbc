/**
 * What one calendar part says, read ONCE when the email arrives and kept on the message as a short summary (`message.calendar`, migration 20): what the part is (an invitation, an update of one, a cancellation, a guest's answer, or
 * a plain event), the first event's title, time, place, organizer and guests, and how many more events the part holds. The words it is said in, and the type, are the workspace package's (`calendar-summary.ts` there), so the list's line,
 * Claude's script and the space's card say the same sentences. The sibling is `src/calendar-event.ts`, which reads only which event a message is about (so a newer update can close the older ones) and shares its unfolding of lines.
 *
 * ── WHICH PART, AND WHOSE MAIL ───────────────────────────────────────────
 * The first calendar part of the email (declared text/calendar or application/ics, inline or a file, or a file name ending in .ics: `isCalendarPart`). Unlike the event key, a summary is made for EVERY email, a person's included: it closes
 * nothing and hides nothing, so a person's mail is safe to read. What the part is comes from its METHOD and SEQUENCE: REQUEST at sequence 0 an invitation and above it an update, CANCEL a cancellation, REPLY the answering guest's PARTSTAT
 * (accepted, declined, tentative), COUNTER a proposal of another time, anything else with an event in it (PUBLISH, no METHOD) a plain event. A REPLY that carries no answer is read as a plain event.
 *
 * ── TIMES ARE READ TO MOMENTS, OR SAID NOT TO BE ──────────────────────
 * A UTC time; a time in a zone the runtime knows (IANA); a time in a Windows zone name (as Outlook writes them) through `WINDOWS_ZONES`, a fixed table of the common names; else through the offsets the part's own VTIMEZONE block gives (STANDARD
 * and DAYLIGHT, each with the yearly rule it repeats by). A floating time (no zone), or a zone none of these resolves, is kept AS WRITTEN with the zone's name (`written`) and shown so, never guessed. An all-day event has days and no hour.
 *
 * ── MAIL IS UNTRUSTED INPUT ──────────────────────────────────────────────
 * A calendar part is a stranger's text. It is read as data: every text is unescaped, stripped of control characters and cut to a limit (the workspace's `CALENDAR_SUMMARY_LIMITS`); no link is kept (a place that is only a link is not kept, and the
 * URL, attachment and conference properties are never read); at most ten guests are kept and the rest counted; a part over 256 KB is not read; and NOTHING THROWS: a part this cannot read is no summary and the email is stored as it always was.
 * Pure functions over plain text, so the table of parts is a test with no store and no network.
 */

import {
  CALENDAR_SUMMARY_GUESTS,
  CALENDAR_SUMMARY_PART_MAX,
  type CalendarOccurrence,
  type CalendarPerson,
  type CalendarSummary,
  type CalendarSummaryAnswer,
  type CalendarSummaryKind,
  type CalendarWritten,
  CALENDAR_SUMMARY_LIMITS as LIMITS,
  momentAt,
} from '@space/workspace'
import { unfold } from './calendar-event'

/** Whether a part is a calendar part: declared text/calendar or application/ics (parameters ignored), or a file name that ends in .ics. */
export function isCalendarPart(mimeType: string | null | undefined, filename: string | null | undefined): boolean {
  const type = (mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  return type === 'text/calendar' || type === 'application/ics' || /\.ics$/i.test((filename ?? '').trim())
}

/**
 * What `message.calendar` holds for what the reader found: the summary as JSON; `none` for a message looked at that has no summary (so the one-time pass never reads it again, and the list asks nothing of it); and NULL (undefined here) for a message
 * not looked at: one stored by an older build, or one whose part Gmail keeps apart and could not be fetched at arrival. `parseCalendarSummary` (the workspace's) reads it back.
 */
export const NO_SUMMARY = 'none'
export function keptCalendar(found: CalendarSummary | null | undefined): string | null {
  return found === undefined ? null : found === null ? NO_SUMMARY : JSON.stringify(found)
}

// ── Lines ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Line {
  name: string
  params: Record<string, string>
  value: string
}

/** One content line: `NAME;PARAM=x;PARAM="y;z":value`. Null for a line with no name or no colon. */
function parseLine(line: string): Line | null {
  let quoted = false
  let colon = -1
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') quoted = !quoted
    else if (ch === ':' && !quoted) {
      colon = i
      break
    }
  }
  if (colon <= 0) return null
  const parts: string[] = []
  let current = ''
  quoted = false
  for (const ch of line.slice(0, colon)) {
    if (ch === '"') {
      quoted = !quoted
      current += ch
    } else if (ch === ';' && !quoted) {
      parts.push(current)
      current = ''
    } else current += ch
  }
  parts.push(current)
  const params: Record<string, string> = {}
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=')
    if (eq < 1) continue
    let value = part.slice(eq + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    params[part.slice(0, eq).trim().toUpperCase()] = value
  }
  const name = (parts[0] ?? '').trim().toUpperCase()
  return name === '' ? null : { name, params, value: line.slice(colon + 1) }
}

/** A VTIMEZONE's observances, as its block gives them. */
interface Observance {
  /** The wall-clock time (as UTC milliseconds, the way a wall time is compared) of its first onset. */
  onset: number
  /** The offset before and after it, in milliseconds east of UTC. */
  from: number
  to: number
  /** The yearly rule it repeats by (a month and the nth weekday in it), when it has one this reads. */
  rule: { month: number; nth: number; weekday: number } | null
}

interface Parsed {
  method: string
  events: Line[][]
  zones: Map<string, Observance[]>
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

/** `+0100`, `-0800` or `+013000` as milliseconds east of UTC, or null. */
function offsetOf(value: string): number | null {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(value.trim())
  if (!m) return null
  const ms = (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0)) * 1000
  return m[1] === '-' ? -ms : ms
}

/** The wall-clock parts of `20261113T100000` (the seconds optional, a trailing Z allowed), as UTC milliseconds, or null: a month 13, a day that is not in its month or an hour of 25 is no time. */
function wallOf(value: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?Z?$/i.exec(value.trim())
  if (!m) return null
  const [y, mo, d, h, mi, s] = [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? 0),
  ] as [number, number, number, number, number, number]
  const ms = Date.UTC(y, mo - 1, d, h, mi, s)
  const back = new Date(ms)
  return back.getUTCFullYear() === y &&
    back.getUTCMonth() === mo - 1 &&
    back.getUTCDate() === d &&
    h < 24 &&
    mi < 60 &&
    s < 60
    ? ms
    : null
}

function observanceOf(lines: Line[]): Observance | null {
  const get = (name: string): Line | undefined => lines.find((l) => l.name === name)
  const onset = wallOf(get('DTSTART')?.value ?? '')
  const from = offsetOf(get('TZOFFSETFROM')?.value ?? '')
  const to = offsetOf(get('TZOFFSETTO')?.value ?? '')
  if (onset === null || from === null || to === null) return null
  const rrule = get('RRULE')?.value ?? ''
  const month = /(?:^|;)BYMONTH=(\d{1,2})(?:;|$)/i.exec(rrule)?.[1]
  const day = /(?:^|;)BYDAY=([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)(?:;|$)/i.exec(rrule)
  const rule =
    /(?:^|;)FREQ=YEARLY(?:;|$)/i.test(rrule) && month !== undefined && day !== null
      ? {
          month: Number(month),
          nth: day[1] === undefined ? 1 : Number(day[1]),
          weekday: WEEKDAYS.indexOf((day[2] ?? '').toUpperCase()),
        }
      : null
  return { onset, from, to, rule }
}

/** The calendar part's lines gathered: its METHOD, every event's properties (an alarm's left out), and each VTIMEZONE's observances. */
function gather(ics: string): Parsed {
  const collect = new Collector()
  for (const raw of unfold(ics)) {
    const line = parseLine(raw.trim())
    if (line !== null) collect.take(line)
  }
  return { method: collect.method, events: collect.events, zones: collect.zones }
}

/** Reads content lines in order, keeping track of which component each is in. */
class Collector {
  method = ''
  readonly events: Line[][] = []
  readonly zones = new Map<string, Observance[]>()
  private readonly stack: string[] = []
  private event: Line[] | null = null
  private zone: { tzid: string; observances: Observance[] } | null = null
  private observance: Line[] | null = null

  take(line: Line): void {
    if (line.name === 'BEGIN') this.begin(line.value.trim().toUpperCase())
    else if (line.name === 'END') this.end(line.value.trim().toUpperCase())
    else this.add(line)
  }

  private begin(what: string): void {
    this.stack.push(what)
    if (what === 'VEVENT') this.event = []
    else if (what === 'VTIMEZONE') this.zone = { tzid: '', observances: [] }
    else if ((what === 'STANDARD' || what === 'DAYLIGHT') && this.zone) this.observance = []
  }

  private end(what: string): void {
    const at = this.stack.lastIndexOf(what)
    if (at >= 0) this.stack.length = at
    if (what === 'VEVENT') this.endEvent()
    else if (what === 'STANDARD' || what === 'DAYLIGHT') this.endObservance()
    else if (what === 'VTIMEZONE') this.endZone()
  }

  private endEvent(): void {
    if (this.event) this.events.push(this.event)
    this.event = null
  }

  private endObservance(): void {
    const made = this.zone && this.observance ? observanceOf(this.observance) : null
    if (made) this.zone?.observances.push(made)
    this.observance = null
  }

  private endZone(): void {
    if (this.zone && this.zone.tzid !== '' && this.zone.observances.length > 0)
      this.zones.set(this.zone.tzid.toUpperCase(), this.zone.observances)
    this.zone = null
  }

  private add(line: Line): void {
    const top = this.stack[this.stack.length - 1]
    if (top === 'VEVENT') this.event?.push(line)
    else if (top === 'VTIMEZONE' && line.name === 'TZID') {
      if (this.zone) this.zone.tzid = line.value.trim()
    } else if (top === 'STANDARD' || top === 'DAYLIGHT') this.observance?.push(line)
    else if (top === 'VCALENDAR' && line.name === 'METHOD' && this.method === '')
      this.method = line.value.trim().toUpperCase()
  }
}

// ── Texts ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Cut at `max` characters without splitting a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text
  let end = max
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return text.slice(0, end).trimEnd()
}

// The characters a stranger's text never keeps: every control character (and the line and paragraph separators), each becoming a space. A note keeps its line feeds.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove control characters
const CONTROL = /[\u0000-\u001f\u007f-\u009f\p{Zl}\p{Zp}]/gu
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove control characters
const CONTROL_BUT_LINE_FEED = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Zl}\p{Zp}]/gu

/** An iCalendar TEXT value unescaped (`\n`, `\,`, `\;`, `\\`) and put on ONE line: control characters become spaces, runs of space collapse. Cut to `max`. */
export function oneLine(value: string, max: number): string {
  const unescaped = value.replace(/\\[nN]/g, ' ').replace(/\\([,;\\])/g, '$1')
  return cut(unescaped.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim(), max)
}

/** A guest's note: their own words, with their line breaks (at most one blank line between), the same control characters removed. Cut to `max`. */
function noteOf(value: string, max: number): string {
  const unescaped = value.replace(/\\[nN]/g, '\n').replace(/\\([,;\\])/g, '$1')
  const lines = unescaped
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_BUT_LINE_FEED, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
  return cut(
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    max,
  )
}

const LINK = /^[a-z][a-z0-9+.-]*:\/\//i

/** A place as the part gives it, unless it is only a link (no link is kept). */
const placeOf = (value: string): string => {
  const text = oneLine(value, LIMITS.place)
  return LINK.test(text) ? '' : text
}

/** The address a CAL-ADDRESS names (`mailto:ann@x.example`), lower case, or '' when it is not an email address. */
function addressOf(value: string): string {
  const bare = value.trim().replace(/^mailto:/i, '')
  const address = bare.toLowerCase()
  return /^[^\s<>"',;:()[\]\\]+@[^\s<>"',;:()[\]\\]+$/.test(address) && address.length <= LIMITS.address ? address : ''
}

function personOf(line: Line): CalendarPerson | null {
  const address = addressOf(line.value)
  const name = oneLine(line.params.CN ?? '', LIMITS.name)
  return address === '' && name === '' ? null : { name, address }
}

// ── Times ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The IANA zones of the Windows zone names Outlook and Exchange write in a TZID (and a few others), so a time in "Pacific Standard Time" is read as the moment it is. A name not here is not guessed at: the VTIMEZONE block the part
 * carries is tried next, then the time is kept as written. Compared without case.
 */
export const WINDOWS_ZONES: Readonly<Record<string, string>> = {
  'dateline standard time': 'Etc/GMT+12',
  'utc-11': 'Etc/GMT+11',
  'hawaiian standard time': 'Pacific/Honolulu',
  'alaskan standard time': 'America/Anchorage',
  'pacific standard time': 'America/Los_Angeles',
  'pacific standard time (mexico)': 'America/Tijuana',
  'us mountain standard time': 'America/Phoenix',
  'mountain standard time': 'America/Denver',
  'mountain standard time (mexico)': 'America/Chihuahua',
  'central america standard time': 'America/Guatemala',
  'central standard time': 'America/Chicago',
  'central standard time (mexico)': 'America/Mexico_City',
  'canada central standard time': 'America/Regina',
  'sa pacific standard time': 'America/Bogota',
  'eastern standard time': 'America/New_York',
  'us eastern standard time': 'America/Indiana/Indianapolis',
  'venezuela standard time': 'America/Caracas',
  'atlantic standard time': 'America/Halifax',
  'sa western standard time': 'America/La_Paz',
  'newfoundland standard time': 'America/St_Johns',
  'e. south america standard time': 'America/Sao_Paulo',
  'argentina standard time': 'America/Argentina/Buenos_Aires',
  utc: 'UTC',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'romance standard time': 'Europe/Paris',
  'central european standard time': 'Europe/Warsaw',
  'w. central africa standard time': 'Africa/Lagos',
  'gtb standard time': 'Europe/Bucharest',
  'middle east standard time': 'Asia/Beirut',
  'egypt standard time': 'Africa/Cairo',
  'e. europe standard time': 'Europe/Chisinau',
  'fle standard time': 'Europe/Kiev',
  'south africa standard time': 'Africa/Johannesburg',
  'israel standard time': 'Asia/Jerusalem',
  'turkey standard time': 'Europe/Istanbul',
  'arab standard time': 'Asia/Riyadh',
  'arabic standard time': 'Asia/Baghdad',
  'e. africa standard time': 'Africa/Nairobi',
  'russian standard time': 'Europe/Moscow',
  'iran standard time': 'Asia/Tehran',
  'arabian standard time': 'Asia/Dubai',
  'azerbaijan standard time': 'Asia/Baku',
  'afghanistan standard time': 'Asia/Kabul',
  'west asia standard time': 'Asia/Tashkent',
  'pakistan standard time': 'Asia/Karachi',
  'india standard time': 'Asia/Kolkata',
  'sri lanka standard time': 'Asia/Colombo',
  'nepal standard time': 'Asia/Kathmandu',
  'bangladesh standard time': 'Asia/Dhaka',
  'myanmar standard time': 'Asia/Yangon',
  'se asia standard time': 'Asia/Bangkok',
  'china standard time': 'Asia/Shanghai',
  'singapore standard time': 'Asia/Singapore',
  'w. australia standard time': 'Australia/Perth',
  'taipei standard time': 'Asia/Taipei',
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'cen. australia standard time': 'Australia/Adelaide',
  'aus central standard time': 'Australia/Darwin',
  'e. australia standard time': 'Australia/Brisbane',
  'aus eastern standard time': 'Australia/Sydney',
  'tasmania standard time': 'Australia/Hobart',
  'west pacific standard time': 'Pacific/Port_Moresby',
  'new zealand standard time': 'Pacific/Auckland',
  'fiji standard time': 'Pacific/Fiji',
  'tonga standard time': 'Pacific/Tongatapu',
  'samoa standard time': 'Pacific/Apia',
}

/** The moment a wall clock in an IANA zone shows, or null when the runtime does not know the zone. */
function inZone(wall: number, zone: string): number | null {
  const d = new Date(wall)
  try {
    return (
      momentAt(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), zone) +
      d.getUTCSeconds() * 1000
    )
  } catch {
    return null
  }
}

/** The day (as UTC milliseconds at midnight) of the nth weekday of a month: `nth` 1 to 4 counts from the start, -1 from the end. */
function nthWeekday(year: number, month: number, nth: number, weekday: number): number {
  if (nth > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1))
    return Date.UTC(year, month - 1, 1 + ((weekday - first.getUTCDay() + 7) % 7) + (nth - 1) * 7)
  }
  const last = new Date(Date.UTC(year, month, 0))
  return Date.UTC(year, month - 1, last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7) + (nth + 1) * 7)
}

/** The offset a part's own VTIMEZONE says applies to a wall-clock time: the observance whose latest onset at or before it is the latest of all. */
function blockOffset(observances: readonly Observance[], wall: number): number | null {
  let best: { at: number; to: number } | null = null
  for (const o of observances) {
    const timeOfDay = ((o.onset % 86_400_000) + 86_400_000) % 86_400_000
    const years = new Date(wall).getUTCFullYear()
    const candidates: number[] = []
    if (o.rule) {
      for (const year of [years - 1, years]) {
        if (year < new Date(o.onset).getUTCFullYear()) continue
        candidates.push(nthWeekday(year, o.rule.month, o.rule.nth, o.rule.weekday) + timeOfDay)
      }
    } else candidates.push(o.onset)
    const at = Math.max(...candidates.filter((c) => c <= wall), Number.NEGATIVE_INFINITY)
    if (Number.isFinite(at) && (best === null || at > best.at)) best = { at, to: o.to }
  }
  if (best !== null) return best.to
  // Before every onset: the offset the earliest observance moved FROM.
  const first = [...observances].sort((a, b) => a.onset - b.onset)[0]
  return first ? first.from : null
}

/** A time property read: a day, a moment, or a time kept as written. */
type Time =
  | { kind: 'date'; day: string }
  | { kind: 'moment'; ms: number }
  | { kind: 'written'; local: string; wall: number; zone: string | null }

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
const localOf = (wall: number): string => new Date(wall).toISOString().slice(0, 16)

function timeOf(line: Line | undefined, zones: Map<string, Observance[]>): Time | null {
  if (line === undefined) return null
  const value = line.value.trim()
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value)
  if (date) {
    const ms = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]))
    const back = new Date(ms)
    const valid = back.getUTCMonth() === Number(date[2]) - 1 && back.getUTCDate() === Number(date[3])
    return valid ? { kind: 'date', day: dayOf(ms) } : null
  }
  const wall = wallOf(value)
  if (wall === null) return null
  if (/z$/i.test(value)) return { kind: 'moment', ms: wall }
  const tzid = line.params.TZID?.trim()
  if (tzid === undefined || tzid === '') return { kind: 'written', local: localOf(wall), wall, zone: null }
  // The zone as written, then the names a path-style TZID (`/mozilla.org/20050101_1/Europe/Berlin`) ends in, then the Windows table, then the part's own block.
  const segments = tzid.split('/').filter((s) => s !== '')
  const tries = [
    tzid,
    segments.slice(-2).join('/'),
    segments.slice(-1).join('/'),
    WINDOWS_ZONES[tzid.toLowerCase()] ?? '',
  ]
  for (const zone of tries) {
    if (zone === '') continue
    const ms = inZone(wall, zone)
    if (ms !== null) return { kind: 'moment', ms }
  }
  const block = zones.get(tzid.toUpperCase())
  const offset = block ? blockOffset(block, wall) : null
  if (offset !== null) return { kind: 'moment', ms: wall - offset }
  return { kind: 'written', local: localOf(wall), wall, zone: oneLine(tzid, LIMITS.zone) }
}

/** `PT1H`, `PT30M`, `P1D`, `P1W` as milliseconds, or null. */
function durationOf(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value.trim())
  if (!m) return null
  const ms =
    (Number(m[2] ?? 0) * 604800 +
      Number(m[3] ?? 0) * 86400 +
      Number(m[4] ?? 0) * 3600 +
      Number(m[5] ?? 0) * 60 +
      Number(m[6] ?? 0)) *
    1000
  return m[1] === '-' ? -ms : ms
}

interface When {
  allDay: boolean
  start: number | null
  end: number | null
  startDate: string | null
  endDate: string | null
  written: CalendarWritten | null
}

const NO_TIME: When = { allDay: false, start: null, end: null, startDate: null, endDate: null, written: null }

/** The event's time from its DTSTART, and DTEND or DURATION. */
function whenOf(props: Line[], zones: Map<string, Observance[]>): When {
  const find = (name: string) => props.find((l) => l.name === name)
  const start = timeOf(find('DTSTART'), zones)
  if (start === null) return NO_TIME
  const end = timeOf(find('DTEND'), zones)
  const length = durationOf(find('DURATION')?.value ?? '')
  if (start.kind === 'date') {
    // DTEND is the day AFTER the last; the last day is what a person means.
    let last = start.day
    if (end?.kind === 'date' && end.day > start.day) last = dayOf(Date.parse(`${end.day}T00:00:00Z`) - 86_400_000)
    else if (end === null && length !== null && length >= 86_400_000)
      last = dayOf(Date.parse(`${start.day}T00:00:00Z`) + length - 86_400_000)
    return { ...NO_TIME, allDay: true, startDate: start.day, endDate: last }
  }
  if (start.kind === 'moment') {
    const endMs = end?.kind === 'moment' ? end.ms : length !== null ? start.ms + length : null
    return { ...NO_TIME, start: start.ms, end: endMs }
  }
  const endWall = end?.kind === 'written' ? end.wall : length !== null ? start.wall + length : null
  return {
    ...NO_TIME,
    written: { start: start.local, end: endWall === null ? null : localOf(endWall), zone: start.zone },
  }
}

function occurrenceOf(line: Line | undefined, zones: Map<string, Observance[]>): CalendarOccurrence | null {
  const t = timeOf(line, zones)
  if (t === null) return null
  if (t.kind === 'date') return { at: null, date: t.day }
  if (t.kind === 'moment') return { at: t.ms, date: null }
  return { at: null, date: t.local.slice(0, 10) }
}

// ── The summary ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const PARTSTAT: Record<string, CalendarSummaryAnswer> = {
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  TENTATIVE: 'tentative',
}

/** Whether an ATTENDEE is a room or equipment rather than a person. */
const isResource = (l: Line): boolean => /^(RESOURCE|ROOM)$/i.test(l.params.CUTYPE ?? '')

/** What the part is, from its method and sequence, and for a guest's answer who answered and how. */
function classify(
  method: string,
  props: Line[],
  attendees: Line[],
): { kind: CalendarSummaryKind; answer?: CalendarSummaryAnswer; by?: CalendarPerson } {
  if (method === 'REQUEST') {
    const sequence = Number.parseInt(props.find((l) => l.name === 'SEQUENCE')?.value ?? '0', 10)
    return { kind: Number.isFinite(sequence) && sequence > 0 ? 'update' : 'invitation' }
  }
  if (method === 'CANCEL') return { kind: 'cancelled' }
  if (method !== 'REPLY' && method !== 'COUNTER') return { kind: 'event' }
  const partstat = (l: Line): CalendarSummaryAnswer | undefined => PARTSTAT[(l.params.PARTSTAT ?? '').toUpperCase()]
  const answering = method === 'REPLY' ? attendees.find((l) => partstat(l) !== undefined) : attendees[0]
  const answer: CalendarSummaryAnswer | undefined =
    method === 'COUNTER' ? 'counter' : answering === undefined ? undefined : partstat(answering)
  // A reply that carries no answer is not somebody's answer: it is read as a plain event.
  if (answer === undefined) return { kind: 'event' }
  const by = answering === undefined ? null : personOf(answering)
  return { kind: 'reply', answer, ...(by !== null && { by }) }
}

/** The guests an invitation names: every attendee that is a person, the organizer left out (they are on it as the one it is from). A guest's answer names none. */
function guestsOf(kind: CalendarSummaryKind, attendees: Line[], organizer: CalendarPerson | null): CalendarPerson[] {
  if (kind === 'reply') return []
  const found: CalendarPerson[] = []
  for (const l of attendees) {
    const p = personOf(l)
    if (p !== null && !(organizer !== null && organizer.address !== '' && p.address === organizer.address))
      found.push(p)
  }
  return found
}

/**
 * What one calendar part says, or null when it has no event in it, is over 256 KB, or cannot be read. Never throws.
 */
export function summaryOfCalendar(ics: string): CalendarSummary | null {
  try {
    if (ics.length > CALENDAR_SUMMARY_PART_MAX) return null
    const { method, events, zones } = gather(ics)
    const props = events[0]
    if (props === undefined) return null
    const find = (name: string) => props.find((l) => l.name === name)
    const attendees = props.filter((l) => l.name === 'ATTENDEE' && !isResource(l))
    const { kind, answer, by } = classify(method, props, attendees)
    const organizerLine = find('ORGANIZER')
    const organizer = organizerLine ? personOf(organizerLine) : null
    const guests = guestsOf(kind, attendees, organizer)
    const note = kind === 'reply' ? noteOf(find('COMMENT')?.value ?? '', LIMITS.note) : ''
    const recurrence = find('RECURRENCE-ID')

    return {
      kind,
      ...(answer !== undefined && { answer }),
      ...(by !== undefined && { by }),
      ...(note !== '' && { note }),
      title: oneLine(find('SUMMARY')?.value ?? '', LIMITS.title),
      ...whenOf(props, zones),
      location: placeOf(find('LOCATION')?.value ?? ''),
      organizer,
      guests: guests.slice(0, CALENDAR_SUMMARY_GUESTS),
      guestsMore: Math.max(0, guests.length - CALENDAR_SUMMARY_GUESTS),
      repeats: find('RRULE') !== undefined || find('RDATE') !== undefined || recurrence !== undefined,
      occurrence: occurrenceOf(recurrence, zones),
      uid: cut(oneLine(find('UID')?.value ?? '', LIMITS.uid + 1), LIMITS.uid),
      moreEvents: events.length - 1,
    }
  } catch {
    return null
  }
}
