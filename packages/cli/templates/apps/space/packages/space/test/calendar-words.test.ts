import { describe, expect, test } from 'bun:test'
import type { CalendarEvent } from '@space/workspace'
import {
  accountsWords,
  addDays,
  agendaDays,
  cardWhen,
  clock,
  dayHeading,
  dayKey,
  daysOf,
  dayStart,
  guestResponse,
  responseTag,
  startWords,
  timeRange,
} from '../src/client/calendar-words'

/**
 * What the Calendar tab says, on the company's clock: which day an event is on, how a day and a time read, who answered what. The company's zone is Los Angeles; the clocks go back on Sunday 1 November 2026.
 */

const ZONE = 'America/Los_Angeles'
const la = (iso: string): number => Date.parse(iso)
// Thursday 5 November 2026, 4:30 PM in Los Angeles (PST, UTC-8).
const NOW = la('2026-11-06T00:30:00Z')

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'a|b|c',
  title: 'Standup',
  start: la('2026-11-06T17:00:00Z'),
  end: la('2026-11-06T17:30:00Z'),
  allDay: false,
  startDate: null,
  endDate: null,
  location: null,
  videoLink: null,
  htmlLink: null,
  description: null,
  status: 'confirmed',
  response: null,
  organizer: null,
  guests: [],
  guestsLeft: 0,
  accounts: [{ address: 'tessa@northfield.example', label: 'northfield', hue: 0 }],
  free: false,
  readAt: NOW,
  stale: false,
  ...over,
})

describe('the company’s days', () => {
  test('a moment is on the day the company’s clock says, not UTC’s', () => {
    // 4:30 PM on the 5th in Los Angeles is already the 6th in UTC.
    expect(dayKey(NOW, ZONE)).toBe('2026-11-05')
    expect(dayKey(la('2026-11-06T07:59:00Z'), ZONE)).toBe('2026-11-05')
    expect(dayKey(la('2026-11-06T08:00:00Z'), ZONE)).toBe('2026-11-06')
  })

  test('a day begins at midnight on that clock, and a day where the clocks change is 25 hours long', () => {
    expect(dayStart(NOW, ZONE)).toBe(la('2026-11-05T08:00:00Z'))
    expect(dayStart(la('2026-10-31T20:00:00Z'), ZONE, 1) - dayStart(la('2026-10-31T20:00:00Z'), ZONE)).toBe(24 * 3_600_000)
    const sat = la('2026-11-01T01:00:00Z') // Saturday night, Oct 31 in Los Angeles
    expect(dayStart(sat, ZONE, 1) - dayStart(sat, ZONE)).toBe(24 * 3_600_000)
    const sun = la('2026-11-01T20:00:00Z')
    expect(dayStart(sun, ZONE, 1) - dayStart(sun, ZONE)).toBe(25 * 3_600_000)
  })

  test('days add without a zone, across a month and a year', () => {
    expect(addDays('2026-11-05', 1)).toBe('2026-11-06')
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  test('a day is Today, Tomorrow, or its weekday and date (with the year when it is another year)', () => {
    expect(dayHeading('2026-11-05', '2026-11-05')).toBe('Today')
    expect(dayHeading('2026-11-06', '2026-11-05')).toBe('Tomorrow')
    expect(dayHeading('2026-11-09', '2026-11-05')).toBe('Monday, Nov 9')
    expect(dayHeading('2027-01-04', '2026-12-30')).toBe('Monday, Jan 4, 2027')
  })
})

describe('an event’s time', () => {
  test('a timed event reads as its start and end on the company’s clock', () => {
    expect(clock(la('2026-11-06T17:00:00Z'), ZONE)).toBe('9:00 AM')
    expect(timeRange(event(), ZONE)).toBe('9:00 AM to 9:30 AM')
    expect(startWords(event(), ZONE)).toBe('9:00 AM')
  })

  test('one that ends on another day says so', () => {
    const late = event({ start: la('2026-11-06T05:00:00Z'), end: la('2026-11-06T09:00:00Z') })
    expect(timeRange(late, ZONE)).toBe('9:00 PM to Nov 6, 1:00 AM')
  })

  test('the card names the day and the zone', () => {
    expect(cardWhen(event(), ZONE)).toBe('Fri, Nov 6, 9:00 AM to 9:30 AM PST')
    // After the clocks go back it is PST; before, PDT.
    expect(cardWhen(event({ start: la('2026-10-30T16:00:00Z'), end: la('2026-10-30T17:00:00Z') }), ZONE)).toBe('Fri, Oct 30, 9:00 AM to 10:00 AM PDT')
  })

  test('an all-day event has days and no hour, and says so whatever the reader’s zone', () => {
    const one = event({ allDay: true, startDate: '2026-11-06', endDate: '2026-11-06', start: la('2026-11-06T08:00:00Z'), end: la('2026-11-07T08:00:00Z') })
    const two = event({ allDay: true, startDate: '2026-11-06', endDate: '2026-11-08', start: la('2026-11-06T08:00:00Z'), end: la('2026-11-09T08:00:00Z') })
    expect(timeRange(one, ZONE)).toBe('All day')
    expect(startWords(one, ZONE)).toBe('All day')
    expect(timeRange(two, ZONE)).toBe('All day, Nov 6 to Nov 8')
    expect(cardWhen(one, ZONE)).toBe('Fri, Nov 6, all day')
    expect(cardWhen(two, ZONE)).toBe('Fri, Nov 6 to Sun, Nov 8, all day')
    expect(daysOf(two, ZONE)).toEqual(['2026-11-06', '2026-11-07', '2026-11-08'])
    expect(daysOf(event(), ZONE)).toEqual(['2026-11-06'])
  })
})

describe('who answered what', () => {
  test('an unanswered invitation is named, a declined one and a maybe too, and an acceptance is not news', () => {
    expect(responseTag('needsAction')).toBe('Not answered')
    expect(responseTag('declined')).toBe('Declined')
    expect(responseTag('tentative')).toBe('Maybe')
    expect(responseTag('accepted')).toBeNull()
    expect(responseTag(null)).toBeNull()
    expect(guestResponse).toEqual({ accepted: 'Yes', declined: 'No', tentative: 'Maybe', needsAction: 'Not answered' })
  })

  test('accounts read as a list', () => {
    const m = (label: string) => ({ address: `${label}@x.example`, label, hue: 0 })
    expect(accountsWords([m('northfield')])).toBe('northfield')
    expect(accountsWords([m('northfield'), m('ashgrove')])).toBe('northfield and ashgrove')
    expect(accountsWords([m('northfield'), m('ashgrove'), m('fernway')])).toBe('northfield, ashgrove and fernway')
  })
})

describe('the agenda by day', () => {
  const meeting = { id: 'call-1', title: 'Menu page review', startsAt: la('2026-11-06T18:00:00Z'), link: 'https://space.northfield.example/r/call-1', with: ['Lena'] }

  test('Today is always a day, even with nothing on it; another day is there only when something is', () => {
    const days = agendaDays([], [], NOW, ZONE, 14)
    expect(days.map((d) => [d.heading, d.items.length])).toEqual([['Today', 0]])
    const some = agendaDays([event()], [], NOW, ZONE, 14)
    expect(some.map((d) => d.heading)).toEqual(['Today', 'Tomorrow'])
  })

  test('events and Meet’s meetings are merged by time under the company’s day, all-day first', () => {
    const days = agendaDays(
      [
        event({ id: 'late', title: 'Late', start: la('2026-11-06T22:00:00Z'), end: la('2026-11-06T23:00:00Z') }),
        event({ id: 'all', title: 'Off site', allDay: true, startDate: '2026-11-06', endDate: '2026-11-06', start: la('2026-11-06T08:00:00Z'), end: la('2026-11-07T08:00:00Z') }),
        event({ id: 'early', title: 'Early' }),
      ],
      [meeting],
      NOW,
      ZONE,
      14,
    )
    const tomorrow = days.find((d) => d.key === '2026-11-06')
    expect(tomorrow?.items.map((i) => (i.kind === 'event' ? i.event.title : i.meeting.title))).toEqual(['Off site', 'Early', 'Menu page review', 'Late'])
  })

  test('a multi-day all-day event is under each day it covers; one outside the window is not drawn', () => {
    const offsite = event({ id: 'o', title: 'Offsite', allDay: true, startDate: '2026-11-07', endDate: '2026-11-09', start: la('2026-11-07T08:00:00Z'), end: la('2026-11-10T08:00:00Z') })
    const far = event({ id: 'far', title: 'Far', start: la('2027-03-01T17:00:00Z'), end: la('2027-03-01T18:00:00Z') })
    const days = agendaDays([offsite, far], [], NOW, ZONE, 14)
    expect(days.map((d) => d.key)).toEqual(['2026-11-05', '2026-11-07', '2026-11-08', '2026-11-09'])
  })

  test('yesterday’s events are not in an agenda that begins today', () => {
    const past = event({ id: 'p', title: 'Yesterday', start: la('2026-11-04T17:00:00Z'), end: la('2026-11-04T18:00:00Z') })
    expect(agendaDays([past], [], NOW, ZONE, 14).flatMap((d) => d.items)).toEqual([])
  })
})
