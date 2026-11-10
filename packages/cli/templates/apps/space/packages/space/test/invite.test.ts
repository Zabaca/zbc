// What a call card and a booking say, and the invitation that goes into the email being written: plain functions, checked on literals. The company's day is
// its declared zone (America/Los_Angeles here), not the browser's and not UTC.
import { describe, expect, test } from 'bun:test'
import { callLinkText, epochAt, invitationText, joinHref, lengthWords, parseLocal, ranFor, toLocal, whenWords, withBlock } from '../src/client/invite'

const LA = 'America/Los_Angeles'

describe('how long a call ran', () => {
  test('in the words a person says it', () => {
    expect(lengthWords(10_000)).toBe('under a minute')
    expect(lengthWords(44_000)).toBe('under a minute')
    expect(lengthWords(60_000)).toBe('1 min')
    expect(lengthWords(12 * 60_000 + 20_000)).toBe('12 min')
    expect(lengthWords(60 * 60_000)).toBe('1 h')
    expect(lengthWords(65 * 60_000)).toBe('1 h 05 min')
  })

  test('from the first seat to the last leave, and unknown where either is', () => {
    expect(ranFor({ openedAt: 1000, endedAt: 61_000 })).toBe(60_000)
    expect(ranFor({ openedAt: null, endedAt: 61_000 })).toBeNull()
    expect(ranFor({ openedAt: 1000, endedAt: null })).toBeNull()
    expect(ranFor({ openedAt: 5000, endedAt: 1000 })).toBeNull()
  })
})

describe('the time a person types is read on the company’s clock', () => {
  test('2:00 PM on Nov 3 in Los Angeles is 22:00 UTC, once the clocks have gone back', () => {
    expect(parseLocal('2026-11-03T14:00', LA)).toBe(Date.UTC(2026, 10, 3, 22, 0))
  })

  test('and 2:00 PM on Oct 30 is 21:00 UTC, before they do', () => {
    expect(parseLocal('2026-10-30T14:00', LA)).toBe(Date.UTC(2026, 9, 30, 21, 0))
  })

  test('the hour the clocks skip is read as the hour after, and the hour they repeat as the first of the two', () => {
    // 2026-03-08 02:30 does not exist in Los Angeles: the clocks go from 02:00 to 03:00.
    expect(parseLocal('2026-03-08T02:30', LA)).toBe(Date.UTC(2026, 2, 8, 10, 30))
    // 2026-11-01 01:30 happens twice; the first is still on daylight time (UTC-7).
    expect(parseLocal('2026-11-01T01:30', LA)).toBe(Date.UTC(2026, 10, 1, 8, 30))
  })

  test('a box that holds anything else, or a day that does not exist, is no time', () => {
    for (const bad of ['', 'tomorrow', '2026-11-03', '2026-11-03T14:00:00', '2026-13-03T14:00', '2026-11-32T14:00', '2026-02-30T10:00', '2026-11-03T24:00']) expect([bad, parseLocal(bad, LA)]).toEqual([bad, null])
  })

  test('the box starts at the moment read on the same clock, so what is typed round-trips', () => {
    const t = Date.UTC(2026, 10, 3, 22, 0)
    expect(toLocal(t, LA)).toBe('2026-11-03T14:00')
    expect(parseLocal(toLocal(t, LA), LA)).toBe(t)
    expect(epochAt({ y: 2026, m: 11, d: 3, h: 14, mi: 0 }, 'UTC')).toBe(t - 8 * 3_600_000)
  })

  test('a meeting’s time is shown on that clock with the zone named, wherever the browser is', () => {
    expect(whenWords(Date.UTC(2026, 10, 3, 22, 0), LA)).toBe('Tue, Nov 3, 2:00 PM PST')
    expect(whenWords(Date.UTC(2026, 9, 30, 21, 0), LA)).toBe('Fri, Oct 30, 2:00 PM PDT')
  })
})

describe('the link Join opens carries the person’s name, and Copy link does not', () => {
  const call = { link: 'https://meet.northfield.example/r/k7m2qx9frtn4w6hbc8jd' }

  test('the name is added to meet’s own address, cut to the lobby’s forty characters, and nothing else is changed', () => {
    expect(joinHref(call, 'Tessa')).toBe('https://meet.northfield.example/r/k7m2qx9frtn4w6hbc8jd?as=Tessa')
    expect(joinHref(call, 'Priya Natarajan')).toBe('https://meet.northfield.example/r/k7m2qx9frtn4w6hbc8jd?as=Priya+Natarajan')
    expect(new URL(joinHref(call, 'x'.repeat(60))).searchParams.get('as')).toHaveLength(40)
    expect(joinHref(call, '   ')).toBe(call.link)
    expect(new URL(joinHref(call, 'Tessa')).origin).toBe('https://meet.northfield.example')
  })
})

describe('the invitation is text for the email being written, and nothing sends it', () => {
  const text = invitationText({ title: 'Kickoff call', startsAt: Date.UTC(2026, 10, 3, 22, 0), zone: LA, link: 'https://meet.northfield.example/r/k7m2qx9frtn4w6hbc8jd', to: 'Corin Pike' })

  test('it names the meeting, the time on the company’s clock with its zone, and the link', () => {
    expect(text).toContain('Hi Corin,')
    expect(text).toContain('"Kickoff call"')
    expect(text).toContain('Tue, Nov 3, 2:00 PM PST')
    expect(text).toContain('https://meet.northfield.example/r/k7m2qx9frtn4w6hbc8jd')
    expect(text).not.toContain('space.northfield.example')
  })

  test('with no name it still reads, and a link alone is a sentence and the link', () => {
    expect(invitationText({ title: 'T', startsAt: 0, zone: LA, link: 'https://meet.northfield.example/r/x' }).startsWith('I have set up')).toBe(true)
    expect(callLinkText('https://meet.northfield.example/r/x')).toBe('You can join a call with me from any browser, with no account, at:\n\nhttps://meet.northfield.example/r/x')
  })

  test('it goes under what is already written, after a blank line, and never over it', () => {
    expect(withBlock('', 'LINK')).toBe('LINK')
    expect(withBlock('   \n', 'LINK')).toBe('LINK')
    expect(withBlock('Thanks, Dana.', 'LINK')).toBe('Thanks, Dana.\n\nLINK')
    expect(withBlock('Thanks, Dana.\n\n', 'LINK')).toBe('Thanks, Dana.\n\nLINK')
  })
})
