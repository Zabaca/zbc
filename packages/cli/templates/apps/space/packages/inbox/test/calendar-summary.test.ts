import { describe, expect, test } from 'bun:test'
import {
  CALENDAR_SUMMARY_PART_MAX,
  type CalendarSummary,
  guestsWords,
  isCalendarSummary,
  parseCalendarSummary,
  summaryHeading,
  summaryLine,
  summaryWhen,
} from '@space/workspace'
import { isCalendarPart, summaryOfCalendar } from '../src/calendar-summary'

/**
 * What a calendar part says, as a table of invented parts. The parts are written to the shapes Google and Outlook send (CRLF lines, a folded line, METHOD above the events, an attendee's PARTSTAT); they are NOT captured from a live
 * mailbox, so the hand test reads one real invitation and one real answer. Every person and company is invented (the example domains).
 */

const ics = (lines: string[]): string => lines.join('\r\n')
const calendar = (method: string | null, events: string[][], before: string[] = []): string =>
  ics([
    'BEGIN:VCALENDAR',
    'PRODID:-//Example//Calendar//EN',
    'VERSION:2.0',
    ...(method === null ? [] : [`METHOD:${method}`]),
    ...before,
    ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']),
    'END:VCALENDAR',
  ])
const ORGANIZER = 'ORGANIZER;CN=Noah Feld:mailto:noah@fernway.example'
const GUESTS = [
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=Tessa Marlow:mailto:tessa@northfield.example',
  'ATTENDEE;CN=Ines Okafor;PARTSTAT=ACCEPTED:mailto:ines@example.com',
  'ATTENDEE;CN=Noah Feld;ROLE=CHAIR;PARTSTAT=ACCEPTED:mailto:noah@fernway.example',
]
const event = (
  extra: string[] = [],
  base: string[] = [
    'UID:abc123def456@google.com',
    'DTSTART:20261113T180000Z',
    'DTEND:20261113T183000Z',
    'SUMMARY:Roadmap review',
  ],
) => [...base, ...extra]
const read = (text: string): CalendarSummary => {
  const found = summaryOfCalendar(text)
  if (found === null) throw new Error('expected a summary')
  return found
}
const ZONE = 'America/Los_Angeles'
const NOV_13_1000_PST = Date.UTC(2026, 10, 13, 18, 0)

describe('what the part is', () => {
  test('an invitation (a request at sequence 0, or with none), with its title, time, place, organizer and guests', () => {
    const s = read(
      calendar('REQUEST', [event([ORGANIZER, ...GUESTS, 'LOCATION:Room 4\\, Fernway office', 'SEQUENCE:0'])]),
    )
    expect(s).toMatchObject({
      kind: 'invitation',
      title: 'Roadmap review',
      allDay: false,
      start: NOV_13_1000_PST,
      end: NOV_13_1000_PST + 30 * 60_000,
      written: null,
      location: 'Room 4, Fernway office',
      organizer: { name: 'Noah Feld', address: 'noah@fernway.example' },
      repeats: false,
      occurrence: null,
      uid: 'abc123def456@google.com',
      moreEvents: 0,
    })
    // The organizer is not also a guest.
    expect(s.guests).toEqual([
      { name: 'Tessa Marlow', address: 'tessa@northfield.example' },
      { name: 'Ines Okafor', address: 'ines@example.com' },
    ])
    expect(isCalendarSummary(s)).toBe(true)
    expect(summaryHeading(s)).toBe('Invitation')
    expect(summaryWhen(s, ZONE)).toBe('Fri, Nov 13, 10:00 AM to 10:30 AM PST')
    expect(read(calendar('REQUEST', [event()])).kind).toBe('invitation')
  })

  test('an update is a request above sequence 0', () => {
    const s = read(calendar('REQUEST', [event(['SEQUENCE:3', ORGANIZER])]))
    expect(s.kind).toBe('update')
    expect(summaryHeading(s)).toBe('Updated invitation')
  })

  test('a cancellation keeps the time it was for', () => {
    const s = read(calendar('CANCEL', [event(['SEQUENCE:4', ORGANIZER, 'STATUS:CANCELLED'])]))
    expect(s.kind).toBe('cancelled')
    expect(s.start).toBe(NOV_13_1000_PST)
    expect(summaryHeading(s)).toBe('Cancelled')
  })

  test('a plain event: a published part, or one with no method (a booking site’s "add to calendar" file)', () => {
    expect(read(calendar('PUBLISH', [event()])).kind).toBe('event')
    expect(read(calendar(null, [event()])).kind).toBe('event')
    expect(summaryHeading(read(calendar(null, [event()])))).toBe('Event')
    // A method the table does not know is a plain event too.
    expect(read(calendar('REFRESH', [event()])).kind).toBe('event')
  })
})

describe('a guest’s answer', () => {
  const reply = (partstat: string, extra: string[] = [], base?: string[]) =>
    calendar('REPLY', [
      event([ORGANIZER, `ATTENDEE;PARTSTAT=${partstat};CN=Ines Okafor:mailto:ines@example.com`, ...extra], base),
    ])

  test.each([
    ['ACCEPTED', 'accepted', 'Ines Okafor accepted'],
    ['DECLINED', 'declined', 'Ines Okafor declined'],
    ['TENTATIVE', 'tentative', 'Ines Okafor said maybe'],
  ])('%s says who answered and how', (partstat, answer, heading) => {
    const s = read(reply(partstat))
    expect(s).toMatchObject({
      kind: 'reply',
      answer,
      by: { name: 'Ines Okafor', address: 'ines@example.com' },
      title: 'Roadmap review',
      start: NOV_13_1000_PST,
    })
    expect(summaryHeading(s)).toBe(heading)
    // The guests of an invitation are not on an answer.
    expect(s.guests).toEqual([])
  })

  test('an answer with no title and no time (some calendars send none) is still an answer, and has nothing to say of the meeting', () => {
    const s = read(reply('ACCEPTED', [], ['UID:abc123def456@google.com']))
    expect(s).toMatchObject({
      kind: 'reply',
      answer: 'accepted',
      title: '',
      start: null,
      end: null,
      startDate: null,
      written: null,
    })
    expect(summaryWhen(s, ZONE)).toBe('')
    expect(summaryLine(s, ZONE)).toBe('Ines Okafor accepted')
  })

  test('the guest’s note comes in their own words, with their line breaks', () => {
    const s = read(reply('TENTATIVE', ['COMMENT:Can we start at 11?\\nI have a call until then.']))
    expect(s.note).toBe('Can we start at 11?\nI have a call until then.')
  })

  test('a counter proposal is an answer whose time is the one proposed', () => {
    const s = read(
      calendar('COUNTER', [
        event(
          [
            'ORGANIZER;CN=Tessa Marlow:mailto:tessa@northfield.example',
            'ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=Lee Park:mailto:lee@example.com',
            'COMMENT:Friday works better.',
          ],
          [
            'UID:abc123def456@google.com',
            'DTSTART:20261114T220000Z',
            'DTEND:20261114T223000Z',
            'SUMMARY:Roadmap review',
          ],
        ),
      ]),
    )
    expect(s).toMatchObject({
      kind: 'reply',
      answer: 'counter',
      by: { name: 'Lee Park' },
      start: Date.UTC(2026, 10, 14, 22, 0),
      note: 'Friday works better.',
    })
    expect(summaryHeading(s)).toBe('Lee Park proposed a new time')
    expect(summaryLine(s, ZONE)).toBe(
      'Lee Park proposed a new time: Roadmap review, Sat, Nov 14, 2:00 PM to 2:30 PM PST',
    )
  })

  test('a guest the part gives no name is named by their address, and with no address at all by "A guest"', () => {
    expect(
      summaryHeading(read(calendar('REPLY', [event(['ATTENDEE;PARTSTAT=DECLINED:mailto:ines@example.com'])]))),
    ).toBe('ines@example.com declined')
    expect(summaryHeading(read(calendar('REPLY', [event(['ATTENDEE;PARTSTAT=DECLINED:not-an-address'])])))).toBe(
      'A guest declined',
    )
  })

  test('a reply with no recognised answer is read as a plain event, not as somebody’s answer', () => {
    expect(
      read(calendar('REPLY', [event([ORGANIZER, 'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:ines@example.com'])])).kind,
    ).toBe('event')
    expect(read(calendar('REPLY', [event([ORGANIZER])])).kind).toBe('event')
  })
})

describe('times', () => {
  test('a UTC time is a moment, shown on the company’s clock', () => {
    const s = read(calendar('REQUEST', [event()]))
    expect(summaryWhen(s, 'America/New_York')).toBe('Fri, Nov 13, 1:00 PM to 1:30 PM EST')
    expect(summaryWhen(s, 'Europe/Berlin')).toBe('Fri, Nov 13, 7:00 PM to 7:30 PM GMT+1')
  })

  test('a time in a zone the runtime knows is converted, with the clocks of that day (daylight time in June, standard in November)', () => {
    const june = read(
      calendar('REQUEST', [
        event(
          [],
          [
            'UID:a@x.example',
            'DTSTART;TZID=America/Los_Angeles:20260604T100000',
            'DTEND;TZID=America/Los_Angeles:20260604T110000',
            'SUMMARY:Standup',
          ],
        ),
      ]),
    )
    expect(june.start).toBe(Date.UTC(2026, 5, 4, 17, 0))
    const nov = read(
      calendar('REQUEST', [
        event([], ['UID:a@x.example', 'DTSTART;TZID=America/Los_Angeles:20261113T100000', 'SUMMARY:Standup']),
      ]),
    )
    expect(nov.start).toBe(NOV_13_1000_PST)
    expect(nov.end).toBeNull()
  })

  test('a Windows zone name (as Outlook writes it) goes through the table to its zone', () => {
    const s = read(
      calendar('REQUEST', [
        event(
          [],
          [
            'UID:outlook-style-uid-0001@example.com',
            'DTSTART;TZID="Pacific Standard Time":20261113T100000',
            'DTEND;TZID="Pacific Standard Time":20261113T110000',
            'SUMMARY:Budget review',
          ],
        ),
      ]),
    )
    expect(s.start).toBe(NOV_13_1000_PST)
    expect(s.end).toBe(NOV_13_1000_PST + 3_600_000)
    expect(s.written).toBeNull()
    const berlin = read(
      calendar('REQUEST', [
        event([], ['UID:b@x.example', 'DTSTART;TZID=W. Europe Standard Time:20261113T100000', 'SUMMARY:Budget review']),
      ]),
    )
    expect(berlin.start).toBe(Date.UTC(2026, 10, 13, 9, 0))
  })

  const customized = (tzid: string) => [
    'BEGIN:VTIMEZONE',
    `TZID:${tzid}`,
    'BEGIN:STANDARD',
    'DTSTART:16011104T020000',
    'TZOFFSETFROM:-0700',
    'TZOFFSETTO:-0800',
    'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'DTSTART:16010311T020000',
    'TZOFFSETFROM:-0800',
    'TZOFFSETTO:-0700',
    'RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
  ]

  test('a zone no table knows is read through the offsets the part’s own zone block gives, standard or daylight by its dates', () => {
    const at = (local: string) =>
      read(
        calendar(
          'REQUEST',
          [event([], ['UID:c@x.example', `DTSTART;TZID=Customized Time Zone:${local}`, 'SUMMARY:Planning'])],
          customized('Customized Time Zone'),
        ),
      ).start
    expect(at('20261113T100000')).toBe(Date.UTC(2026, 10, 13, 18, 0))
    expect(at('20260715T100000')).toBe(Date.UTC(2026, 6, 15, 17, 0))
    // The week the clocks go back (Sunday Nov 1, 2026 at 2am) and the week they go forward (Sunday Mar 8, 2026).
    expect(at('20261031T100000')).toBe(Date.UTC(2026, 9, 31, 17, 0))
    expect(at('20261101T100000')).toBe(Date.UTC(2026, 10, 1, 18, 0))
    expect(at('20260307T100000')).toBe(Date.UTC(2026, 2, 7, 18, 0))
    expect(at('20260308T100000')).toBe(Date.UTC(2026, 2, 8, 17, 0))
  })

  test('a floating time, or a zone nothing resolves, is kept as written and said so, never guessed', () => {
    const floating = read(
      calendar('REQUEST', [
        event([], ['UID:d@x.example', 'DTSTART:20261113T100000', 'DTEND:20261113T110000', 'SUMMARY:Lunch']),
      ]),
    )
    expect(floating).toMatchObject({
      start: null,
      end: null,
      written: { start: '2026-11-13T10:00', end: '2026-11-13T11:00', zone: null },
    })
    expect(summaryWhen(floating, ZONE)).toBe('Fri, Nov 13, 10:00 AM to 11:00 AM (the part gave no time zone)')
    const unknown = read(
      calendar('REQUEST', [
        event([], ['UID:e@x.example', 'DTSTART;TZID=Mystery Standard Time:20261113T140000', 'SUMMARY:Lunch']),
      ]),
    )
    expect(unknown.written).toEqual({ start: '2026-11-13T14:00', end: null, zone: 'Mystery Standard Time' })
    expect(summaryWhen(unknown, ZONE)).toBe(
      'Fri, Nov 13, 2:00 PM (in Mystery Standard Time, which the space could not read)',
    )
    expect(unknown.start).toBeNull()
  })

  test('an all-day event has days and no hour; its end is the day before the one the part names', () => {
    const one = read(
      calendar('REQUEST', [
        event([], ['UID:f@x.example', 'DTSTART;VALUE=DATE:20261113', 'DTEND;VALUE=DATE:20261114', 'SUMMARY:Offsite']),
      ]),
    )
    expect(one).toMatchObject({ allDay: true, start: null, end: null, startDate: '2026-11-13', endDate: '2026-11-13' })
    expect(summaryWhen(one, ZONE)).toBe('Fri, Nov 13, all day')
    const three = read(
      calendar('REQUEST', [
        event([], ['UID:g@x.example', 'DTSTART;VALUE=DATE:20261113', 'DTEND;VALUE=DATE:20261116', 'SUMMARY:Offsite']),
      ]),
    )
    expect(three).toMatchObject({ startDate: '2026-11-13', endDate: '2026-11-15' })
    expect(summaryWhen(three, ZONE)).toBe('Fri, Nov 13 to Sun, Nov 15, all day')
    // The days never move with the company's zone.
    expect(summaryWhen(one, 'Pacific/Auckland')).toBe('Fri, Nov 13, all day')
  })

  test('a duration takes the place of an end', () => {
    const s = read(
      calendar('REQUEST', [
        event([], ['UID:h@x.example', 'DTSTART:20261113T180000Z', 'DURATION:PT90M', 'SUMMARY:Workshop']),
      ]),
    )
    expect(s.end).toBe(NOV_13_1000_PST + 90 * 60_000)
  })

  test('an event that runs past midnight names the day it ends on', () => {
    const s = read(
      calendar('REQUEST', [
        event([], ['UID:i@x.example', 'DTSTART:20261114T040000Z', 'DTEND:20261114T120000Z', 'SUMMARY:Overnight']),
      ]),
    )
    expect(summaryWhen(s, ZONE)).toBe('Fri, Nov 13, 8:00 PM to Nov 14, 4:00 AM PST')
  })
})

describe('repeating events', () => {
  test('a repeating event says it repeats; a part about one occurrence says which', () => {
    const series = read(calendar('REQUEST', [event(['RRULE:FREQ=WEEKLY;BYDAY=FR'])]))
    expect(series).toMatchObject({ repeats: true, occurrence: null })
    const one = read(calendar('REQUEST', [event(['RECURRENCE-ID:20261120T180000Z'])]))
    expect(one).toMatchObject({ repeats: true, occurrence: { at: Date.UTC(2026, 10, 20, 18, 0), date: null } })
    const day = read(calendar('REQUEST', [event(['RECURRENCE-ID;VALUE=DATE:20261120'])]))
    expect(day.occurrence).toEqual({ at: null, date: '2026-11-20' })
  })
})

describe('more than one event, and parts that are not events', () => {
  test('a part of several events shows the first and counts the rest', () => {
    const s = read(
      calendar('PUBLISH', [
        event(),
        event([], ['UID:two@x.example', 'DTSTART:20261120T180000Z', 'SUMMARY:Second']),
        event([], ['UID:three@x.example', 'DTSTART:20261127T180000Z', 'SUMMARY:Third']),
      ]),
    )
    expect(s).toMatchObject({ title: 'Roadmap review', moreEvents: 2 })
  })

  test('no event, no calendar, a to-do, garbage and an empty part are no summary', () => {
    expect(summaryOfCalendar('')).toBeNull()
    expect(summaryOfCalendar('hello')).toBeNull()
    expect(summaryOfCalendar(ics(['BEGIN:VCALENDAR', 'VERSION:2.0', 'END:VCALENDAR']))).toBeNull()
    expect(
      summaryOfCalendar(ics(['BEGIN:VCALENDAR', 'BEGIN:VTODO', 'SUMMARY:Call', 'END:VTODO', 'END:VCALENDAR'])),
    ).toBeNull()
    expect(summaryOfCalendar('\u0000\u0001BEGIN:VEVENT\u0000')).toBeNull()
  })

  test('a malformed part never throws: a time that is not a time, an unclosed event, a line with no colon', () => {
    expect(() =>
      summaryOfCalendar(
        ics(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART:not a time', 'ATTENDEE', 'SUMMARY', 'END:VCALENDAR']),
      ),
    ).not.toThrow()
    const s = summaryOfCalendar(
      ics([
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:k@x.example',
        'DTSTART:99999999T999999Z',
        'SUMMARY:Odd',
        'END:VEVENT',
        'END:VCALENDAR',
      ]),
    )
    expect(s?.title).toBe('Odd')
    expect(s?.start).toBeNull()
  })

  test('a part over the limit is not read', () => {
    const big = calendar('REQUEST', [event([`DESCRIPTION:${'x'.repeat(CALENDAR_SUMMARY_PART_MAX)}`])])
    expect(summaryOfCalendar(big)).toBeNull()
    expect(summaryOfCalendar(calendar('REQUEST', [event([`DESCRIPTION:${'x'.repeat(10_000)}`])]))).not.toBeNull()
  })
})

describe('a stranger’s text', () => {
  test('control characters are removed and every text is cut to its limit; no link is kept', () => {
    const s = read(
      calendar('REPLY', [
        event(
          [
            ORGANIZER,
            `ATTENDEE;PARTSTAT=DECLINED;CN=${'N'.repeat(300)}:mailto:ines@example.com`,
            `LOCATION:${'L'.repeat(500)}`,
            `COMMENT:${'c'.repeat(900)}\\n\\n\\n\\n\\nend`,
          ],
          ['UID:abc@google.com', 'DTSTART:20261113T180000Z', `SUMMARY:Roadmap\\n\u0007review\u0001${'T'.repeat(500)}`],
        ),
      ]),
    )
    expect(s.title.length).toBe(200)
    expect(s.title.startsWith('Roadmap review TTT')).toBe(true)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find a control character
    expect(s.title).not.toMatch(/[\u0000-\u001f]/)
    expect(s.by?.name.length).toBe(100)
    expect(s.location.length).toBe(200)
    expect(s.note?.length).toBe(500)
    expect(JSON.stringify(s)).not.toMatch(/\\u0001|\\u0007/)
  })

  test('a place that is only a link is not kept, and no URL, attachment or conference property is read', () => {
    const s = read(
      calendar('REQUEST', [
        event([
          'LOCATION:https://meet.example.com/abc-defg-hij',
          'URL:https://example.com/x',
          'ATTACH:https://example.com/a.pdf',
          'X-GOOGLE-CONFERENCE:https://meet.example.com/abc-defg-hij',
        ]),
      ]),
    )
    expect(s.location).toBe('')
    expect(JSON.stringify(s)).not.toContain('http')
    expect(read(calendar('REQUEST', [event(['LOCATION:Room 4 (https://example.com/map)'])])).location).toBe(
      'Room 4 (https://example.com/map)',
    )
  })

  test('at most ten guests are kept and the rest counted; a room is not a guest', () => {
    const many = Array.from({ length: 14 }, (_, i) => `ATTENDEE;CN=Guest ${i + 1}:mailto:guest${i + 1}@example.com`)
    const s = read(
      calendar('REQUEST', [event([ORGANIZER, ...many, 'ATTENDEE;CUTYPE=ROOM;CN=Room 4:mailto:room4@example.com'])]),
    )
    expect(s.guests).toHaveLength(10)
    expect(s.guests[0]).toEqual({ name: 'Guest 1', address: 'guest1@example.com' })
    expect(s.guestsMore).toBe(4)
    expect(guestsWords(s)).toBe(`${s.guests.map((g) => g.name).join(', ')} and 4 more`)
    expect(
      guestsWords({
        guests: [
          { name: 'Ana', address: '' },
          { name: '', address: 'ben@example.com' },
          { name: 'Cal', address: '' },
        ],
        guestsMore: 0,
      }),
    ).toBe('Ana, ben@example.com and Cal')
    // Counted, with the stored summary a few kilobytes at most.
    expect(JSON.stringify(s).length).toBeLessThan(4096)
  })

  test('a name with a quoted semicolon, a folded line and an address in capitals are read whole', () => {
    const folded = calendar('REQUEST', [
      event([ORGANIZER, 'ATTENDEE;CN="Okafor; Ines":mailto:INES@Example.COM', 'SUMMARY:Roadmap\r\n  review']),
    ])
    const s = read(folded)
    expect(s.title).toBe('Roadmap review')
    expect(s.guests).toEqual([{ name: 'Okafor; Ines', address: 'ines@example.com' }])
  })
})

describe('the words', () => {
  test('the line for a list row: the heading, the title and the time; cut to a length', () => {
    const s = read(
      calendar('REPLY', [event([ORGANIZER, 'ATTENDEE;PARTSTAT=ACCEPTED;CN=Ines Okafor:mailto:ines@example.com'])]),
    )
    expect(summaryLine(s, ZONE)).toBe('Ines Okafor accepted: Roadmap review, Fri, Nov 13, 10:00 AM to 10:30 AM PST')
    expect(summaryLine(s, ZONE, 30)).toBe('Ines Okafor accepted: Roadmap…')
    expect(summaryLine(read(calendar('CANCEL', [event()])), ZONE)).toBe(
      'Cancelled: Roadmap review, Fri, Nov 13, 10:00 AM to 10:30 AM PST',
    )
  })

  test('what is stored is read back through the same guard, and anything else is no summary', () => {
    const s = read(calendar('REQUEST', [event([ORGANIZER, ...GUESTS])]))
    expect(parseCalendarSummary(JSON.stringify(s))).toEqual(s)
    expect(parseCalendarSummary('none')).toBeNull()
    expect(parseCalendarSummary(null)).toBeNull()
    expect(parseCalendarSummary('')).toBeNull()
    expect(parseCalendarSummary('{"kind":"invitation"}')).toBeNull()
    expect(parseCalendarSummary('not json')).toBeNull()
  })
})

describe('which part is read', () => {
  test('a declared calendar type, application/ics, or a file name ending in .ics, in any case', () => {
    expect(isCalendarPart('text/calendar; charset=UTF-8; method=REQUEST', undefined)).toBe(true)
    expect(isCalendarPart('TEXT/CALENDAR', '')).toBe(true)
    expect(isCalendarPart('application/ics', 'invite')).toBe(true)
    expect(isCalendarPart('application/octet-stream', 'invite.ICS')).toBe(true)
    expect(isCalendarPart('text/plain', undefined)).toBe(false)
    expect(isCalendarPart('application/pdf', 'ics.pdf')).toBe(false)
    expect(isCalendarPart(undefined, undefined)).toBe(false)
  })
})
