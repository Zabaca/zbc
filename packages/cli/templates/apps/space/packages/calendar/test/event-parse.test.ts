import { describe, expect, test } from 'bun:test'
import { htmlToText, parseEvent, cleanText, googleLink, httpsLink, lastDay, type ParsedEvent } from '../src/event-parse'

const ZONE = 'America/Los_Angeles'
const timed = (extra: Record<string, unknown> = {}) => ({
  id: 'e1',
  status: 'confirmed',
  summary: 'Standup',
  start: { dateTime: '2026-11-06T09:00:00-08:00' },
  end: { dateTime: '2026-11-06T09:30:00-08:00' },
  ...extra,
})
const event = (raw: unknown): ParsedEvent => {
  const got = parseEvent(raw, ZONE)
  if (got.kind !== 'event') throw new Error(`not an event: ${JSON.stringify(got)}`)
  return got
}

describe('reading a timed event', () => {
  test('its title and its times, in milliseconds, whatever offset Google files it under', () => {
    const e = event(timed())
    expect(e).toMatchObject({ id: 'e1', title: 'Standup', allDay: false, startDate: null, endDate: null, status: 'confirmed' })
    expect(e.start).toBe(Date.parse('2026-11-06T17:00:00Z'))
    expect(e.end - e.start).toBe(30 * 60_000)
    expect(event(timed({ start: { dateTime: '2026-11-06T17:00:00Z' }, end: { dateTime: '2026-11-06T17:30:00Z' } })).start).toBe(e.start)
  })

  test('no title is “(No title)”; a tentative event and a free one are marked', () => {
    expect(event(timed({ summary: undefined })).title).toBe('(No title)')
    const e = event(timed({ status: 'tentative', transparency: 'transparent' }))
    expect(e.status).toBe('tentative')
    expect(e.free).toBe(true)
  })

  test('an event with no end is as long as its start; one that ends before it starts is clamped', () => {
    expect(event(timed({ end: undefined })).end).toBe(event(timed()).start)
    expect(event(timed({ end: { dateTime: '2026-11-06T08:00:00-08:00' } })).end).toBe(event(timed()).start)
  })
})

describe('reading an all-day event', () => {
  test('it has days and no hour: midnight to midnight on the company’s clock, and the days as Google gives them', () => {
    const e = event({ id: 'a', summary: 'Off site', start: { date: '2026-11-06' }, end: { date: '2026-11-08' } })
    expect(e).toMatchObject({ allDay: true, startDate: '2026-11-06', endDate: '2026-11-08' })
    expect(e.start).toBe(Date.parse('2026-11-06T08:00:00Z')) // midnight in Los Angeles, PST
    expect(e.end).toBe(Date.parse('2026-11-08T08:00:00Z'))
    expect(lastDay('2026-11-08')).toBe('2026-11-07')
  })

  test('the day the clocks go back is 25 hours, and the event still starts and ends at midnight', () => {
    const e = event({ id: 'a', start: { date: '2026-11-01' }, end: { date: '2026-11-02' } })
    expect(e.end - e.start).toBe(25 * 3_600_000)
  })

  test('one with no end date is one day', () => {
    const e = event({ id: 'a', start: { date: '2026-11-06' } })
    expect(e.endDate).toBe('2026-11-07')
  })
})

describe('what is left out or removed', () => {
  test('a cancelled event is gone, and keeps only its id', () => {
    expect(parseEvent({ id: 'x', status: 'cancelled' }, ZONE)).toEqual({ kind: 'gone', id: 'x' })
  })

  test('a working-location entry is not a meeting; an event with no readable time or id is skipped', () => {
    expect(parseEvent(timed({ eventType: 'workingLocation' }), ZONE).kind).toBe('skipped')
    expect(parseEvent({ id: 'x', start: {}, end: {} }, ZONE).kind).toBe('skipped')
    expect(parseEvent({ summary: 'no id', start: { date: '2026-11-06' } }, ZONE).kind).toBe('skipped')
    expect(parseEvent('nope', ZONE).kind).toBe('skipped')
  })
})

describe('guests and the person’s own answer', () => {
  const attendees = [
    { email: 'Dana@Example.com', displayName: 'Dana Smith', responseStatus: 'accepted', organizer: true },
    { email: 'tessa@northfield.example', self: true, responseStatus: 'needsAction' },
    { email: 'arun@example.org' },
  ]
  test('each guest, how they answered, and which is the account itself', () => {
    const e = event(timed({ attendees }))
    expect(e.guests).toEqual([
      { name: 'Dana Smith', email: 'dana@example.com', response: 'accepted', organizer: true, self: false },
      { name: null, email: 'tessa@northfield.example', response: 'needsAction', organizer: false, self: true },
      { name: null, email: 'arun@example.org', response: 'needsAction', organizer: false, self: false },
    ])
    expect(e.response).toBe('needsAction')
  })

  test('an event with no guest of the account itself has no answer (it is their own event)', () => {
    expect(event(timed()).response).toBeNull()
  })

  test('only the first fifty guests are kept, and the rest are counted', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ email: `g${i}@example.com`, responseStatus: 'accepted' }))
    const e = event(timed({ attendees: many }))
    expect(e.guests.length).toBe(50)
    expect(e.guestsLeft).toBe(10)
  })
})

describe('untrusted text', () => {
  test('control characters are stripped and long text is cut', () => {
    expect(cleanText('a\u0000b\u0007c\nd', 20)).toBe('a b c d')
    expect(cleanText('x'.repeat(500), 300).length).toBe(300)
    expect(event(timed({ summary: `Hi\u0000 there` })).title).toBe('Hi  there')
  })

  test('a description with markup becomes plain text: breaks kept, tags gone, entities read; it is never HTML after this', () => {
    expect(htmlToText('<p>Agenda:</p><ul><li>one</li><li>two &amp; three</li></ul><br>See <a href="javascript:alert(1)">this</a> &lt;now&gt;')).toBe('Agenda:\n- one\n- two & three\n\nSee this <now>')
    const e = event(timed({ description: '<script>alert(1)</script><b>Bring</b> the deck' }))
    expect(e.description).not.toContain('<b>')
    expect(e.description).toContain('Bring the deck')
  })

  test('a description is cut to 2,000 characters', () => {
    expect(event(timed({ description: 'y'.repeat(5000) })).description?.length).toBe(2000)
  })

  test('a link is kept only if it is https; the event in Google Calendar only if it is on Google’s own host', () => {
    expect(httpsLink('https://meet.google.com/abc-defg-hij')).toBe('https://meet.google.com/abc-defg-hij')
    expect(httpsLink('javascript:alert(1)')).toBeNull()
    expect(httpsLink('http://insecure.example/x')).toBeNull()
    expect(httpsLink('not a url')).toBeNull()
    expect(googleLink('https://www.google.com/calendar/event?eid=abc')).toContain('google.com/calendar/event')
    expect(googleLink('https://google.com.evil.example/x')).toBeNull()
    expect(googleLink('https://google.com.example/calendar/event?eid=abc')).toBeNull()
  })

  test('the video link is Google’s own field, else a conference entry point that is a video; never a phone or a script', () => {
    expect(event(timed({ hangoutLink: 'https://meet.google.com/aaa' })).videoLink).toBe('https://meet.google.com/aaa')
    expect(
      event(timed({ conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+1555' }, { entryPointType: 'video', uri: 'https://zoom.us/j/1' }] } })).videoLink,
    ).toBe('https://zoom.us/j/1')
    expect(event(timed({ hangoutLink: 'javascript:alert(1)' })).videoLink).toBeNull()
  })
})
