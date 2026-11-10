/**
 * Which calendar event a piece of mail is about, so a second update of the same meeting can replace the first.
 *
 * Google Calendar sends a new email for every update of an event, and its subject carries the time ("Updated invitation: Infra @ Thu
 * Dec 3, 2026 8am", then "... 7am"), so Gmail files each as a thread of its own and the space shows the same meeting several times. The
 * subject is never the key: it changes with the update. What does not change is the event's identity, read in this order:
 *
 *   1. the iCalendar part (`text/calendar`), when the message has one and its bytes are in the message: the UID, and the RECURRENCE-ID
 *      when the mail is about one occurrence of a repeating event. Its METHOD says what the mail is (REQUEST: an invitation or an update;
 *      CANCEL: a cancellation). A reply to an invitation (REPLY, "Accepted: ...") or anything else is not event mail.
 *   2. otherwise the `eid` of Google Calendar's own links in the body. It is the base64 of "<event id> <calendar id>", and the event
 *      id is what a Google UID is made of (`<event id>@google.com`), so both ways name the same event with the same key. The RSVP
 *      links (`action=RESPOND`) are what an invitation or an update has and a reminder or a reply has not (the VIEW link is on all of them),
 *      so only a body with an RSVP link counts.
 *
 * ── ONLY MAIL THE CALENDAR SYSTEM SENT ───────────────────────────────────
 * A person's mail is never keyed, because closing it for a newer message would hide what a person wrote. A message is the calendar's when it
 * is not a reply or a forward (no In-Reply-To or References, no "Re:" or "Fwd:" subject, no forwarded-message marker in its text) AND shows
 * Google Calendar made it, by ONE of two marks a person's own mail never has:
 *   - its `Sender` is calendar-notification@google.com (Google's direct mail); or
 *   - it came through a group (a `List-Id` header, which Google Groups adds) AND its text carries Google Calendar's event links: a group such as
 *     "'Notetaker' via Engineering" relays Google's mail under its own Sender, keeping Google's body.
 * The links alone prove nothing: a person's forward in any language ("WG:", "TR:", an edited subject, "Von:/Gesendet:"), or a new email with a
 * pasted RSVP link, carries them too. A person's invitation from another calendar (Outlook, a typed agenda) shows neither mark and is not keyed.
 *
 * Pure functions over plain text, so what counts as an event and which one is a table test with no store and no network.
 *
 * ── MAIL IS UNTRUSTED INPUT ──────────────────────────────────────────────
 * The key is only ever compared as text, and only between messages of the same mailbox. A stranger who forges a UID can at worst
 * replace an older calendar mail of theirs that the inbox already holds with no reply from the owner and no draft on it.
 */

/** What a calendar email is: an invitation or its update (it replaces the older ones), or the event's cancellation. */
export type CalendarKind = 'update' | 'cancel'

/** The event a message is about, as it is stored on the message. */
export interface CalendarMail {
  /** `google:<event id>` or `uid:<uid>`, with `_<occurrence>` or `#<occurrence>` for one occurrence of a repeating event. */
  key: string
  kind: CalendarKind
}

/** What a message offers to be read for its event: the decoded text of its calendar parts and of its text and HTML parts, its subject and Sender header, and whether it answers another message (In-Reply-To or References). */
export interface CalendarSource {
  calendars: string[]
  texts: string[]
  subject: string
  /** The Sender header as written, '' when there is none. */
  sender: string
  /** The List-Id header as written, '' when there is none (the mark of a group's relay). */
  listId: string
  answersAnother: boolean
}

/** Longest key kept: a stranger's UID is not stored without a limit. */
const KEY_LIMIT = 300

/** Lines of an iCalendar body with the folds undone (a line that starts with a space or a tab continues the one before). Shared with the summary reader (`src/calendar-summary.ts`). */
export function unfold(ics: string): string[] {
  return ics
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
}

/** The value of the first property of that name in the first VEVENT (parameters after the name are dropped), or null. */
function property(lines: string[], name: string): { params: string; value: string } | null {
  let inEvent = false
  for (const line of lines) {
    const upper = line.toUpperCase()
    if (upper === 'BEGIN:VEVENT') inEvent = true
    else if (upper === 'END:VEVENT') return null
    else if (inEvent && upper.startsWith(name)) {
      const rest = line.slice(name.length)
      if (rest[0] !== ':' && rest[0] !== ';') continue
      const colon = rest.indexOf(':')
      if (colon === -1) continue
      return { params: rest.slice(0, colon).toUpperCase(), value: rest.slice(colon + 1).trim() }
    }
  }
  return null
}

/** The first METHOD of the calendar (it sits above the events), uppercased, or null. */
function methodOf(lines: string[]): string | null {
  for (const line of lines) {
    if (line.toUpperCase() === 'BEGIN:VEVENT') return null
    if (/^METHOD:/i.test(line)) return line.slice('METHOD:'.length).trim().toUpperCase()
  }
  return null
}

const GOOGLE_UID = /^([A-Za-z0-9_]+)@google\.com$/i

/** One iCalendar date-time as the UTC stamp Google names an occurrence by (`20261203T160000Z`), or null when the zone is not one the runtime knows. */
function utcStamp(local: string, zone: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(local)
  if (!m) return null
  const [y, mo, d, h, mi, sec] = m.slice(1).map(Number) as [number, number, number, number, number, number]
  const wall = Date.UTC(y, mo - 1, d, h, mi, sec)
  try {
    const format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    const wallIn = (utc: number): number => {
      const p = Object.fromEntries(format.formatToParts(new Date(utc)).map((x) => [x.type, x.value]))
      return Date.UTC(
        Number(p.year),
        Number(p.month) - 1,
        Number(p.day),
        Number(p.hour),
        Number(p.minute),
        Number(p.second),
      )
    }
    let utc = wall - (wallIn(wall) - wall)
    utc = wall - (wallIn(utc) - utc)
    return new Date(utc).toISOString().replace(/[-:]|\.\d{3}/g, '')
  } catch {
    return null
  }
}

/** What names one occurrence of a repeating event, in the form Google puts after the event id: a date, or a UTC date-time (a zoned one is converted). */
function occurrenceOf(recurrence: { params: string; value: string } | null): string | null {
  if (recurrence === null) return null
  const { params, value } = recurrence
  if (/^\d{8}$/.test(value) || /^\d{8}T\d{6}Z$/i.test(value)) return value.toUpperCase()
  const zone = /TZID=([^;:]+)/i.exec(params)?.[1]
  if (zone) return utcStamp(value, zone) ?? `${zone}:${value}`
  return value
}

function keyOfUid(uid: string, occurrence: string | null): string | null {
  const google = GOOGLE_UID.exec(uid)
  const key = google
    ? `google:${google[1]}${occurrence ? `_${occurrence}` : ''}`
    : `uid:${uid}${occurrence ? `#${occurrence}` : ''}`
  return uid === '' || key.length > KEY_LIMIT ? null : key
}

/** What one iCalendar body says the mail is, or null when it is not an invitation, an update or a cancellation of an event. */
export function eventOfCalendar(ics: string): CalendarMail | null {
  const lines = unfold(ics)
  const method = methodOf(lines)
  const kind: CalendarKind | null = method === 'REQUEST' ? 'update' : method === 'CANCEL' ? 'cancel' : null
  if (kind === null) return null
  const uid = property(lines, 'UID')?.value ?? ''
  const key = keyOfUid(uid, occurrenceOf(property(lines, 'RECURRENCE-ID')))
  return key === null ? null : { key, kind }
}

/** The event id inside one Google Calendar `eid`, or null when it is not one. */
function eventIdOfEid(eid: string): string | null {
  try {
    const standard = eid.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = atob(standard + '='.repeat((4 - (standard.length % 4)) % 4))
    const id = decoded.split(' ')[0] ?? ''
    return /^[A-Za-z0-9_]{5,}$/.test(id) ? id : null
  } catch {
    return null
  }
}

const CALENDAR_LINK = /calendar\/(?:u\/\d+\/)?event\?([^\s"'<>]*)/gi

/** The event a body's Google Calendar links name, when one of them is an RSVP link; otherwise null. */
export function eventOfLinks(text: string): CalendarMail | null {
  let eventId: string | null = null
  let rsvp = false
  for (const match of text.matchAll(CALENDAR_LINK)) {
    const query = (match[1] ?? '').replace(/&amp;/gi, '&')
    const eid = /(?:^|&)eid=([A-Za-z0-9_-]+)/.exec(query)?.[1]
    const id = eid ? eventIdOfEid(eid) : null
    if (id === null) continue
    eventId ??= id
    if (id === eventId && /(?:^|&)action=RESPOND(?:&|$)/i.test(query)) rsvp = true
  }
  const key = eventId === null ? null : `google:${eventId}`
  return key !== null && rsvp ? { key, kind: 'update' } : null
}

/** Whether any of the texts carries a Google Calendar event link with an event id in it: the template Google's mail (and a group's relay of it) is made of. */
function hasCalendarLink(texts: string[]): boolean {
  return texts.some((text) =>
    [...text.matchAll(CALENDAR_LINK)].some((m) => {
      const eid = /(?:^|&)eid=([A-Za-z0-9_-]+)/.exec((m[1] ?? '').replace(/&amp;/gi, '&'))?.[1]
      return eid !== undefined && eventIdOfEid(eid) !== null
    }),
  )
}

const FORWARD_SUBJECT = /^\s*(?:re|fwd?)\s*:/i
const FORWARD_MARKER = /-{3,}\s*forwarded message\s*-{3,}|begin forwarded message|-{3,}\s*original message\s*-{3,}/i

/** Whether a message is a person's reply or forward by its words: a "Re:" or "Fwd:" subject, or the forwarded-message line. */
export function looksForwarded(subject: string, texts: string[]): boolean {
  return FORWARD_SUBJECT.test(subject) || texts.some((t) => FORWARD_MARKER.test(t))
}

/** Whether a Sender header names Google Calendar's own sender. */
const isGoogleCalendar = (sender: string): boolean =>
  /(?:^|[<\s])calendar-notification@google\.com(?:>|\s|$)/i.test(sender)

/** The event a message is about, or null when it is not calendar mail. See the top of this file for the order and for whose mail counts. */
export function eventOf(source: CalendarSource): CalendarMail | null {
  if (source.answersAnother || looksForwarded(source.subject, source.texts)) return null
  const relayedByGroup = source.listId.trim() !== '' && hasCalendarLink(source.texts)
  if (!isGoogleCalendar(source.sender) && !relayedByGroup) return null
  for (const ics of source.calendars) {
    const found = eventOfCalendar(ics)
    if (found) return found
  }
  if (source.calendars.some((ics) => /^METHOD:/im.test(ics))) return null
  for (const text of source.texts) {
    const found = eventOfLinks(text)
    if (found) return found
  }
  return null
}
