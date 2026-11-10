/**
 * Google's event, read into the shape the store keeps. Pure: no I/O.
 *
 * EVERYTHING HERE IS UNTRUSTED TEXT. A title, a place, a description and a guest's name are whatever the organiser typed (and an invitation can come from a stranger), so each is cut to a length, stripped of
 * control characters and kept as TEXT; the page draws it as text and never as markup. A link is kept only when it is an https address (a call link) or an https address on Google's own host (the event in Google
 * Calendar), so a `javascript:` or a lookalike never reaches an `href`.
 */

import { CALENDAR_DESCRIPTION_MAX, CALENDAR_GUESTS_MAX, CALENDAR_RESPONSES, type CalendarGuest, type CalendarResponse, momentAt } from '@space/workspace'

type Json = Record<string, unknown>
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const TITLE_MAX = 300
const PLACE_MAX = 300
const NAME_MAX = 120
const EMAIL_MAX = 200

/** Control characters out (a newline and a tab stay where `keepBreaks` says), trimmed, cut to a length. */
export function cleanText(v: unknown, max: number, keepBreaks = false): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
  const stripped = str(v).replace(keepBreaks ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, keepBreaks ? '' : ' ')
  return stripped.trim().slice(0, max)
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/**
 * Google's description may carry a little HTML (a link, a line break). It is flattened to the plain text a person would read: breaks become newlines, tags go, the common entities are decoded. The result is
 * text and is drawn as text, so what a tag was trying to do is never done; this only makes the words readable.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '- ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith('#')) {
        const code = name[1]?.toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
      }
      return ENTITIES[name.toLowerCase()] ?? whole
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}

/** An https address, or null. */
export function httpsLink(v: unknown): string | null {
  const text = str(v).trim()
  if (text === '' || text.length > 2000) return null
  try {
    const url = new URL(text)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/** The event in Google Calendar: an https address on a google.com host, or null. */
export function googleLink(v: unknown): string | null {
  const link = httpsLink(v)
  if (link === null) return null
  const host = new URL(link).hostname
  return host === 'google.com' || host.endsWith('.google.com') ? link : null
}

const isResponse = (v: unknown): v is CalendarResponse => (CALENDAR_RESPONSES as readonly string[]).includes(str(v))

/** An all-day date (`2026-11-05`) as its year, month and day, or null. */
function dayOf(v: unknown): { y: number; m: number; d: number } | null {
  const hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(v))
  if (!hit) return null
  const [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])]
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 ? { y, m, d } : null
}

/** What the store keeps of an event. */
export interface ParsedEvent {
  kind: 'event'
  id: string
  iCalUid: string | null
  title: string
  location: string | null
  description: string | null
  start: number
  end: number
  allDay: boolean
  startDate: string | null
  /** The day AFTER the last (Google's exclusive end). */
  endDate: string | null
  status: 'confirmed' | 'tentative'
  response: CalendarResponse | null
  organizer: { name: string | null; email: string | null } | null
  guests: CalendarGuest[]
  guestsLeft: number
  videoLink: string | null
  htmlLink: string | null
  free: boolean
}

/** An event Google says is gone (cancelled, or deleted): in an incremental read it is removed from the store; in a full read it is simply not kept. */
export interface GoneEvent {
  kind: 'gone'
  id: string
}

/** Something that is not an event the calendar can draw: a malformed one, or a kind it leaves out. The reason is for the log. */
export interface SkippedEvent {
  kind: 'skipped'
  id: string
  why: string
}

export function parseEvent(raw: unknown, zone: string): ParsedEvent | GoneEvent | SkippedEvent {
  if (!isRecord(raw)) return { kind: 'skipped', id: '', why: 'not an object' }
  const id = str(raw.id)
  if (id === '' || id.length > 1024) return { kind: 'skipped', id: '', why: 'no usable id' }
  if (raw.status === 'cancelled') return { kind: 'gone', id }
  // Working-location entries are a note about where the person is, not a meeting: they would stand at the head of every day.
  if (raw.eventType === 'workingLocation') return { kind: 'skipped', id, why: 'a working location' }

  const start = isRecord(raw.start) ? raw.start : {}
  const end = isRecord(raw.end) ? raw.end : {}
  let startMs: number
  let endMs: number
  let allDay = false
  let startDate: string | null = null
  let endDate: string | null = null
  const startDay = dayOf(start.date)
  const endDay = dayOf(end.date)
  if (startDay) {
    allDay = true
    // An all-day event has dates and no hour: it runs from midnight to midnight on the company's clock, whatever zone Google files it under.
    const last = endDay ?? { y: startDay.y, m: startDay.m, d: startDay.d + 1 }
    startMs = momentAt(startDay.y, startDay.m, startDay.d, 0, 0, zone)
    endMs = momentAt(last.y, last.m, last.d, 0, 0, zone)
    startDate = str(start.date)
    endDate = endDay ? str(end.date) : new Date(Date.UTC(last.y, last.m - 1, last.d)).toISOString().slice(0, 10)
  } else {
    startMs = Date.parse(str(start.dateTime))
    endMs = end.dateTime === undefined ? startMs : Date.parse(str(end.dateTime))
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return { kind: 'skipped', id, why: 'no readable time' }
  }
  if (endMs < startMs) endMs = startMs

  const attendees = Array.isArray(raw.attendees) ? raw.attendees.filter(isRecord) : []
  const guests: CalendarGuest[] = attendees.slice(0, CALENDAR_GUESTS_MAX).map((a) => ({
    name: cleanText(a.displayName, NAME_MAX) || null,
    email: cleanText(a.email, EMAIL_MAX).toLowerCase() || null,
    response: isResponse(a.responseStatus) ? a.responseStatus : 'needsAction',
    organizer: a.organizer === true,
    self: a.self === true,
  }))
  const me = attendees.find((a) => a.self === true)
  const organizer = isRecord(raw.organizer) ? { name: cleanText(raw.organizer.displayName, NAME_MAX) || null, email: cleanText(raw.organizer.email, EMAIL_MAX).toLowerCase() || null } : null

  // The video call: Google's own field first, then a conference entry point that is a video.
  let video = httpsLink(raw.hangoutLink)
  if (video === null && isRecord(raw.conferenceData) && Array.isArray(raw.conferenceData.entryPoints)) {
    for (const entry of raw.conferenceData.entryPoints) {
      if (isRecord(entry) && entry.entryPointType === 'video') {
        video = httpsLink(entry.uri)
        if (video !== null) break
      }
    }
  }

  const description = cleanText(htmlToText(str(raw.description)), CALENDAR_DESCRIPTION_MAX, true)
  return {
    kind: 'event',
    id,
    iCalUid: cleanText(raw.iCalUID, 1024) || null,
    title: cleanText(raw.summary, TITLE_MAX) || '(No title)',
    location: cleanText(raw.location, PLACE_MAX) || null,
    description: description === '' ? null : description,
    start: startMs,
    end: endMs,
    allDay,
    startDate,
    endDate,
    status: raw.status === 'tentative' ? 'tentative' : 'confirmed',
    response: me && isResponse(me.responseStatus) ? me.responseStatus : me ? 'needsAction' : null,
    organizer,
    guests,
    guestsLeft: Math.max(0, attendees.length - guests.length),
    videoLink: video,
    htmlLink: googleLink(raw.htmlLink),
    free: raw.transparency === 'transparent',
  }
}

/** The last day of an all-day event, inclusive, from Google's exclusive end date. */
export function lastDay(exclusiveEnd: string): string {
  const day = dayOf(exclusiveEnd)
  if (!day) return exclusiveEnd
  return new Date(Date.UTC(day.y, day.m - 1, day.d - 1)).toISOString().slice(0, 10)
}
