import { describe, expect, test } from 'bun:test'
import {
  type CalendarSummary,
  forWords,
  guestsWords,
  isCalendarSummary,
  isInboxCalendar,
  occurrenceWords,
  parseCalendarSummary,
  senderOf,
  safeSummaryLine,
  summaryHeading,
  summaryLine,
  summaryWhen,
} from '../src/calendar-summary'

/**
 * The words an email's calendar summary is said in, and the guard that reads it back: pure functions, so what a card, a list line and Claude's script say is a table. The reader that makes a summary from a calendar part is the inbox's
 * (packages/inbox/test/calendar-summary.test.ts); these take a summary as given. Every person is invented.
 */

const base: CalendarSummary = {
  kind: 'invitation',
  title: 'Roadmap review',
  allDay: false,
  start: Date.UTC(2026, 10, 13, 18, 0),
  end: Date.UTC(2026, 10, 13, 18, 30),
  startDate: null,
  endDate: null,
  written: null,
  location: '',
  organizer: null,
  guests: [],
  guestsMore: 0,
  repeats: false,
  occurrence: null,
  uid: 'roadmap@example.test',
  moreEvents: 0,
}
const ZONE = 'America/Los_Angeles'
const by = { name: 'Ana Vidal', address: 'ana@vidalcreative.example' }

describe('the heading says what the part is', () => {
  test.each([
    [{ kind: 'invitation' }, 'Invitation'],
    [{ kind: 'update' }, 'Updated invitation'],
    [{ kind: 'cancelled' }, 'Cancelled'],
    [{ kind: 'event' }, 'Event'],
    [{ kind: 'reply', answer: 'accepted', by }, 'Ana Vidal accepted'],
    [{ kind: 'reply', answer: 'declined', by }, 'Ana Vidal declined'],
    [{ kind: 'reply', answer: 'tentative', by }, 'Ana Vidal said maybe'],
    [{ kind: 'reply', answer: 'counter', by }, 'Ana Vidal proposed a new time'],
    [{ kind: 'reply', answer: 'accepted', by: { name: '', address: 'ana@vidalcreative.example' } }, 'ana@vidalcreative.example accepted'],
    [{ kind: 'reply', answer: 'accepted' }, 'A guest accepted'],
  ] as [Partial<CalendarSummary>, string][])('%j is "%s"', (over, heading) => {
    expect(summaryHeading({ ...base, ...over })).toBe(heading)
  })
})

describe('when it is, on the company’s clock', () => {
  test('a moment is named with its day and its zone, once for a range on one day, with the end day when it runs past midnight', () => {
    expect(summaryWhen(base, ZONE)).toBe('Fri, Nov 13, 10:00 AM to 10:30 AM PST')
    expect(summaryWhen(base, 'America/New_York')).toBe('Fri, Nov 13, 1:00 PM to 1:30 PM EST')
    expect(summaryWhen({ ...base, end: null }, ZONE)).toBe('Fri, Nov 13, 10:00 AM PST')
    expect(summaryWhen({ ...base, start: Date.UTC(2026, 10, 14, 4, 0), end: Date.UTC(2026, 10, 14, 12, 0) }, ZONE)).toBe('Fri, Nov 13, 8:00 PM to Nov 14, 4:00 AM PST')
  })

  test('an all-day event is its days and never moves with the zone', () => {
    const day = { ...base, allDay: true, start: null, end: null, startDate: '2026-11-13', endDate: '2026-11-13' }
    expect(summaryWhen(day, ZONE)).toBe('Fri, Nov 13, all day')
    expect(summaryWhen(day, 'Pacific/Auckland')).toBe('Fri, Nov 13, all day')
    expect(summaryWhen({ ...day, endDate: '2026-11-15' }, ZONE)).toBe('Fri, Nov 13 to Sun, Nov 15, all day')
  })

  test('a time that could not be resolved is said as written and not converted; no time at all is nothing', () => {
    const floating = { ...base, start: null, end: null, written: { start: '2026-11-13T10:00', end: '2026-11-13T11:30', zone: null } }
    expect(summaryWhen(floating, ZONE)).toBe('Fri, Nov 13, 10:00 AM to 11:30 AM (the part gave no time zone)')
    expect(summaryWhen({ ...floating, written: { start: '2026-11-13T00:30', end: '2026-11-14T01:00', zone: 'Customized Time Zone' } }, ZONE)).toBe(
      'Fri, Nov 13, 12:30 AM to Sat, Nov 14, 1:00 AM (in Customized Time Zone, which the space could not read)',
    )
    expect(summaryWhen({ ...base, start: null, end: null }, ZONE)).toBe('')
  })

  test('which occurrence of a repeating event', () => {
    expect(occurrenceWords({ ...base, occurrence: { at: Date.UTC(2026, 10, 20, 18, 0), date: null } }, ZONE)).toBe('the one on Fri, Nov 20')
    expect(occurrenceWords({ ...base, occurrence: { at: null, date: '2026-11-27' } }, ZONE)).toBe('the one on Fri, Nov 27')
    expect(occurrenceWords(base, ZONE)).toBe('')
  })
})

describe('the one line', () => {
  test('is the heading, the title and the time, cut to a length', () => {
    const answered: CalendarSummary = { ...base, kind: 'reply', answer: 'accepted', by }
    expect(summaryLine(answered, ZONE)).toBe('Ana Vidal accepted: Roadmap review, Fri, Nov 13, 10:00 AM to 10:30 AM PST')
    expect(summaryLine({ ...answered, title: '', start: null, end: null }, ZONE)).toBe('Ana Vidal accepted')
    expect(summaryLine({ ...answered, start: null, end: null }, ZONE)).toBe('Ana Vidal accepted: Roadmap review')
    expect(summaryLine(answered, ZONE, 25)).toBe('Ana Vidal accepted: Road…')
  })

  test('guests are named, ten at most, with the count of the rest', () => {
    expect(guestsWords({ guests: [], guestsMore: 0 })).toBe('')
    expect(guestsWords({ guests: [], guestsMore: 3 })).toBe('3 guests')
    expect(guestsWords({ guests: [], guestsMore: 1 })).toBe('1 guest')
    expect(guestsWords({ guests: [by], guestsMore: 0 })).toBe('Ana Vidal')
    expect(guestsWords({ guests: [by, { name: '', address: 'ben@example.com' }], guestsMore: 0 })).toBe('Ana Vidal and ben@example.com')
    expect(guestsWords({ guests: [by, { name: 'Ben Cole', address: '' }], guestsMore: 5 })).toBe('Ana Vidal, Ben Cole and 5 more')
  })
})

describe('what is read back', () => {
  test('a summary is one; anything else, a half summary, `none` and NULL are not', () => {
    expect(isCalendarSummary(base)).toBe(true)
    expect(isCalendarSummary({ ...base, kind: 'bogus' })).toBe(false)
    expect(isCalendarSummary({ ...base, start: 'soon' })).toBe(false)
    expect(isCalendarSummary({ ...base, guests: [{ name: 'x' }] })).toBe(false)
    expect(isCalendarSummary({ ...base, answer: 'maybe' })).toBe(false)
    expect(isCalendarSummary({ ...base, startDate: '13/11/2026' })).toBe(false)
    expect(isCalendarSummary(null)).toBe(false)
    expect(isCalendarSummary([])).toBe(false)
    expect(parseCalendarSummary(JSON.stringify(base))).toEqual(base)
    expect(parseCalendarSummary('none')).toBeNull()
    expect(parseCalendarSummary(null)).toBeNull()
    expect(parseCalendarSummary(undefined)).toBeNull()
    expect(parseCalendarSummary('{"kind":"invitation"}')).toBeNull()
  })

  test('what the inbox hands the space carries whether the organizer is the person asking', () => {
    expect(isInboxCalendar({ ...base, fromYou: false })).toBe(true)
    expect(isInboxCalendar(base)).toBe(false)
    expect(isInboxCalendar({ ...base, fromYou: 'yes' })).toBe(false)
  })
})

describe('a summary that cannot be said', () => {
  test('a moment outside the range of a Date, and a day that is not a day, are not in a summary', () => {
    expect(isCalendarSummary({ ...base, end: 8_710_914_564_000_000 })).toBe(false)
    expect(isCalendarSummary({ ...base, start: -8_710_914_564_000_000 })).toBe(false)
    expect(isCalendarSummary({ ...base, occurrence: { at: 8_710_914_564_000_000, date: null } })).toBe(false)
    expect(isCalendarSummary({ ...base, startDate: '2026-13-45' })).toBe(false)
    expect(isCalendarSummary({ ...base, occurrence: { at: null, date: '2026-02-31x' } })).toBe(false)
    expect(isCalendarSummary({ ...base, start: 8.64e15, end: -8.64e15 })).toBe(true)
  })

  test('the safe line is the line, and nothing when wording throws (a zone the runtime does not know)', () => {
    expect(safeSummaryLine(base, ZONE)).toBe('Invitation: Roadmap review, Fri, Nov 13, 10:00 AM to 10:30 AM PST')
    expect(() => summaryLine(base, 'Nowhere/Bad')).toThrow()
    expect(safeSummaryLine(base, 'Nowhere/Bad')).toBe('')
  })
})

describe('the name a guest has when the part gives none: the one the email came From', () => {
  const answered: CalendarSummary = { ...base, kind: 'reply', answer: 'accepted', by: { name: '', address: 'ana@vidalcreative.example' } }

  test('the From header is read: a display name, a quoted one, none, and only an address', () => {
    expect(senderOf('Ana Vidal <Ana@VidalCreative.example>')).toEqual({ name: 'Ana Vidal', address: 'ana@vidalcreative.example' })
    expect(senderOf('"Vidal, Ana" <ana@vidalcreative.example>')).toEqual({ name: 'Vidal, Ana', address: 'ana@vidalcreative.example' })
    expect(senderOf('<ana@vidalcreative.example>')).toEqual({ name: '', address: 'ana@vidalcreative.example' })
    expect(senderOf('ana@vidalcreative.example')).toEqual({ name: '', address: 'ana@vidalcreative.example' })
    expect(senderOf('ana@vidalcreative.example <ana@vidalcreative.example>')).toEqual({ name: '', address: 'ana@vidalcreative.example' })
    expect(senderOf('Ana')).toBeNull()
    expect(senderOf('')).toBeNull()
    expect(senderOf(undefined)).toBeNull()
    expect(senderOf(`${'x'.repeat(700)} <a@b.example>`)).toBeNull()
  })

  test('a guest with no name, whose address is the sender’s, takes the sender’s display name, in the heading and the line', () => {
    const from = 'Ana Vidal <ana@vidalcreative.example>'
    expect(summaryHeading(forWords(answered, from))).toBe('Ana Vidal accepted')
    expect(summaryLine(answered, ZONE, 160, from)).toBe('Ana Vidal accepted: Roadmap review, Fri, Nov 13, 10:00 AM to 10:30 AM PST')
    // As stored (no name), without a From, or from a header that has no name: the address, as it was.
    expect(summaryLine(answered, ZONE)).toBe('ana@vidalcreative.example accepted: Roadmap review, Fri, Nov 13, 10:00 AM to 10:30 AM PST')
    expect(summaryLine(answered, ZONE, 160, 'ana@vidalcreative.example')).toContain('ana@vidalcreative.example accepted')
    expect(summaryLine(answered, ZONE, 160, '<ana@vidalcreative.example>')).toContain('ana@vidalcreative.example accepted')
  })

  test('nothing else is renamed: a named guest, an address that is not the sender’s, the guests; the organizer is named the same way as the guest', () => {
    const from = 'Ana Vidal <ana@vidalcreative.example>'
    expect(forWords({ ...answered, by: { name: 'A. Vidal', address: 'ana@vidalcreative.example' } }, from).by?.name).toBe('A. Vidal')
    expect(forWords({ ...answered, by: { name: '', address: 'someone.else@example.com' } }, from).by?.name).toBe('')
    const invited: CalendarSummary = { ...base, organizer: { name: '', address: 'ana@vidalcreative.example' }, guests: [{ name: '', address: 'ana@vidalcreative.example' }] }
    expect(forWords(invited, from).organizer?.name).toBe('Ana Vidal')
    expect(forWords(invited, from).guests).toEqual(invited.guests)
    expect(forWords({ ...invited, organizer: null }, from).organizer).toBeNull()
    // The extras an answer to the page carries ride through.
    expect((forWords({ ...invited, fromYou: true } as CalendarSummary, from) as unknown as { fromYou: boolean }).fromYou).toBe(true)
  })
})

describe('an answer’s title does not say the answer twice', () => {
  const answered = (title: string): CalendarSummary => ({ ...base, kind: 'reply', answer: 'accepted', by, title })

  test.each([
    ['Accepted: Roadmap review', 'Roadmap review'],
    ['accepted:Roadmap review', 'Roadmap review'],
    ['DECLINED : Roadmap review', 'Roadmap review'],
    ['Tentative: Roadmap review', 'Roadmap review'],
    ['Angenommen: Roadmap review', 'Roadmap review'],
    ['Abgelehnt: Roadmap review', 'Roadmap review'],
    ['Mit Vorbehalt: Roadmap review', 'Roadmap review'],
  ])('%s is "%s"', (title, left) => {
    expect(forWords(answered(title)).title).toBe(left)
    expect(summaryLine(answered(title), ZONE)).toBe(`Ana Vidal accepted: ${left}, Fri, Nov 13, 10:00 AM to 10:30 AM PST`)
  })

  test('only at the very start, only once, and never leaving an empty title', () => {
    expect(forWords(answered('Roadmap review: Accepted: soon')).title).toBe('Roadmap review: Accepted: soon')
    expect(forWords(answered('Re: Accepted: Roadmap review')).title).toBe('Re: Accepted: Roadmap review')
    expect(forWords(answered('Accepted: Declined: Roadmap')).title).toBe('Declined: Roadmap')
    expect(forWords(answered('Accepted:')).title).toBe('Accepted:')
    expect(forWords(answered('Accepted:   ')).title).toBe('Accepted:   ')
    expect(forWords(answered('Acceptance: Roadmap')).title).toBe('Acceptance: Roadmap')
  })

  test('an invitation, an update, a cancellation or an event titled "Accepted: ..." is left alone', () => {
    for (const kind of ['invitation', 'update', 'cancelled', 'event'] as const) {
      expect(forWords({ ...base, kind, title: 'Accepted: Roadmap review' }).title).toBe('Accepted: Roadmap review')
    }
  })
})
