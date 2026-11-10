import { describe, expect, test } from 'bun:test'
import { eventOf, eventOfCalendar, eventOfLinks } from '../src/calendar-event'

/**
 * Which calendar event a message is about, as pure functions: the iCalendar part first, Google Calendar's links second, never the subject.
 * The iCalendar texts are written to the shape Google sends (CRLF lines, a folded line, METHOD above the event); the links to the shape of its
 * plain-text body. ⚠️ Both are written from the documented formats and from how Google's mail reads, not captured from the live mailbox: the hand test
 * checks one real invitation (docs/runbooks/inbox-calendar-updates.md).
 */

const ics = (lines: string[]): string => lines.join('\r\n')
const invitation = (extra: string[] = [], method = 'REQUEST', uid = 'abc123def456@google.com') =>
  ics([
    'BEGIN:VCALENDAR',
    'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
    'VERSION:2.0',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    'DTSTART:20261203T160000Z',
    `UID:${uid}`,
    ...extra,
    'SUMMARY:Roadmap @ Fernway',
    'END:VEVENT',
    'END:VCALENDAR',
  ])
const eid = (event: string, calendar = 'tessa@northfield.example') =>
  Buffer.from(`${event} ${calendar}`).toString('base64url')
const rsvp = (event: string) =>
  `Reply for tessa@northfield.example\nYes: https://calendar.google.com/calendar/event?action=RESPOND&eid=${eid(event)}&rst=1&tok=MTIz&ctz=America/Los_Angeles&hl=en&es=1\n` +
  `View all event details: https://calendar.google.com/calendar/event?action=VIEW&eid=${eid(event)}&tok=MTIz&ctz=America%2FLos_Angeles&hl=en&es=1`
const viewOnly = (event: string) =>
  `Accepted. View all event details: https://calendar.google.com/calendar/event?action=VIEW&eid=${eid(event)}&tok=MTIz`

describe('the iCalendar part', () => {
  test('an invitation or an update is an update of the event the UID names; a Google UID is keyed by its event id', () => {
    expect(eventOfCalendar(invitation())).toEqual({ key: 'google:abc123def456', kind: 'update' })
  })

  test('a cancellation is the cancel kind of the same event', () => {
    expect(eventOfCalendar(invitation([], 'CANCEL'))).toEqual({ key: 'google:abc123def456', kind: 'cancel' })
  })

  test('a reply to an invitation, a counter proposal or a part with no method is not event mail', () => {
    expect(eventOfCalendar(invitation([], 'REPLY'))).toBeNull()
    expect(eventOfCalendar(invitation([], 'COUNTER'))).toBeNull()
    expect(eventOfCalendar(invitation().replace('METHOD:REQUEST\r\n', ''))).toBeNull()
  })

  test('one occurrence of a repeating event is its own event, in the form Google names the occurrence', () => {
    expect(eventOfCalendar(invitation(['RECURRENCE-ID:20261203T160000Z']))).toEqual({
      key: 'google:abc123def456_20261203T160000Z',
      kind: 'update',
    })
    expect(eventOfCalendar(invitation(['RECURRENCE-ID;VALUE=DATE:20261203']))?.key).toBe('google:abc123def456_20261203')
  })

  test('an occurrence in a zone is named in UTC, as Google names it: the same key as the eid path gives', () => {
    // 8am in Los Angeles on Dec 3, 2026 is PST (UTC-8), and on Jun 4 PDT (UTC-7).
    expect(eventOfCalendar(invitation(['RECURRENCE-ID;TZID=America/Los_Angeles:20261203T080000']))?.key).toBe(
      'google:abc123def456_20261203T160000Z',
    )
    expect(eventOfCalendar(invitation(['RECURRENCE-ID;TZID=America/Los_Angeles:20260604T080000']))?.key).toBe(
      'google:abc123def456_20260604T150000Z',
    )
    expect(eventOfLinks(rsvp('abc123def456_20261203T160000Z'))?.key).toBe('google:abc123def456_20261203T160000Z')
    // A zone the runtime does not know is kept as written, apart from every other occurrence.
    expect(eventOfCalendar(invitation(['RECURRENCE-ID;TZID=Pacific Standard Time:20261203T080000']))?.key).toBe(
      'google:abc123def456_PACIFIC STANDARD TIME:20261203T080000',
    )
  })

  test('another calendar’s UID is kept as it is, and a folded line is read whole', () => {
    expect(eventOfCalendar(invitation([], 'REQUEST', '040000008200E00074C5B7101A82E0080000000'))?.key).toBe(
      'uid:040000008200E00074C5B7101A82E0080000000',
    )
    const folded = invitation().replace('UID:abc123def456@google.com', 'UID:abc123\r\n def456@google.com')
    expect(eventOfCalendar(folded)?.key).toBe('google:abc123def456')
  })

  test('no UID, or one too long to keep, is no event', () => {
    expect(eventOfCalendar(invitation().replace(/UID:.*\r\n/, ''))).toBeNull()
    expect(eventOfCalendar(invitation([], 'REQUEST', `${'x'.repeat(400)}@example.com`))).toBeNull()
  })
})

describe('Google Calendar’s links', () => {
  test('an RSVP link names the event, and the same event id as its UID does', () => {
    expect(eventOfLinks(rsvp('abc123def456'))).toEqual({ key: 'google:abc123def456', kind: 'update' })
    expect(eventOfLinks(rsvp('abc123def456'))?.key).toBe(eventOfCalendar(invitation())?.key as string)
  })

  test('the link as an HTML attribute (&amp;) reads the same', () => {
    const html = rsvp('abc123def456').replaceAll('&', '&amp;')
    expect(eventOfLinks(`<a href="${html.split('\n')[1]?.replace('Yes: ', '')}">Yes</a>`)).toEqual({
      key: 'google:abc123def456',
      kind: 'update',
    })
  })

  test('a link with only View (a reminder, an acceptance) is not an invitation', () => {
    expect(eventOfLinks(viewOnly('abc123def456'))).toBeNull()
  })

  test('an eid that is not an event id is nobody’s', () => {
    expect(eventOfLinks('https://calendar.google.com/calendar/event?action=RESPOND&eid=!!!&rst=1')).toBeNull()
    expect(eventOfLinks('https://example.com/calendar/event?action=RESPOND&eid=@@@')).toBeNull()
  })
})

describe('a message', () => {
  const base = {
    calendars: [] as string[],
    texts: [] as string[],
    subject: 'Updated invitation: Roadmap @ Fernway @ Thu Dec 3, 2026 8am',
    sender: 'Google Calendar <calendar-notification@google.com>',
    listId: '',
    answersAnother: false,
  }

  test('only mail the calendar system sent: Google’s own Sender, or a group’s relay (List-Id) of Google’s body', () => {
    const outlook = { ...base, sender: '', calendars: [invitation()], texts: ['Hi all, agenda: 1. budget 2. hiring'] }
    expect(eventOf(outlook)).toBeNull()
    expect(eventOf({ ...outlook, sender: 'calendar-notification@google.com' })?.key).toBe('google:abc123def456')
    // "'Notetaker' via Engineering": the group is the Sender, Google's body is kept, and the group adds a List-Id.
    const relay = {
      ...base,
      sender: 'engineering+bnc@fernway.example',
      calendars: [invitation()],
      texts: [rsvp('abc123def456')],
    }
    expect(eventOf(relay)).toBeNull()
    expect(eventOf({ ...relay, listId: '<engineering.fernway.example>' })?.key).toBe('google:abc123def456')
    // A List-Id with nothing of Google's in the text keys nothing.
    expect(eventOf({ ...relay, listId: '<engineering.fernway.example>', texts: ['Lunch is at noon'] })).toBeNull()
  })

  test('a person’s mail carrying Google’s links is never keyed, in any language or with any subject: forwards and a pasted link', () => {
    const body = (extra: string) => `${extra}\n${rsvp('abc123def456')}`
    const person = { ...base, sender: '', calendars: [] as string[] }
    for (const [subject, text] of [
      ['Infra on Thursday', body('---------- Forwarded message ---------')], // an Outlook forward with an edited subject, forward line or not
      ['Infra on Thursday', body('Von: Noah Feld\nGesendet: Montag, 2. November 2026\nAn: Tessa Marlow')],
      ['WG: Einladung: Roadmap', body('Kannst du?')],
      ['TR: Invitation: Roadmap', body('De : Noah Feld\nEnvoyé : lundi 2 novembre 2026')],
      ['Quick question', body('Is this the right link for the 8am meeting?')], // a new email with a pasted RSVP link
    ] as const) {
      expect(eventOf({ ...person, subject, texts: [text] }), subject).toBeNull()
      expect(eventOf({ ...person, subject, texts: [text], calendars: [invitation()] }), subject).toBeNull()
    }
  })

  test('a forward or a reply is a person’s, though it carries the calendar part and the links', () => {
    const forwarded = { ...base, calendars: [invitation()], texts: [`Can you make this?\n\n${rsvp('abc123def456')}`] }
    expect(eventOf(forwarded)?.key).toBe('google:abc123def456')
    expect(eventOf({ ...forwarded, subject: 'Fwd: Invitation: Roadmap @ Fernway', sender: '' })).toBeNull()
    expect(eventOf({ ...forwarded, subject: 'Re: Invitation: Roadmap' })).toBeNull()
    expect(
      eventOf({
        ...forwarded,
        subject: 'Roadmap',
        texts: [`Question first.\n---------- Forwarded message ---------\n${rsvp('abc123def456')}`],
      }),
    ).toBeNull()
    expect(eventOf({ ...forwarded, answersAnother: true })).toBeNull()
  })

  test('the iCalendar part decides before the links do, and a reply part ends the search', () => {
    expect(eventOf({ ...base, calendars: [invitation()], texts: [rsvp('zzzzzzzz')] })?.key).toBe('google:abc123def456')
    expect(eventOf({ ...base, calendars: [invitation([], 'REPLY')], texts: [rsvp('abc123def456')] })).toBeNull()
  })

  test('with no iCalendar part the links decide, unless the message answers another (a person quoting the invitation)', () => {
    expect(eventOf({ ...base, texts: [rsvp('abc123def456')] })?.key).toBe('google:abc123def456')
    expect(eventOf({ ...base, texts: [`> ${rsvp('abc123def456')}`], answersAnother: true })).toBeNull()
  })

  test('the subject has no part in it: a message with no part and no link is not event mail', () => {
    expect(
      eventOf({ ...base, texts: ['Updated invitation: Roadmap @ Fernway @ Thu Dec 3, 2026 8am'] }),
    ).toBeNull()
  })
})
