// The booking door (src/booking.ts; the space's ADR 0025): the calendar's public API at `/book/api/...`, driven with real requests. What is held here is which call each path is, what the door refuses before the calendar is asked (a write from another site, a
// flood, a hidden field a script fills, a path or secret that is not the shape one is made in), and that the calendar's answers go out as they came, with the visitor's network address given to it and never in an answer. The rules behind it are the calendar's
// (packages/calendar/test/bookings.test.ts).
import { describe, expect, test } from 'bun:test'
import { answered, type CalendarForGuests, failed, refused } from '@space/workspace'
import { BOOKING_BODY_MAX, bookingAnswer } from '../src/booking'
import { standInCalendar } from '../src/stand-in-calendar'

const HOST = 'https://space.northfield.example'
const SECRET = 'c'.repeat(48)

/** A face that records what it was asked and answers a value, or whatever a test sets. */
function recording(over: Partial<Record<keyof CalendarForGuests, (...a: never[]) => unknown>> = {}) {
  const calls: { method: string; args: unknown[] }[] = []
  const make = (method: keyof CalendarForGuests) =>
    async (...args: unknown[]) => {
      calls.push({ method, args })
      const custom = over[method]
      return custom ? custom(...(args as never[])) : answered({ method })
    }
  const face = Object.fromEntries((['link', 'slots', 'book', 'booking', 'bookingSlots', 'move', 'cancel'] as const).map((m) => [m, make(m)])) as unknown as CalendarForGuests
  return { face, calls }
}

const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => new Request(`${HOST}${path}`, init)
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => req(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
const GOOD = { start: 1793984400000, name: 'Ada Quill', email: 'ada@example.org', note: 'Hello' }

describe('what each path is', () => {
  test('the link, its free times and a booking, a booking’s page, its times, a move and a cancellation, each its own call of the calendar’s third face', async () => {
    const r = recording()
    const door = (request: Request) => bookingAnswer(request, { face: r.face })
    expect(await (await door(req('/book/api/links/intro-call'))).json()).toEqual({ value: { method: 'link' } })
    expect(await (await door(req('/book/api/links/intro-call/slots'))).json()).toEqual({ value: { method: 'slots' } })
    expect((await door(post('/book/api/links/intro-call/book', GOOD, { 'cf-connecting-ip': '203.0.113.7' }))).status).toBe(200)
    expect(await (await door(req(`/book/api/manage/${SECRET}`))).json()).toEqual({ value: { method: 'booking' } })
    expect(await (await door(req(`/book/api/manage/${SECRET}/slots`))).json()).toEqual({ value: { method: 'bookingSlots' } })
    expect((await door(post(`/book/api/manage/${SECRET}/move`, { start: 5 }))).status).toBe(200)
    expect((await door(post(`/book/api/manage/${SECRET}/cancel`, {}))).status).toBe(200)
    expect(r.calls).toEqual([
      { method: 'link', args: ['intro-call'] },
      { method: 'slots', args: ['intro-call'] },
      { method: 'book', args: ['intro-call', GOOD, '203.0.113.7'] },
      { method: 'booking', args: [SECRET] },
      { method: 'bookingSlots', args: [SECRET] },
      { method: 'move', args: [SECRET, 5] },
      { method: 'cancel', args: [SECRET] },
    ])
  })

  test('anything else is a 404 and a wrong method a 405, and the calendar is asked about none of it', async () => {
    const r = recording()
    const door = (request: Request) => bookingAnswer(request, { face: r.face })
    for (const path of ['/book/api', '/book/api/', '/book/api/links', '/book/api/links/Intro', '/book/api/links/a_b', '/book/api/links/a/slots/more', '/book/api/links/intro/nothing', '/book/api/manage/short', `/book/api/manage/${SECRET}/nothing`, '/book/api/other/x', `/book/api/manage/${'x'.repeat(300)}`, '/book/api/links/../x']) {
      expect([path, (await door(req(path))).status]).toEqual([path, 404])
    }
    for (const [path, method, allow] of [
      ['/book/api/links/intro', 'POST', 'GET, HEAD'],
      ['/book/api/links/intro/slots', 'DELETE', 'GET, HEAD'],
      ['/book/api/links/intro/book', 'GET', 'POST'],
      [`/book/api/manage/${SECRET}/move`, 'PUT', 'POST'],
      [`/book/api/manage/${SECRET}/cancel`, 'GET', 'POST'],
      [`/book/api/manage/${SECRET}`, 'PATCH', 'GET, HEAD'],
    ] as const) {
      const res = await door(req(path, { method }))
      expect([path, method, res.status, res.headers.get('allow')]).toEqual([path, method, 405, allow])
    }
    expect(r.calls).toEqual([])
  })

  test('every answer is no-store', async () => {
    const door = (request: Request) => bookingAnswer(request, { face: recording().face })
    for (const request of [req('/book/api/links/intro'), req('/book/api/nope'), req('/book/api/links/intro', { method: 'POST' }), post('/book/api/links/intro/book', GOOD)]) expect((await door(request)).headers.get('cache-control')).toBe('no-store')
  })
})

describe('what the door refuses before the calendar is asked', () => {
  test('a write from another site: a browser says so, by Sec-Fetch-Site or by an Origin that is not this host’s; a write from this page, or with neither header, goes through', async () => {
    const r = recording()
    const door = (request: Request) => bookingAnswer(request, { face: r.face })
    for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { origin: 'https://evil.example' }, { origin: 'https://space.northfield.example.evil.example' }, { origin: 'http://space.northfield.example' }] as Record<string, string>[]) {
      expect([JSON.stringify(headers), (await door(post('/book/api/links/intro/book', GOOD, headers))).status]).toEqual([JSON.stringify(headers), 403])
      expect((await door(post(`/book/api/manage/${SECRET}/cancel`, {}, headers))).status).toBe(403)
    }
    expect(r.calls).toEqual([])
    for (const headers of [{ origin: HOST, 'sec-fetch-site': 'same-origin' }, {}] as Record<string, string>[]) expect((await door(post('/book/api/links/intro/book', GOOD, headers))).status).toBe(200)
    // A read from anywhere is a read: it shows only what the link offers.
    expect((await door(req('/book/api/links/intro', { headers: { origin: 'https://evil.example' } }))).status).toBe(200)
  })

  test('a flood: past the per-caller limit every call is a 429 with a minute to wait, keyed by the network address, and the calendar is not asked', async () => {
    const r = recording()
    const keys: string[] = []
    const limit = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: keys.length < 3 }) }
    const door = (request: Request) => bookingAnswer(request, { face: r.face, limit })
    expect((await door(req('/book/api/links/intro', { headers: { 'cf-connecting-ip': '198.51.100.9' } }))).status).toBe(200)
    expect((await door(req('/book/api/links/intro/slots', { headers: { 'cf-connecting-ip': '198.51.100.9' } }))).status).toBe(200)
    const limited = await door(post('/book/api/links/intro/book', GOOD, { 'cf-connecting-ip': '198.51.100.9' }))
    expect([limited.status, limited.headers.get('retry-after')]).toEqual([429, '60'])
    expect(await limited.json()).toMatchObject({ reason: 'limit' })
    expect(keys).toEqual(['book:198.51.100.9', 'book:198.51.100.9', 'book:198.51.100.9'])
    // An IPv6 caller is limited by its /64, so rotating through the addresses of one line is one caller; the calendar is given the address as the edge gave it.
    await door(req('/book/api/links/intro', { headers: { 'cf-connecting-ip': '2001:db8:1:2:aaaa::1' } }))
    await door(req('/book/api/links/intro', { headers: { 'cf-connecting-ip': '2001:db8:1:2:bbbb::9' } }))
    expect(keys.slice(3)).toEqual(['book:v6:2001:0db8:0001:0002', 'book:v6:2001:0db8:0001:0002'])
    expect(r.calls.map((c) => c.method)).toEqual(['link', 'slots'])
  })

  test('a hidden field a person never fills: a booking with something in it is refused, and with nothing in it is the booking', async () => {
    const r = recording()
    const door = (request: Request) => bookingAnswer(request, { face: r.face })
    expect((await door(post('/book/api/links/intro/book', { ...GOOD, website: 'http://spam.example' }))).status).toBe(400)
    expect(r.calls).toEqual([])
    expect((await door(post('/book/api/links/intro/book', { ...GOOD, website: '' }))).status).toBe(200)
    expect((await door(post('/book/api/links/intro/book', { ...GOOD, website: '   ' }))).status).toBe(200)
    // The field is the door's: the calendar is never given it.
    expect(JSON.stringify(r.calls)).not.toContain('website')
  })

  test('a body that is too large, not JSON or not an object is refused, and an empty one is an empty object', async () => {
    const r = recording()
    const door = (request: Request) => bookingAnswer(request, { face: r.face })
    expect((await door(post('/book/api/links/intro/book', 'x'.repeat(BOOKING_BODY_MAX + 1)))).status).toBe(413)
    expect((await door(post('/book/api/links/intro/book', '{not json'))).status).toBe(400)
    expect((await door(post('/book/api/links/intro/book', '[1,2]'))).status).toBe(400)
    expect((await door(post('/book/api/links/intro/book', 'null'))).status).toBe(400)
    expect(r.calls).toEqual([])
    expect((await door(post(`/book/api/manage/${SECRET}/cancel`, ''))).status).toBe(200)
  })

  test('a move whose start is not a number is the calendar’s to refuse in words, and nothing is made of it here', async () => {
    const r = recording({ move: () => refused('bad-request', 'Pick one of the times offered.') })
    const res = await bookingAnswer(post(`/book/api/manage/${SECRET}/move`, { start: 'soon' }), { face: r.face })
    expect([res.status, await res.json()]).toEqual([400, { error: 'Pick one of the times offered.', reason: 'bad-request' }])
    expect(r.calls).toEqual([{ method: 'move', args: [SECRET, 'soon'] }])
  })
})

describe('the calendar’s answers go out as they came', () => {
  test('a refusal is its status and its own words, a limit says to wait, and a failure is a 500 in the calendar’s fixed sentence', async () => {
    const cases: [string, ReturnType<typeof refused> | ReturnType<typeof failed>, number][] = [
      ['not-found', refused('not-found', 'There is no such booking link.'), 404],
      ['bad-request', refused('bad-request', 'Please give your name.'), 400],
      ['conflict', refused('conflict', 'That time is no longer free. Please pick another one.'), 409],
      ['limit', refused('limit', 'Too many bookings have been made from this network today.'), 429],
      ['failed', failed('The calendar could not tell whether that was done.'), 500],
    ]
    for (const [name, out, status] of cases) {
      const res = await bookingAnswer(post('/book/api/links/intro/book', GOOD), { face: recording({ book: () => out }).face })
      expect([name, res.status]).toEqual([name, status])
      expect((await res.json()) as { error: string }).toMatchObject({ error: out.message })
      if (name === 'limit') expect(res.headers.get('retry-after')).toBe('3600')
    }
  })

  test('a face that throws is one fixed sentence and a log line without the request in it', async () => {
    const logged: unknown[] = []
    const original = console.error
    console.error = (...a: unknown[]) => logged.push(a)
    try {
      const res = await bookingAnswer(req(`/book/api/manage/${SECRET}`), {
        face: recording({
          booking: () => {
            throw new Error(`could not read ${SECRET}`)
          },
        }).face,
      })
      expect([res.status, await res.json()]).toEqual([500, { error: 'That could not be done just now. Please try again in a moment.' }])
    } finally {
      console.error = original
    }
    expect(JSON.stringify(logged)).not.toContain('manage')
  })

  test('the visitor’s network address is given to the calendar and is in no answer', async () => {
    const r = recording()
    const res = await bookingAnswer(post('/book/api/links/intro/book', GOOD, { 'cf-connecting-ip': '203.0.113.99' }), { face: r.face })
    expect(await res.text()).not.toContain('203.0.113.99')
    expect(r.calls[0]?.args[2]).toBe('203.0.113.99')
    // With no address from the edge (a local run) the calendar is given a word, so nothing is limited by `undefined`.
    await bookingAnswer(post('/book/api/links/intro/book', GOOD), { face: r.face })
    expect(r.calls[1]?.args[2]).toBe('local')
  })
})

describe('over the stand-in, the way a local page is served', () => {
  test('a link made by the owner is a page’s API: its times, a booking, the booking’s own page, a move and a cancellation, and an event in the calendar the owner reads', async () => {
    const now = Date.UTC(2026, 10, 5, 20, 0)
    const app = standInCalendar(now, 'America/Los_Angeles')
    const door = (request: Request) => bookingAnswer(request, { face: app.guests })
    const owner = { person: { address: 'tessa@northfield.example' } } as never
    const made = await app.methods.makeBookingLink(owner, {
      slug: 'intro-call',
      name: 'Intro call',
      description: 'A first chat.',
      account: 'tessa@northfield.example',
      minutes: 30,
      hours: { mon: [{ from: 540, to: 1020 }], tue: [{ from: 540, to: 1020 }], wed: [{ from: 540, to: 1020 }], thu: [{ from: 540, to: 1020 }], fri: [{ from: 540, to: 1020 }], sat: [], sun: [] },
      noticeMinutes: 240,
      aheadDays: 30,
      gapMinutes: 15,
      perDay: null,
      enabled: true,
    })
    expect(made.ok).toBe(true)
    const link = (await (await door(req('/book/api/links/intro-call'))).json()) as { value: { open: boolean; minutes: number } }
    expect(link.value).toMatchObject({ open: true, minutes: 30 })
    const slots = (await (await door(req('/book/api/links/intro-call/slots'))).json()) as { value: { starts: number[] } }
    expect(slots.value.starts.length).toBeGreaterThan(20)
    const start = slots.value.starts[slots.value.starts.length - 1] as number
    const booked = (await (await door(post('/book/api/links/intro-call/book', { start, name: 'Ada Quill', email: 'ada@example.org', note: '' }))).json()) as { value: { secret: string; booking: { state: string } } }
    expect(booked.value.booking.state).toBe('booked')
    const secret = booked.value.secret
    // The owner reads it in Settings, and the event is in the agenda.
    const links = await app.methods.bookingLinks(owner)
    expect(links.ok && links.value.links[0]?.bookings[0]).toMatchObject({ name: 'Ada Quill', start, state: 'booked' })
    expect(app.events.some((e) => e.title === 'Intro call: Ada Quill')).toBe(true)
    // The time is taken for the next visitor.
    const again = await door(post('/book/api/links/intro-call/book', { start, name: 'Bea', email: 'bea@example.org', note: '' }))
    expect(again.status).toBe(409)
    // Its own page, a move and a cancellation.
    const mine = (await (await door(req(`/book/api/manage/${secret}/slots`))).json()) as { value: { starts: number[] } }
    const target = mine.value.starts.find((t) => t < start - 24 * 3_600_000) as number
    const moved = (await (await door(post(`/book/api/manage/${secret}/move`, { start: target }))).json()) as { value: { start: number } }
    expect(moved.value.start).toBe(target)
    const cancelled = (await (await door(post(`/book/api/manage/${secret}/cancel`, {}))).json()) as { value: { state: string } }
    expect(cancelled.value.state).toBe('cancelled')
    expect(app.events.some((e) => e.title === 'Intro call: Ada Quill')).toBe(false)
    expect((await door(req('/book/api/manage/not-a-real-secret'))).status).toBe(404)
  })
})
