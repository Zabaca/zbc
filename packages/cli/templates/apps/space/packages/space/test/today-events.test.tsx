// Google's events on Today: Later today and Tomorrow list the calendar's events with Meet's meetings, each opening its card in the Calendar tab. What is asserted is the answer
// the real `today()` gives over stand-in apps and what the page draws from it. T0 is 12:00 UTC on 1 November 2026, which is 04:00 in Los Angeles on the morning the clocks go back there (the company's day is 25 hours long).
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CalendarEvent } from '@space/workspace'
import { T0, northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { TodayScreen } from '../src/client/Today'
import { standInCalendar } from '../src/stand-in-calendar'
import { standInForms, standInInbox, standInMeet } from '../src/stand-ins'
import { bucketEvents, today } from '../src/today'
import type { TodayAnswer } from '../src/today-shape'
import { OWNER_SIGNED_IN } from './signed-in'

const ZONE = 'America/Los_Angeles'
const install = northfield()
const ME = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, install)
const MIN = 60_000
const HOUR = 60 * MIN

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'a|b|c',
  title: 'Standup',
  start: T0 + HOUR,
  end: T0 + 2 * HOUR,
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
  readAt: T0,
  stale: false,
  ...over,
})

async function answer(options: { calendar?: boolean; down?: boolean; meetings?: Parameters<typeof standInMeet>[1] } = {}): Promise<TodayAnswer> {
  const calendar = standInCalendar(T0, ZONE)
  if (options.down) calendar.methods.agenda = async () => Promise.reject(new Error('down'))
  const apps = {
    inbox: standInInbox([], []),
    meet: standInMeet({ direct: [], channels: [] }, options.meetings ?? {}),
    forms: standInForms([]),
    ...(options.calendar === false ? {} : { calendar: calendar.methods }),
  }
  return today({ apps, install, signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50, now: () => T0 })
}

describe('the answer', () => {
  test('Later today is the calendar’s events from now to the company’s midnight, all-day first and then by time; one already over is not in it', async () => {
    const a = await answer()
    expect(a.events.connected).toBe(true)
    expect(a.events.listed).toBe(true)
    expect(a.events.laterToday.map((e) => e.title)).toEqual(['Ashgrove board packet due', 'Northfield Works standup', 'Intro chat with Arun Mehta', 'Board call'])
    expect(a.events.laterToday[0]).toMatchObject({ allDay: true })
  })

  test('Tomorrow is the next company day’s, and an invitation declined is not on the day', async () => {
    const a = await answer()
    expect(a.events.tomorrow.map((e) => e.title)).toEqual(['Weekly planning', 'Lunch with Dana', 'Advisory intro: Maria Lopez'])
  })

  test('a row carries what it draws and the card’s key, and the same meeting on two calendars is one row naming both', async () => {
    const a = await answer()
    const board = a.events.laterToday.find((e) => e.title === 'Board call')
    expect(board?.accounts.map((x) => x.label)).toEqual(['northfield', 'ashgrove'])
    expect(board?.videoLink).toBe('https://meet.google.com/xyz-board-call')
    expect(board?.id).toMatch(/^tessa@ashgrove\.example\|/)
    // The guests, the notes and the organiser are the card's, not Today's.
    expect(Object.keys(board ?? {}).sort()).toEqual(['accounts', 'allDay', 'end', 'endDate', 'id', 'location', 'response', 'stale', 'start', 'startDate', 'status', 'title', 'videoLink'].sort())
  })

  test('the calendar not answering leaves the rest of Today and says Google’s events are not listed', async () => {
    const a = await answer({ down: true })
    expect(a.events).toEqual({ connected: true, listed: false, laterToday: [], tomorrow: [] })
    expect(a.sources.every((s) => s.state === 'ok')).toBe(true)
  })

  test('an install without the calendar says nothing about it', async () => {
    const a = await answer({ calendar: false })
    expect(a.events).toEqual({ connected: false, listed: false, laterToday: [], tomorrow: [] })
  })
})

describe('sorting into the two days', () => {
  const day = (iso: string) => Date.parse(iso)
  // 04:00 in Los Angeles on 1 November 2026; the company's day runs to 08:00 UTC on the 2nd (25 hours), tomorrow to 08:00 UTC on the 3rd.
  test('a timed event that has started is not later; one at the instant of midnight is tomorrow', () => {
    const b = bucketEvents(
      [
        event({ id: 'started', start: T0 - HOUR, end: T0 + HOUR }),
        event({ id: 'soon', start: T0 + 1, end: T0 + HOUR }),
        event({ id: 'midnight', start: day('2026-11-02T08:00:00Z'), end: day('2026-11-02T09:00:00Z') }),
        event({ id: 'last-minute', start: day('2026-11-02T07:59:00Z'), end: day('2026-11-02T08:30:00Z') }),
        event({ id: 'day-after', start: day('2026-11-03T08:00:00Z'), end: day('2026-11-03T09:00:00Z') }),
      ],
      T0,
      ZONE,
    )
    expect(b.laterToday.map((e) => e.id)).toEqual(['soon', 'last-minute'])
    expect(b.tomorrow.map((e) => e.id)).toEqual(['midnight'])
  })

  test('an all-day event is drawn under each day it covers, even though it began at midnight', () => {
    const covers = event({ id: 'offsite', allDay: true, startDate: '2026-11-01', endDate: '2026-11-02', start: day('2026-11-01T07:00:00Z'), end: day('2026-11-03T08:00:00Z') })
    const b = bucketEvents([covers], T0, ZONE)
    expect(b.laterToday.map((e) => e.id)).toEqual(['offsite'])
    expect(b.tomorrow.map((e) => e.id)).toEqual(['offsite'])
    const yesterday = event({ id: 'old', allDay: true, startDate: '2026-10-31', endDate: '2026-10-31', start: day('2026-10-31T07:00:00Z'), end: day('2026-11-01T07:00:00Z') })
    expect(bucketEvents([yesterday], T0, ZONE).laterToday).toEqual([])
  })

  test('a declined invitation is left out, an unanswered one and a maybe stay', () => {
    const b = bucketEvents([event({ id: 'no', response: 'declined' }), event({ id: 'unanswered', response: 'needsAction' }), event({ id: 'maybe', response: 'tentative' })], T0, ZONE)
    expect(b.laterToday.map((e) => e.id).sort()).toEqual(['maybe', 'unanswered'])
  })
})

describe('what the page draws', () => {
  const screen = (a: TodayAnswer) => renderToStaticMarkup(<TodayScreen me={ME} now={T0} answer={a} loading={false} problem={null} go={() => undefined} />)
  const rows = (html: string, id: string) => {
    const sec = new RegExp(`<section class="tsec" data-section="${id}".*?</section>`, 's').exec(html)?.[0] ?? ''
    return [...sec.matchAll(/<li>(.*?)<\/li>/gs)].map((m) => ({ html: m[1] as string, text: (m[1] as string).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }))
  }

  test('Later today and Tomorrow list the calendar’s events, each opening its card in the Calendar tab, with the account it is on', async () => {
    const html = screen(await answer())
    const later = rows(html, 'later')
    expect(later.map((r) => r.text.split(' Calendar')[0])).toEqual([
      expect.stringContaining('Ashgrove board packet due'),
      expect.stringContaining('Northfield Works standup'),
      expect.stringContaining('Intro chat with Arun Mehta'),
      expect.stringContaining('Board call'),
    ])
    expect(later[1]?.text).toContain('northfield')
    expect(later[3]?.text).toContain('northfield and ashgrove')
    const hrefs = [...(/data-section="later".*?<\/section>/s.exec(html)?.[0] ?? '').matchAll(/<a class="trow" href="([^"]+)"/g)].map((m) => m[1] as string)
    expect(hrefs.every((h) => h.startsWith('/calendar/event/'))).toBe(true)
    // The key is the calendar's and Google's ids joined by a bar, one path segment.
    expect(decodeURIComponent((hrefs[1] as string).slice('/calendar/event/'.length))).toMatch(/^tessa@northfield\.example\|tessa@northfield\.example\|ev\d+$/)
    expect(rows(html, 'tomorrow').map((r) => r.text)).toEqual([expect.stringContaining('Weekly planning'), expect.stringContaining('Lunch with Dana'), expect.stringContaining('Advisory intro: Maria Lopez')])
  })

  test('an invitation not answered says so, and a call link Google holds is a Join of its own', async () => {
    const html = screen(await answer())
    const intro = rows(html, 'later').find((r) => r.text.includes('Intro chat'))
    expect(intro?.text).toContain('Not answered')
    const standup = rows(html, 'later').find((r) => r.text.includes('Northfield Works standup'))
    expect(standup?.html).toContain('href="https://meet.google.com/abc-defg-hij"')
    expect(standup?.html).toContain('target="_blank"')
    expect(standup?.html).toContain('rel="noopener noreferrer"')
  })

  test('Meet’s meetings and the calendar’s events share the day in order of time', async () => {
    const a = await answer()
    const meeting = { id: 'between', title: 'Booked in Meet', startsAt: (a.events.laterToday[2]?.start ?? T0 + 3 * HOUR) - 1 }
    const html = screen({ ...a, laterToday: [meeting] })
    const order = rows(html, 'later').map((r) => r.text)
    const at = (title: string) => order.findIndex((t) => t.includes(title))
    expect(at('Ashgrove board packet due')).toBe(0)
    expect(at('Northfield Works standup')).toBeLessThan(at('Booked in Meet'))
    expect(at('Booked in Meet') + 1).toBe(at('Intro chat with Arun Mehta'))
  })

  test('when the calendar does not answer a line says so and the meetings still show; when there is no calendar at all it says nothing', async () => {
    const down = screen(await answer({ down: true }))
    expect(down).toContain('data-notice="events"')
    expect(down).toContain('Your Google calendars are not listed right now')
    const none = screen(await answer({ calendar: false }))
    expect(none).not.toContain('data-notice="events"')
  })

  test('nothing on either day says so, in words that include the calendar', async () => {
    const a = await answer()
    const html = screen({ ...a, laterToday: [], tomorrow: [], events: { connected: true, listed: true, laterToday: [], tomorrow: [] } })
    expect(html).toContain('Nothing on your calendars or booked in Meet')
  })
})
