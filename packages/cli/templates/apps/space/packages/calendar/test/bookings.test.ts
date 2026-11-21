import { describe, expect, test } from 'bun:test'
import { BOOKING_CALL_CLOSES_AFTER_MS, BOOKING_CALL_OPENS_BEFORE_MS, BOOKING_DEFAULTS, BOOKING_LIMITS, type BookingLinkInput } from '@space/workspace'
import { BOOKING_HOLD_MS, bookingEventId, bookingNote, canonicalAddress, CLOSED_WORDS, networkKeyOf, NOT_NOW_WORDS, readBookingLink, readGuestBooking, TAKEN_WORDS, UNSURE_WORDS } from '../src/bookings'
import type { Result } from '../src/engine'
import { type Harness, harness, HOUR, DAY, NORTHFIELD, OWNER, ORIGIN, T0 } from '../test-support/harness'

/**
 * Booking links (the space's ADR 0025), at the engine over a real SQLite and a fake Google that answers as the documents say: what a visitor is offered, what a booking makes at Google and what it says of the owner, two visitors and one time, a time Google
 * says is taken, an insert that is refused or whose outcome nobody knows, the limits, the visitor's words, the booking's own page (move and cancel only with its secret), and that no token and no secret is kept or leaked.
 */

const Z = OWNER
const F = 'tessa@ashgrove.example'
const G = 'tessa_marlow@gmail.com'
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()
const NET = '203.0.113.7'
/** A moment on the company's clock in November 2026 (Pacific standard time, UTC-8 from the first): Friday the 6th and Monday the 9th. */
const fri = (h: number, m = 0) => Date.UTC(2026, 10, 6, h + 8, m)
const mon = (h: number, m = 0) => Date.UTC(2026, 10, 9, h + 8, m)
/** The company-clock day of a moment, `YYYY-MM-DD`. */
const day = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(t)

/** What an engine answered, or the sentence that refused it. */
function val<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.reason}: ${r.error}`)
  return r.value
}

async function world(accounts: string[] = [Z, F], options: Parameters<typeof harness>[0] = {}) {
  const h = harness({ notify: true, ...options })
  for (const a of accounts) {
    h.connect(a)
    h.google.addCalendar(a, { id: a, summary: a, primary: true })
  }
  await h.work()
  return h
}

const input = (over: Partial<BookingLinkInput> = {}): BookingLinkInput => ({ ...BOOKING_DEFAULTS, slug: 'intro', name: 'Intro call', description: 'A first chat about what you need.', account: Z, enabled: true, ...over })

const make = async (h: Harness, over: Partial<BookingLinkInput> = {}) => val(await h.engine.makeBookingLink(input(over)))
const starts = async (h: Harness, slug = 'intro') => val(await h.engine.guestSlots(slug)).starts
const visitor = (over: Record<string, unknown> = {}) => ({ name: 'Ada Quill', email: 'ada@example.org', note: 'Looking forward to it.', ...over })
const book = (h: Harness, start: number, over: Record<string, unknown> = {}, slug = 'intro', net = NET) => h.engine.guestBook(slug, { start, ...visitor(over) }, net)
const inserts = (h: Harness) => h.google.writes.filter((w) => w.op === 'events.insert')
const writesOf = (h: Harness, op: string) => h.google.writes.filter((w) => w.op === op)
const sync = async (h: Harness) => {
  h.store.askAll()
  await h.work()
}
/** Everything in the store, as text: for what must never be in it. */
const dump = (h: Harness): string =>
  JSON.stringify(
    (h.rows<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)).map((t) => [t.name, h.rows(`SELECT * FROM "${t.name}"`)]),
  )

describe('reading what the owner sets', () => {
  test('a link is checked field by field, and says which is wrong', () => {
    const good = readBookingLink(input())
    expect(good).toMatchObject({ ok: true, value: { slug: 'intro', name: 'Intro call', minutes: 30, perDay: null, enabled: true } })
    for (const [what, over] of [
      ['a slug that is too short', { slug: 'ab' }],
      ['a slug with a space', { slug: 'my link' }],
      ['two hyphens together', { slug: 'a--b' }],
      ['a hyphen at the end', { slug: 'intro-' }],
      ['a slug that is a folder of the page', { slug: 'api' }],
      ['another folder', { slug: 'manage' }],
      ['a name that is nothing', { name: '   ' }],
      ['a name that is too long', { name: 'x'.repeat(BOOKING_LIMITS.nameMax + 1) }],
      ['an em dash in the name', { name: 'Intro \u2014 call' }],
      ['an em dash in the description', { description: 'Hello \u2014 there' }],
      ['a length of zero', { minutes: 0 }],
      ['a length of a day', { minutes: 24 * 60 }],
      ['hours of nothing', { hours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } }],
      ['a span that ends before it starts', { hours: { ...BOOKING_DEFAULTS.hours, mon: [{ from: 600, to: 600 }] } }],
      ['spans that overlap', { hours: { ...BOOKING_DEFAULTS.hours, mon: [{ from: 540, to: 720 }, { from: 700, to: 800 }] } }],
      ['a weekday nobody has heard of', { hours: { ...BOOKING_DEFAULTS.hours, noday: [] } }],
      ['notice of a year', { noticeMinutes: 366 * 24 * 60 }],
      ['no days ahead', { aheadDays: 0 }],
      ['half a year ahead', { aheadDays: 180 }],
      ['a gap of a day', { gapMinutes: 24 * 60 }],
      ['a limit of zero a day', { perDay: 0 }],
      ['whether it is on, said as a word', { enabled: 'yes' }],
    ] as const) {
      expect(readBookingLink({ ...input(), ...over }), what).toMatchObject({ ok: false, reason: 'bad-request' })
    }
    expect(readBookingLink({ ...input(), extra: 1 })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(readBookingLink('intro')).toMatchObject({ ok: false, reason: 'bad-request' })
    // An address is lower-cased, and a missing limit is no limit.
    expect(readBookingLink({ ...input(), slug: ' Intro-Call ', perDay: undefined })).toMatchObject({ ok: true, value: { slug: 'intro-call', perDay: null } })
  })

  test('the owner makes, changes and deletes links, and the view says the address, the account and why a link cannot be booked', async () => {
    const h = await world()
    const link = await make(h)
    expect(link).toMatchObject({ slug: 'intro', name: 'Intro call', account: Z, accountLabel: 'tessa', url: `${ORIGIN}/book/intro`, problem: null, enabled: true, bookings: [] })
    expect(val(await h.engine.bookingLinks())).toMatchObject({
      links: [{ id: link.id }],
      accounts: [{ address: Z, canBook: true, why: null }, { address: F, canBook: true, why: null }],
      defaults: { minutes: 30, noticeMinutes: 240, aheadDays: 30, gapMinutes: 15, perDay: null },
      zone: 'America/Los_Angeles',
      origin: ORIGIN,
    })
    const changed = val(await h.engine.changeBookingLink(link.id, input({ name: 'Intro chat', minutes: 45, enabled: false, account: F })))
    expect(changed).toMatchObject({ name: 'Intro chat', minutes: 45, enabled: false, account: F })
    expect(val(await h.engine.deleteBookingLink(link.id))).toEqual({ id: link.id })
    expect(val(await h.engine.bookingLinks()).links).toEqual([])
    // What is wrong with a link comes back as a refusal, and nothing is stored.
    expect(await h.engine.makeBookingLink({ ...input(), slug: 'x' })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await h.engine.makeBookingLink(input({ account: 'nobody@example.org' }))).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await h.engine.changeBookingLink('no-such', input())).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await h.engine.deleteBookingLink('no-such')).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await h.engine.deleteBookingLink(7)).toMatchObject({ ok: false, reason: 'not-found' })
    expect(h.store.bookings.links()).toEqual([])
  })

  test('an address is used by one link, and a space holds at most twenty', async () => {
    const h = await world()
    const a = await make(h)
    expect(await h.engine.makeBookingLink(input())).toMatchObject({ ok: false, reason: 'conflict' })
    const b = await make(h, { slug: 'other' })
    // Changing a link to keep its own address is fine; taking another's is not.
    expect(await h.engine.changeBookingLink(a.id, input({ name: 'Renamed' }))).toMatchObject({ ok: true })
    expect(await h.engine.changeBookingLink(b.id, input({ slug: 'intro' }))).toMatchObject({ ok: false, reason: 'conflict' })
    for (let i = 0; i < BOOKING_LIMITS.linksMax - 2; i++) await make(h, { slug: `more-${i}` })
    expect(await h.engine.makeBookingLink(input({ slug: 'one-too-many' }))).toMatchObject({ ok: false, reason: 'limit' })
  })

  test('a link says why it cannot be booked now: its account’s sign-in ended, it reads and cannot change events, its main calendar is hidden or not read yet, or the account is not there', async () => {
    const h = await world([Z, F])
    const link = await make(h)
    h.grants.find((g) => g.address === F)!.events = false
    h.grants.find((g) => g.address === Z)!.lapsed = true
    h.advance(31_000)
    const view = val(await h.engine.bookingLinks())
    expect(view.links[0]?.problem).toContain('sign-in of tessa@northfield.example ended')
    expect(view.accounts.find((a) => a.address === F)).toMatchObject({ canBook: false })
    expect(view.accounts.find((a) => a.address === F)?.why).toContain('connected for reading only')
    h.grants.find((g) => g.address === Z)!.lapsed = false
    h.advance(31_000)
    await h.work()
    expect(val(await h.engine.bookingLinks()).links[0]?.problem).toBeNull()
    // Hiding the main calendar means a booking could not be seen again, so nothing is booked on it.
    await h.engine.setShown(`${Z}|${Z}`, false)
    expect(val(await h.engine.bookingLinks()).links[0]?.problem).toContain('main calendar of tessa@northfield.example is hidden')
    // An account that is not connected at all.
    h.store.bookings.changeLink(link.id, { ...input(), account: 'gone@example.org', where: 'meet' } as never)
    expect(val(await h.engine.bookingLinks()).links[0]?.problem).toContain('is not a connected Google account')
  })

  test('with no writing client wired nothing can be booked, and the owner is told so', async () => {
    const h = await world([Z], { writer: false })
    await make(h)
    expect(val(await h.engine.bookingLinks()).links[0]?.problem).toBe('This install cannot change calendar events from here.')
    expect(val(await h.engine.guestLink('intro')).open).toBe(false)
  })
})

describe('what a visitor is offered', () => {
  test('the link, its company and its length, and the free starting times from now: only moments, and never anything of an event', async () => {
    const h = await world()
    h.google.setEvent(Z, Z, { id: 'secret', summary: 'Confidential: acquisition', start: iso(T0 + 28 * HOUR), end: iso(T0 + 29 * HOUR), location: 'Room 9', description: 'Do not tell' })
    await sync(h)
    await make(h)
    const link = val(await h.engine.guestLink('intro'))
    expect(link).toEqual({ company: NORTHFIELD.company.name, name: 'Intro call', description: 'A first chat about what you need.', minutes: 30, zone: 'America/Los_Angeles', open: true, where: 'meet' })
    const slots = val(await h.engine.guestSlots('intro'))
    expect(slots.from).toBe(T0)
    expect(slots.to).toBe(T0 + 30 * DAY)
    expect(slots.starts[0]).toBe(T0 + 4 * HOUR)
    // Everything a visitor is given is numbers: nothing of what the owner is doing.
    const text = JSON.stringify(slots)
    for (const leak of ['Confidential', 'acquisition', 'Room 9', 'Do not tell', 'secret']) expect(text).not.toContain(leak)
    expect(slots.starts.every((t) => Number.isSafeInteger(t))).toBe(true)
    expect(await h.engine.guestLink('nope')).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await h.engine.guestSlots('nope')).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await h.engine.guestLink(42)).toMatchObject({ ok: false, reason: 'not-found' })
  })

  test('a time is free only when the owner is free on EVERY connected account: a meeting on the other account takes its time, a declined one and free time do not, and a Busy block is never counted twice', async () => {
    const h = await world([Z, F, G])
    // 28 hours on is Friday 16:00 UTC+... : Friday 4 pm is outside nothing; use the morning slot Friday 10:00 Los Angeles.
    const friday10 = Date.UTC(2026, 10, 6, 18, 0)
    h.google.setEvent(F, F, { id: 'busy', summary: 'Busy elsewhere', start: iso(friday10), end: iso(friday10 + HOUR) })
    h.google.setEvent(G, G, { id: 'declined', summary: 'No', start: iso(friday10 + 2 * HOUR), end: iso(friday10 + 3 * HOUR), attendees: [{ email: G, self: true, responseStatus: 'declined' }] })
    h.google.setEvent(G, G, { id: 'free', summary: 'Free time', start: iso(friday10 + 4 * HOUR), end: iso(friday10 + 5 * HOUR), transparency: 'transparent' })
    await sync(h)
    await make(h)
    const got = await starts(h)
    // 10:00 to 11:00 on Friday is taken, with a quarter of an hour either side: 9:30 to 11:15.
    for (const t of [friday10 - 30 * MIN, friday10, friday10 + 30 * MIN, friday10 + 60 * MIN - 30 * MIN]) expect(got).not.toContain(t)
    expect(got).toContain(friday10 - HOUR)
    expect(got).toContain(friday10 + 90 * MIN)
    // The declined meeting and the free time leave their hours open.
    expect(got).toContain(friday10 + 2 * HOUR)
    expect(got).toContain(friday10 + 4 * HOUR)
    // With the blocks on, the meeting on F leaves a Busy on Z and G: the same time, counted once.
    await h.engine.setBlocking(true)
    await h.work()
    expect(await starts(h)).toEqual(got)
  })

  test('an all-day event that makes the owner busy takes its day', async () => {
    const h = await world()
    h.google.setEvent(F, F, { id: 'offsite', summary: 'Offsite', startDate: '2026-11-06', endDate: '2026-11-07' })
    await sync(h)
    await make(h)
    const got = await starts(h)
    expect(got.some((t) => day(t) === '2026-11-06')).toBe(false)
    expect(got.some((t) => day(t) === '2026-11-05')).toBe(true)
    expect(got.some((t) => day(t) === '2026-11-09')).toBe(true)
  })

  test('a link that is off, or whose account cannot be written to, offers nothing and says it cannot be booked right now, in words that tell a visitor nothing of why', async () => {
    const h = await world()
    const link = await make(h, { enabled: false })
    expect(val(await h.engine.guestLink('intro')).open).toBe(false)
    expect(await h.engine.guestSlots('intro')).toEqual({ ok: false, reason: 'conflict', error: CLOSED_WORDS })
    val(await h.engine.changeBookingLink(link.id, input()))
    h.grants.find((g) => g.address === Z)!.lapsed = true
    h.advance(31_000)
    const slots = await h.engine.guestSlots('intro')
    expect(slots).toEqual({ ok: false, reason: 'conflict', error: CLOSED_WORDS })
    expect(CLOSED_WORDS).not.toMatch(/sign-in|lapse|permission|tessa/i)
  })
})

describe('a booking', () => {
  test('takes the time, asks Google, makes the event on the link’s account with a Meet link and the visitor as the one guest, and Google sends the invitation', async () => {
    const h = await world([Z, F])
    await make(h)
    const [first] = await starts(h)
    const got = val(await book(h, first as number))
    expect(got.booking).toMatchObject({ company: NORTHFIELD.company.name, title: 'Intro call', slug: 'intro', minutes: 30, start: first, end: (first as number) + 30 * MIN, name: 'Ada Quill', email: 'ada@example.org', state: 'booked', zone: 'America/Los_Angeles', canMove: true, canCancel: true, linkOpen: true })
    expect(got.booking.meetLink).toMatch(/^https:\/\/meet\.example\//)

    // At Google: one insert, on the link's account's own calendar, asking Google to send the invitation and to make a Meet link.
    expect(inserts(h)).toHaveLength(1)
    const w = inserts(h)[0]!
    expect(w.calendarId).toBe(Z)
    expect(w.level).toBe('events')
    expect(w.query).toEqual({ sendUpdates: 'all', conferenceDataVersion: '1' })
    expect(w.body).toMatchObject({ summary: 'Intro call: Ada Quill', attendees: [{ email: 'ada@example.org', displayName: 'Ada Quill' }], guestsCanInviteOthers: false, conferenceData: { createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } } } })
    expect((w.body.start as { dateTime: string }).dateTime).toBe('2026-11-05T16:00:00-08:00')
    expect((w.body.end as { dateTime: string }).dateTime).toBe('2026-11-05T16:30:00-08:00')
    // The event's id is derived from the booking's, so an insert whose answer was lost is found again, and the description carries the note and the visitor's own address.
    const record = val(await h.engine.bookingLinks()).links[0]!.bookings[0]!
    expect(w.body.id).toBe(await bookingEventId(NORTHFIELD.company.id, record.id))
    const description = w.body.description as string
    // The note is the owner's to read (below, in Settings' record) and is never in the invitation that goes out in their name.
    expect(description).not.toContain('Looking forward')
    expect(description).not.toContain('wrote')
    expect(description).toContain(`${ORIGIN}/book/manage/${got.secret}`)

    // Google was asked whether the owner is still free, on each live account, with the token that only reads.
    expect(h.google.calls.filter((c) => c.startsWith('freeBusy.query'))).toHaveLength(2)
    expect(h.google.accessAsked.filter((a) => a.level === 'read').length).toBeGreaterThan(0)
    // The write token was asked for this call alone, and the event is in the calendar's own copy at once, drawn as the Google event it is.
    expect(h.google.accessAsked.filter((a) => a.level === 'events')).toHaveLength(1)
    const agenda = val(await h.engine.agenda(T0, T0 + DAY))
    expect(agenda.events.map((e) => e.title)).toEqual(['Intro call: Ada Quill'])
    expect(agenda.events[0]).toMatchObject({ videoLink: expect.stringMatching(/^https:\/\/meet\./), guests: expect.arrayContaining([expect.objectContaining({ email: 'ada@example.org' })]) })

    // The owner's record, and the notification.
    expect(record).toMatchObject({ linkName: 'Intro call', name: 'Ada Quill', email: 'ada@example.org', note: 'Looking forward to it.', start: first, state: 'booked', checked: 'google' })
    expect(record.link).toMatch(/^https:\/\/www\.google\.com\/calendar\//)
    expect(h.notified).toEqual([{ id: record.id, name: 'Ada Quill', start: first as number, end: (first as number) + 30 * MIN, linkName: 'Intro call' }])
    expect(h.told.n).toBeGreaterThan(0)
  })

  test('the time is taken: it is gone from what the link offers, with the gap around it, and another visitor who wants it is refused', async () => {
    const h = await world()
    await make(h)
    const a = fri(10)
    expect(await starts(h)).toContain(a)
    val(await book(h, a))
    const after = await starts(h)
    expect(after).not.toContain(a)
    expect(after).not.toContain(a + 30 * MIN)
    expect(after).not.toContain(a - 30 * MIN)
    expect(after).toContain(a + 60 * MIN)
    expect(after).toContain(a - 60 * MIN)
    expect(await book(h, a, { email: 'bea@example.org' })).toEqual({ ok: false, reason: 'conflict', error: TAKEN_WORDS })
    // A time the link never offered (not on the step, outside the hours, past the window) is refused the same.
    for (const t of [a + 7 * MIN, T0, T0 + 400 * DAY]) expect(await book(h, t, { email: 'bea@example.org' })).toMatchObject({ ok: false, reason: 'conflict' })
    expect(inserts(h)).toHaveLength(1)
  })

  test('two visitors who ask for one time at the same moment: one has it and the other is told it has gone, and Google is asked to make one event', async () => {
    const h = await world()
    await make(h)
    const [a] = (await starts(h)) as [number]
    const [x, y] = await Promise.all([book(h, a, { email: 'one@example.org' }, 'intro', '198.51.100.1'), book(h, a, { email: 'two@example.org' }, 'intro', '198.51.100.2')])
    expect([x.ok, y.ok].sort()).toEqual([false, true])
    expect(inserts(h)).toHaveLength(1)
    expect(h.rows(`SELECT id FROM booking`)).toHaveLength(1)
    // The same race over times that overlap by the gap (the next half hour) is no different: the gap is kept between bookings too.
    const b = fri(13)
    const results = await Promise.all([book(h, b, { email: 'three@example.org' }, 'intro', '198.51.100.3'), book(h, b + 30 * MIN, { email: 'four@example.org' }, 'intro', '198.51.100.4')])
    expect(results.map((r) => r.ok)).toEqual([true, false])
    expect(inserts(h)).toHaveLength(2)
  })

  test('a time that Google says is taken since the calendar was last read is refused at the moment of booking, the hold is let go and nothing is made', async () => {
    const h = await world([Z, F])
    await make(h)
    const [a] = (await starts(h)) as [number]
    // Behind the calendar's back: a meeting on the other account, not read yet.
    h.google.setEvent(F, F, { id: 'late', summary: 'Just added', start: iso(a), end: iso(a + HOUR) })
    expect(await starts(h)).toContain(a)
    expect(await book(h, a)).toEqual({ ok: false, reason: 'conflict', error: TAKEN_WORDS })
    expect(inserts(h)).toEqual([])
    expect(h.rows(`SELECT id FROM booking`)).toEqual([])
    expect(h.notified).toEqual([])
    // The hold is gone: the time is free for the next visitor once the calendar has read the meeting, and the other times are untouched.
    await sync(h)
    expect(await starts(h)).not.toContain(a)
    const later = (await starts(h))[0] as number
    expect(await book(h, later)).toMatchObject({ ok: true })
  })

  test('an account Google cannot be asked about is checked against the calendar’s own copy, and the booking says so', async () => {
    const h = await world([Z, F])
    await make(h)
    const [a] = (await starts(h)) as [number]
    h.google.failNext('freeBusy.query', 503, { error: { code: 503, message: 'Backend Error' } }, 1, F)
    const got = val(await book(h, a))
    expect(got.booking.state).toBe('booked')
    expect(val(await h.engine.bookingLinks()).links[0]?.bookings[0]).toMatchObject({ checked: 'copy' })
    // A lapsed account cannot be asked at all.
    const [b] = (await starts(h)) as [number]
    h.grants.find((g) => g.address === F)!.lapsed = true
    h.advance(31_000)
    expect(val(await book(h, b, { email: 'bea@example.org' })).booking.state).toBe('booked')
    expect(val(await h.engine.bookingLinks()).links[0]?.bookings.map((r) => r.checked).sort()).toEqual(['copy', 'copy'])
    // The first booking asked both accounts; the second asked only the one whose sign-in is live.
    expect(h.google.calls.filter((c) => c.startsWith('freeBusy.query')).length).toBe(3)
  })

  test('an insert Google refuses with a decision lets the time go and tells the visitor nothing of why', async () => {
    const h = await world()
    await make(h)
    const [a] = (await starts(h)) as [number]
    h.google.failNext('events.insert', 400, { error: { code: 400, message: 'Invalid attendee list for tessa@northfield.example', errors: [{ reason: 'invalid' }] } })
    const refused = await book(h, a)
    expect(refused).toEqual({ ok: false, reason: 'conflict', error: CLOSED_WORDS })
    expect(JSON.stringify(refused)).not.toContain('tessa')
    expect(h.rows(`SELECT id FROM booking`)).toEqual([])
    expect(h.notified).toEqual([])
    expect(await starts(h)).toContain(a)
    // A permission Google says is missing is a decision too.
    h.google.failNext('events.insert', 403, { error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } })
    expect(await book(h, a)).toEqual({ ok: false, reason: 'conflict', error: CLOSED_WORDS })
    expect(await starts(h)).toContain(a)
  })

  test('an insert whose answer is lost keeps the time held, says the booking is not confirmed, and the next read finds the event by its id: never made twice', async () => {
    const h = await world()
    await make(h)
    const [a] = (await starts(h)) as [number]
    // Google makes the event and the answer never arrives.
    h.google.afterRequest = (op) => {
      if (op === 'events.insert') {
        h.google.afterRequest = null
        throw new Error('connection lost')
      }
    }
    const got = val(await book(h, a))
    expect(got.booking.state).toBe('pending')
    expect(got.booking.canCancel).toBe(false)
    expect(got.booking.canMove).toBe(false)
    expect(h.notified).toEqual([])
    // The time stays held while it is not known, so nobody else can have it.
    expect(await starts(h)).not.toContain(a)
    expect(await book(h, a, { email: 'bea@example.org' })).toMatchObject({ ok: false, reason: 'conflict' })
    expect(val(await h.engine.bookingLinks()).links[0]?.bookings[0]).toMatchObject({ state: 'pending' })
    // The read the booking owed finds the event under its derived id, and the booking is booked: one event, one notification.
    await h.work()
    expect(val(await h.engine.guestBooking(got.secret)).state).toBe('booked')
    expect(h.notified).toHaveLength(1)
    expect([...(h.google.account(Z).calendars.get(Z)?.events.values() ?? [])].filter((e) => e.raw.summary === 'Intro call: Ada Quill')).toHaveLength(1)
    expect(inserts(h)).toHaveLength(1)
    // And nothing is waiting any more: no alarm is owed for it.
    expect(h.store.bookings.held()).toEqual([])
  })

  test('an insert Google answers with "already exists" is this very booking made before the answer was lost: it is booked, once', async () => {
    const h = await world()
    await make(h)
    const a = fri(10)
    h.google.failNext('events.insert', 409, { error: { code: 409, message: 'The requested identifier already exists.', errors: [{ reason: 'duplicate' }] } })
    const got = val(await book(h, a))
    // The event is at Google and not yet in the calendar's copy: the booking stays held, so its time is not offered in between, and is booked when a read brings the event in.
    expect(got.booking.state).toBe('pending')
    expect(h.notified).toEqual([])
    expect(await starts(h)).not.toContain(a)
    h.google.setEvent(Z, Z, { id: h.rows<{ event_id: string }>(`SELECT event_id FROM booking`)[0]!.event_id, summary: 'Intro call: Ada Quill', start: iso(a), end: iso(a + 30 * MIN), organizer: { email: Z, self: true } })
    await h.work()
    expect(val(await h.engine.guestBooking(got.secret)).state).toBe('booked')
    expect(h.notified).toHaveLength(1)
    expect(val(await h.engine.bookingLinks()).links[0]?.bookings[0]).toMatchObject({ state: 'booked' })
  })

  test('an insert that did not happen at all lets the time go after an hour, and the visitor’s page then knows nothing of it', async () => {
    const h = await world()
    await make(h)
    const a = mon(10)
    h.google.failNext('events.insert', 503, { error: { code: 503, message: 'Backend Error' } })
    const got = val(await book(h, a))
    expect(got.booking.state).toBe('pending')
    h.advance(MIN)
    await h.work()
    expect(val(await h.engine.guestBooking(got.secret)).state).toBe('pending')
    h.advance(BOOKING_HOLD_MS + MIN)
    await h.work()
    expect(await h.engine.guestBooking(got.secret)).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await starts(h)).toContain(a)
    expect(h.notified).toEqual([])
  })

  test('a booking is on the link’s account only: a link on the other account makes its event there', async () => {
    const h = await world([Z, F])
    await make(h, { slug: 'ashgrove', name: 'Ashgrove call', account: F })
    const [a] = (await starts(h, 'ashgrove')) as [number]
    val(await book(h, a, {}, 'ashgrove'))
    expect(inserts(h).map((w) => w.calendarId)).toEqual([F])
    expect(h.google.accessAsked.filter((x) => x.level === 'events').map((x) => x.address)).toEqual([F])
  })

  test('a turned-off or deleted link books nothing, and a booking asks Google nothing', async () => {
    const h = await world()
    const link = await make(h)
    const [a] = (await starts(h)) as [number]
    val(await h.engine.changeBookingLink(link.id, input({ enabled: false })))
    const calls = h.google.calls.length
    expect(await book(h, a)).toEqual({ ok: false, reason: 'conflict', error: CLOSED_WORDS })
    expect(h.google.calls.length).toBe(calls)
    expect(h.rows(`SELECT id FROM booking`)).toEqual([])
    val(await h.engine.deleteBookingLink(link.id))
    expect(await book(h, a)).toMatchObject({ ok: false, reason: 'not-found' })
    expect(h.google.calls.length).toBe(calls)
  })

  test('a meeting that makes the owner busy gets its Busy blocks on the other accounts, like any meeting', async () => {
    const h = await world([Z, F, G])
    await make(h)
    await h.engine.setBlocking(true)
    await h.work()
    const [a] = (await starts(h)) as [number]
    val(await book(h, a))
    await h.work()
    for (const other of [F, G]) {
      const blocks = [...(h.google.account(other).calendars.get(other)?.events.values() ?? [])].filter((e) => e.raw.summary === 'Busy')
      expect(blocks, other).toHaveLength(1)
      expect(Date.parse((blocks[0]?.raw.start as { dateTime: string }).dateTime)).toBe(a)
    }
    // The block names nothing of the booking.
    expect(JSON.stringify(h.google.writes.filter((w) => w.calendarId === F))).not.toContain('Ada')
  })
})

describe('the owner’s notification', () => {
  test('says who and when on the company’s clock over the link’s name, and nothing of the visitor’s address or note', () => {
    const note = bookingNote({ name: 'Ada Quill', start: Date.UTC(2026, 10, 6, 18, 0), linkName: 'Intro call' }, 'America/Los_Angeles')
    expect(note.title).toMatch(/^Booked: Ada Quill, Fri, Nov 6, 10:00\sAM\sPST$/)
    expect(note.body).toBe('Intro call')
    expect(bookingNote({ name: 'Ada', start: Date.UTC(2026, 6, 6, 18, 0), linkName: 'x' }, 'America/Los_Angeles').title).toMatch(/11:00\sAM\sPDT$/)
  })

  test('is told once for each booking, whether it was made at once or found later by its event, and never for one that was refused', async () => {
    const h = await world()
    await make(h)
    const a = fri(10)
    h.google.failNext('events.insert', 400, { error: { code: 400, message: 'Invalid', errors: [{ reason: 'invalid' }] } })
    await book(h, a)
    expect(h.notified).toEqual([])
    val(await book(h, a))
    expect(h.notified).toHaveLength(1)
    await h.work()
    await sync(h)
    expect(h.notified).toHaveLength(1)
  })
})

describe('the visitor’s words', () => {
  test('the name and the note are cleaned and cut short; an em dash becomes a hyphen; an address in a name is refused', () => {
    const read = readGuestBooking({ start: 5, name: ' Ada\u0007  Quill \u2014 Jr ', email: ' ADA@Example.ORG ', note: `Hi\u0000 there \u2014 friend\nsecond line${'x'.repeat(5000)}` })
    expect(read).toMatchObject({ ok: true, value: { name: 'Ada Quill - Jr', email: 'ada@example.org' } })
    if (!read.ok) throw new Error('unreachable')
    expect(read.value.note.startsWith('Hi there - friend\nsecond line')).toBe(true)
    expect(read.value.note.length).toBe(BOOKING_LIMITS.visitorNoteMax)
    expect(read.value.note).not.toContain('\u2014')
    const long = readGuestBooking({ start: 5, name: 'N'.repeat(500), email: 'a@example.org', note: '' })
    expect(long.ok && long.value.name.length).toBe(BOOKING_LIMITS.visitorNameMax)
    for (const bad of [
      { start: 5, name: '', email: 'a@example.org' },
      { start: 5, name: 'Ada', email: 'not-an-email' },
      { start: 5, name: 'Ada', email: '' },
      { start: 0, name: 'Ada', email: 'a@example.org' },
      { start: 'soon', name: 'Ada', email: 'a@example.org' },
      { start: 5, name: 'visit http://evil.example now', email: 'a@example.org' },
      { start: 5, name: 'www.evil.example', email: 'a@example.org' },
      { start: 5, name: 'Ada', email: 'a@example.org', note: 7 },
      { start: 5, name: 'Ada', email: 'a@example.org', admin: true },
      null,
      'Ada',
    ]) {
      expect(readGuestBooking(bad)).toMatchObject({ ok: false, reason: 'bad-request' })
    }
  })

  test('what reaches Google is the cleaned text, and the owner’s own address is not accepted as a visitor’s', async () => {
    const h = await world([Z, F])
    await make(h)
    const [a] = (await starts(h)) as [number]
    // The owner's own addresses are refused in the one sentence every refusal for who the visitor is shares (below), and only for a time the link really offers.
    expect(await book(h, a, { email: Z })).toEqual({ ok: false, reason: 'limit', error: NOT_NOW_WORDS })
    expect(await book(h, a, { email: F })).toEqual({ ok: false, reason: 'limit', error: NOT_NOW_WORDS })
    expect(await book(h, a + 7 * MIN, { email: Z })).toEqual({ ok: false, reason: 'conflict', error: TAKEN_WORDS })
    expect(await book(h, a + 7 * MIN, { email: 'nobody@example.org' })).toEqual({ ok: false, reason: 'conflict', error: TAKEN_WORDS })
    expect(await book(h, a, { name: 'Ada \u2014 Quill', note: '<script>alert(1)</script> hi https://evil.example/x' })).toMatchObject({ ok: true })
    const w = inserts(h)[0]!
    expect(w.body.summary).toBe('Intro call: Ada - Quill')
    expect(JSON.stringify(w.body)).not.toContain('\u2014')
    // The note (markup, a link) is not in the invitation at all; the owner reads it, as text, in the booking's record.
    expect(JSON.stringify(w.body)).not.toContain('evil.example')
    expect(JSON.stringify(w.body)).not.toContain('<script>')
    expect(val(await h.engine.bookingLinks()).links[0]?.bookings[0]?.note).toBe('<script>alert(1)</script> hi https://evil.example/x')
  })
})

describe('what a limit counts, and what it says', () => {
  test('an address is one key however it is written: no +tag, no dots and one name for Gmail’s own domains; other domains keep their dots', () => {
    expect(canonicalAddress('Vic_Tim.x+one@GMail.com')).toBe('vic_timx@gmail.com')
    expect(canonicalAddress('v.i.c_tim@googlemail.com')).toBe('vic_tim@gmail.com')
    expect(canonicalAddress('a.b+c@example.org')).toBe('a.b@example.org')
    expect(canonicalAddress('+odd@example.org')).toBe('+odd@example.org')
  })

  test('a network is one key by its line: an IPv4 address as it is, an IPv6 address by its /64, however it is written', () => {
    expect(networkKeyOf('203.0.113.7')).toBe('203.0.113.7')
    expect(networkKeyOf('::ffff:203.0.113.7')).toBe('203.0.113.7')
    const a = networkKeyOf('2001:db8:1:2:aaaa:bbbb:cccc:dddd')
    expect(a).toBe('v6:2001:0db8:0001:0002')
    expect(networkKeyOf('2001:DB8:1:2::1')).toBe(a)
    expect(networkKeyOf('2001:db8:1:2:0:0:0:9')).toBe(a)
    expect(networkKeyOf('2001:db8:1:3::1')).not.toBe(a)
    expect(networkKeyOf('2001:db8::1')).toBe('v6:2001:0db8:0000:0000')
  })

  test('one inbox written four ways is one address to the limits (three a day), and each invitation still goes to the address as typed', async () => {
    const h = await world()
    await make(h, { gapMinutes: 0 })
    const slots = [mon(9), mon(9, 30), mon(10), mon(10, 30)]
    const typed = ['vic_tim@gmail.com', 'vic_tim+a@gmail.com', 'v.ic_tim@gmail.com', 'V.I.C_TIM+zz@googlemail.com']
    for (let i = 0; i < 3; i++) val(await book(h, slots[i] as number, { email: typed[i] }, 'intro', `10.5.0.${i}`))
    expect(await book(h, slots[3] as number, { email: typed[3] }, 'intro', '10.5.0.9')).toEqual({ ok: false, reason: 'limit', error: NOT_NOW_WORDS })
    expect(inserts(h).map((w) => (w.body.attendees as { email: string }[])[0]?.email)).toEqual(typed.slice(0, 3))
  })

  test('one IPv6 line rotating through its addresses is one network (ten a day)', async () => {
    const h = await world()
    await make(h, { gapMinutes: 0 })
    for (let i = 0; i < BOOKING_LIMITS.perNetwork; i++) val(await book(h, (await starts(h))[0] as number, { email: `u${i}@example.org` }, 'intro', `2001:db8:7:7:${i}::1`))
    expect(await book(h, (await starts(h))[0] as number, { email: 'late@example.org' }, 'intro', '2001:db8:7:7:ffff::2')).toEqual({ ok: false, reason: 'limit', error: NOT_NOW_WORDS })
    expect(await book(h, (await starts(h))[0] as number, { email: 'late@example.org' }, 'intro', '2001:db8:7:8::1')).toMatchObject({ ok: true })
  })

  test('every refusal for who the visitor is or how much they used the link is the same words and the same reason: the owner’s address, an address over its day, a network over its day', async () => {
    const h = await world()
    await make(h, { gapMinutes: 0 })
    const refusals: unknown[] = []
    refusals.push(await book(h, mon(9), { email: Z }, 'intro', '10.6.0.1'))
    for (let i = 0; i < BOOKING_LIMITS.perVisitor; i++) val(await book(h, mon(10, i * 30), { email: 'ann@example.org' }, 'intro', `10.6.1.${i}`))
    refusals.push(await book(h, mon(12), { email: 'ann@example.org' }, 'intro', '10.6.2.1'))
    for (let i = 0; i < BOOKING_LIMITS.perNetwork; i++) val(await book(h, (i < 6 ? mon(13) + i * 30 * MIN : mon(9) + DAY + (i - 6) * 30 * MIN), { email: `n${i}@example.org` }, 'intro', '10.6.3.1'))
    refusals.push(await book(h, mon(9, 30), { email: 'other@example.org' }, 'intro', '10.6.3.1'))
    for (const r of refusals) expect(r).toEqual({ ok: false, reason: 'limit', error: NOT_NOW_WORDS })
    // And a time the link never offered is the same answer whoever asks: the owner's address is no oracle without a real time.
    expect(await book(h, 1, { email: Z }, 'intro', '10.6.9.1')).toEqual(await book(h, 1, { email: 'x@example.org' }, 'intro', '10.6.9.2'))
  })
})

describe('a time waiting on Google is held until a read says otherwise', () => {
  test('an hour with every read failing does not let a time go, and another visitor is still refused it; the first successful read after the hour does', async () => {
    const h = await world()
    await make(h)
    const a = mon(10)
    h.google.failNext('events.insert', 503, { error: { code: 503, message: 'Backend Error' } })
    const got = val(await book(h, a))
    expect(got.booking.state).toBe('pending')
    h.google.failNext('events.list', 500, { error: { code: 500, message: 'Backend Error' } }, 200, Z)
    h.advance(BOOKING_HOLD_MS + 5 * MIN)
    await h.work()
    expect(h.rows(`SELECT id FROM booking WHERE state = 'held'`)).toHaveLength(1)
    expect(await starts(h)).not.toContain(a)
    expect(await book(h, a, { email: 'bea@example.org' }, 'intro', '10.7.0.1')).toMatchObject({ ok: false, reason: 'conflict' })
  })
})

describe('a move whose answer was lost', () => {
  test('is settled by the next read: the event’s times become the booking’s, and the move is counted', async () => {
    const h = await world()
    await make(h)
    const a = fri(10)
    const got = val(await book(h, a))
    const target = fri(14)
    // Google applies the patch and the answer never arrives.
    h.google.afterRequest = (op) => {
      if (op === 'events.patch') {
        h.google.afterRequest = null
        throw new Error('connection lost')
      }
    }
    expect(await h.engine.guestMove(got.secret, target)).toEqual({ ok: false, reason: 'conflict', error: UNSURE_WORDS })
    expect(h.rows<{ moves: number; start_ms: number }>(`SELECT moves, start_ms FROM booking`)[0]).toMatchObject({ moves: 0, start_ms: a })
    await h.work()
    expect(h.rows<{ moves: number; start_ms: number; moving_start: number | null }>(`SELECT moves, start_ms, moving_start FROM booking`)[0]).toMatchObject({ moves: 1, start_ms: target, moving_start: null })
    expect(val(await h.engine.guestBooking(got.secret)).start).toBe(target)
    // The old day is no longer counted for the link's most-per-day, and the old time is offered again.
    expect(await starts(h)).toContain(a)
  })

  test('a move the copy never shows is let go after the hour and a read, and the booking keeps its time without the move counted', async () => {
    const h = await world()
    await make(h)
    const a = fri(10)
    const got = val(await book(h, a))
    h.google.failNext('events.patch', 503, { error: { code: 503, message: 'Backend Error' } })
    expect(await h.engine.guestMove(got.secret, fri(14))).toEqual({ ok: false, reason: 'conflict', error: UNSURE_WORDS })
    expect(await starts(h)).not.toContain(fri(14))
    h.advance(BOOKING_HOLD_MS + 5 * MIN)
    await h.work()
    expect(h.rows<{ moves: number; start_ms: number; moving_start: number | null }>(`SELECT moves, start_ms, moving_start FROM booking`)[0]).toMatchObject({ moves: 0, start_ms: a, moving_start: null })
  })
})

describe('the limits', () => {
  test('one address is invited at most three times in a day, and holds at most five meetings that have not ended', async () => {
    const h = await world()
    await make(h, { gapMinutes: 0 })
    const slots = [mon(9), mon(9, 30), mon(10), mon(10, 30), mon(11), mon(11, 30)]
    for (let i = 0; i < BOOKING_LIMITS.perVisitor; i++) val(await book(h, slots[i] as number, {}, 'intro', `10.0.0.${i}`))
    const fourth = await book(h, slots[3] as number, {}, 'intro', '10.0.0.9')
    expect(fourth).toMatchObject({ ok: false, reason: 'limit' })
    expect(fourth).toEqual({ ok: false, reason: 'limit', error: NOT_NOW_WORDS })
    expect(inserts(h)).toHaveLength(3)
    // A day on, more may be made, up to five that have not ended.
    h.advance(25 * HOUR)
    h.store.askAll()
    await h.work()
    val(await book(h, slots[3] as number, {}, 'intro', '10.0.0.4'))
    val(await book(h, slots[4] as number, {}, 'intro', '10.0.0.5'))
    const sixth = await book(h, slots[5] as number, {}, 'intro', '10.0.0.6')
    expect(sixth).toMatchObject({ ok: false, reason: 'limit' })
    expect(sixth).toEqual({ ok: false, reason: 'limit', error: NOT_NOW_WORDS })
  })

  test('one network address makes at most ten bookings in a day, whoever it says it is', async () => {
    const h = await world()
    await make(h, { gapMinutes: 0 })
    for (let i = 0; i < BOOKING_LIMITS.perNetwork; i++) val(await book(h, (await starts(h))[0] as number, { email: `u${i}@example.org` }, 'intro', '192.0.2.50'))
    expect(await book(h, (await starts(h))[0] as number, { email: 'late@example.org' }, 'intro', '192.0.2.50')).toMatchObject({ ok: false, reason: 'limit' })
    // Another network is not held to it.
    expect(await book(h, (await starts(h))[0] as number, { email: 'late@example.org' }, 'intro', '192.0.2.51')).toMatchObject({ ok: true })
  })

  test('one link takes at most thirty bookings in a day', async () => {
    const h = await world()
    await make(h, { gapMinutes: 0 })
    for (let i = 0; i < BOOKING_LIMITS.perLink; i++) val(await book(h, (await starts(h))[0] as number, { email: `u${i}@example.org` }, 'intro', `10.1.0.${i}`))
    expect(await book(h, (await starts(h))[0] as number, { email: 'late@example.org' }, 'intro', '10.1.1.1')).toMatchObject({ ok: false, reason: 'limit' })
    expect(inserts(h)).toHaveLength(BOOKING_LIMITS.perLink)
  })

  test('a link’s most-per-day takes a full day off what it offers', async () => {
    const h = await world()
    await make(h, { perDay: 2, gapMinutes: 0 })
    expect((await starts(h)).filter((t) => day(t) === '2026-11-06').length).toBeGreaterThan(2)
    val(await book(h, fri(9), { email: 'a@example.org' }, 'intro', '10.2.0.1'))
    expect((await starts(h)).filter((t) => day(t) === '2026-11-06').length).toBeGreaterThan(2)
    val(await book(h, fri(11), { email: 'b@example.org' }, 'intro', '10.2.0.2'))
    const left = await starts(h)
    expect(left.filter((t) => day(t) === '2026-11-06')).toEqual([])
    expect(left.some((t) => day(t) === '2026-11-09')).toBe(true)
    expect(await book(h, fri(14), { email: 'c@example.org' }, 'intro', '10.2.0.3')).toMatchObject({ ok: false, reason: 'conflict' })
  })

  test('the network address is kept only as a keyed hash, and the secret only as a hash', async () => {
    const h = await world()
    await make(h)
    const a = fri(10)
    const got = val(await book(h, a))
    const everything = dump(h)
    expect(everything).not.toContain(NET)
    expect(everything).not.toContain(got.secret)
    const row = h.rows<{ manage_hash: string; network: string }>(`SELECT manage_hash, network FROM booking`)[0]!
    expect(row.manage_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.network).toMatch(/^[0-9a-f]{32}$/)
    // The same address is the same hash (so it can be counted), and another is not.
    const [b] = (await starts(h)) as [number]
    val(await book(h, b, { email: 'bea@example.org' }, 'intro', NET))
    val(await book(h, (await starts(h))[0] as number, { email: 'cy@example.org' }, 'intro', '203.0.113.8'))
    expect(new Set(h.rows<{ network: string }>(`SELECT network FROM booking`).map((r) => r.network)).size).toBe(2)
  })
})

describe('the booking’s own page', () => {
  async function booked(h: Harness, a = fri(10)) {
    await make(h)
    const got = val(await book(h, a))
    return { a, secret: got.secret }
  }

  test('is found by its secret alone: another secret, a secret cut short or nothing is not found, and the answer tells them apart from nothing', async () => {
    const h = await world()
    const { secret } = await booked(h)
    expect(val(await h.engine.guestBooking(secret))).toMatchObject({ name: 'Ada Quill', state: 'booked' })
    for (const bad of [`${secret}x`, secret.slice(0, -1), 'secret-999999', '', 'short', 5, null, 'a'.repeat(500)]) {
      expect(await h.engine.guestBooking(bad)).toMatchObject({ ok: false, reason: 'not-found' })
      expect(await h.engine.guestMove(bad, T0 + 5 * DAY)).toMatchObject({ ok: false, reason: 'not-found' })
      expect(await h.engine.guestCancel(bad)).toMatchObject({ ok: false, reason: 'not-found' })
      expect(await h.engine.guestBookingSlots(bad)).toMatchObject({ ok: false, reason: 'not-found' })
    }
    expect(writesOf(h, 'events.patch')).toEqual([])
    expect(writesOf(h, 'events.delete')).toEqual([])
  })

  test('a move picks another free time: the event is moved at Google with the guest told, the calendar’s copy has the new time, and the booking’s own time counts as free to itself', async () => {
    const h = await world()
    const { a, secret } = await booked(h)
    const mine = val(await h.engine.guestBookingSlots(secret)).starts
    // Its own time, and the time next to it that the gap would otherwise rule out, are free to it; the link's own list does not offer them.
    expect(mine).toContain(a)
    expect(mine).toContain(a + 30 * MIN)
    expect(await starts(h)).not.toContain(a + 30 * MIN)
    const target = fri(14)
    const moved = val(await h.engine.guestMove(secret, target))
    expect(moved).toMatchObject({ start: target, end: target + 30 * MIN, state: 'booked' })
    const w = writesOf(h, 'events.patch')[0]!
    expect(w.query).toEqual({ sendUpdates: 'all' })
    expect(w.level).toBe('events')
    expect(Object.keys(w.body).sort()).toEqual(['end', 'start'])
    expect((w.body.start as { dateTime: string }).dateTime).toBe('2026-11-06T14:00:00-08:00')
    expect(h.store.agenda(fri(0), fri(23)).events[0]).toMatchObject({ start: target })
    expect(val(await h.engine.bookingLinks()).links[0]?.bookings[0]).toMatchObject({ start: target })
    // The time it left is free again, the time it took is not, and it cannot be moved to where it is or to a time never offered.
    const now = await starts(h)
    expect(now).toContain(a)
    expect(now).not.toContain(target)
    expect(await h.engine.guestMove(secret, target)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await h.engine.guestMove(secret, target + 7 * MIN)).toMatchObject({ ok: false, reason: 'conflict' })
  })

  test('a move to a time another visitor holds, or that Google says is taken, is refused and the booking keeps its time', async () => {
    const h = await world([Z, F])
    const { a, secret } = await booked(h)
    const other = (await starts(h))[0] as number
    val(await book(h, other, { email: 'bea@example.org' }, 'intro', '198.51.100.9'))
    expect(await h.engine.guestMove(secret, other)).toEqual({ ok: false, reason: 'conflict', error: TAKEN_WORDS })
    const free = (val(await h.engine.guestBookingSlots(secret)).starts.filter((t) => t > other + 2 * HOUR)[0]) as number
    h.google.setEvent(F, F, { id: 'late', summary: 'Just added', start: iso(free), end: iso(free + HOUR) })
    expect(await h.engine.guestMove(secret, free)).toEqual({ ok: false, reason: 'conflict', error: TAKEN_WORDS })
    expect(writesOf(h, 'events.patch')).toEqual([])
    expect(val(await h.engine.guestBooking(secret)).start).toBe(a)
    // The time it asked for is let go: another visitor may take it.
    expect(h.store.bookings.holds(h.clock.t, BOOKING_HOLD_MS)).toEqual([])
  })

  test('a booking is moved at most three times, and a move whose outcome nobody knows holds the new time and says to look at the invitation', async () => {
    const h = await world()
    const { secret } = await booked(h)
    let at = val(await h.engine.guestBooking(secret)).start
    for (let i = 0; i < BOOKING_LIMITS.moves; i++) {
      const next = (val(await h.engine.guestBookingSlots(secret)).starts.find((t) => t > at + 3 * HOUR)) as number
      at = val(await h.engine.guestMove(secret, next)).start
      expect(at).toBe(next)
    }
    expect(val(await h.engine.guestBooking(secret))).toMatchObject({ canMove: false })
    expect(await h.engine.guestMove(secret, at + 5 * HOUR)).toMatchObject({ ok: false, reason: 'conflict' })
    expect(await h.engine.guestBookingSlots(secret)).toMatchObject({ ok: false, reason: 'conflict' })
    expect(writesOf(h, 'events.patch')).toHaveLength(BOOKING_LIMITS.moves)

    const h2 = await world()
    const second = await booked(h2)
    h2.google.failNext('events.patch', 503, { error: { code: 503, message: 'Backend Error' } })
    const target = second.a + 3 * HOUR
    expect(await h2.engine.guestMove(second.secret, target)).toEqual({ ok: false, reason: 'conflict', error: UNSURE_WORDS })
    // The time it asked for stays held for a while: nobody else can take it, and the booking still has its own.
    expect(await starts(h2)).not.toContain(target)
    expect(val(await h2.engine.guestBooking(second.secret)).start).toBe(second.a)
  })

  test('a cancellation deletes the event at Google with the guest told, takes it out of the calendar’s copy and frees the time; a second one changes nothing', async () => {
    const h = await world()
    const { a, secret } = await booked(h)
    const done = val(await h.engine.guestCancel(secret))
    expect(done).toMatchObject({ state: 'cancelled', canMove: false, canCancel: false })
    const w = writesOf(h, 'events.delete')[0]!
    expect(w.query).toEqual({ sendUpdates: 'all' })
    expect(w.level).toBe('events')
    expect(h.store.agenda(T0, T0 + DAY).events).toEqual([])
    expect(await starts(h)).toContain(a)
    expect(val(await h.engine.bookingLinks()).links[0]?.bookings[0]).toMatchObject({ state: 'cancelled' })
    expect(val(await h.engine.guestCancel(secret)).state).toBe('cancelled')
    expect(writesOf(h, 'events.delete')).toHaveLength(1)
    expect(await h.engine.guestMove(secret, a + 3 * HOUR)).toMatchObject({ ok: false, reason: 'conflict' })
    // A cancelled booking still counts against the address's invitations in the day: the invitation was sent.
    expect(h.store.bookings.madeByVisitor('ada@example.org', T0 - DAY)).toBe(1)
  })

  test('a cancellation whose outcome nobody knows says to look, and keeps the booking; an event already gone at Google is as good as cancelled', async () => {
    const h = await world()
    const { secret } = await booked(h)
    h.google.failNext('events.delete', 503, { error: { code: 503, message: 'Backend Error' } })
    expect(await h.engine.guestCancel(secret)).toEqual({ ok: false, reason: 'conflict', error: UNSURE_WORDS })
    expect(val(await h.engine.guestBooking(secret)).state).toBe('booked')
    h.google.failNext('events.delete', 404, { error: { code: 404, message: 'Not Found' } })
    expect(val(await h.engine.guestCancel(secret)).state).toBe('cancelled')
  })

  test('an event the owner removed at Google is a booking that was removed: the visitor’s page says so, the owner’s record says so, and the time is free again', async () => {
    const h = await world()
    const { a, secret } = await booked(h)
    const eventId = h.store.bookings.held().length === 0 ? h.rows<{ event_id: string }>(`SELECT event_id FROM booking`)[0]!.event_id : ''
    h.google.cancelEvent(Z, Z, eventId)
    h.advance(MIN)
    await sync(h)
    expect(val(await h.engine.guestBooking(secret))).toMatchObject({ state: 'removed', canMove: false, canCancel: false })
    expect(val(await h.engine.bookingLinks()).links[0]?.bookings[0]).toMatchObject({ state: 'removed' })
    expect(await starts(h)).toContain(a)
    expect(val(await h.engine.guestCancel(secret)).state).toBe('removed')
    expect(writesOf(h, 'events.delete')).toEqual([])
  })

  test('an event the owner moved at Google is the time the booking has', async () => {
    const h = await world()
    const { a, secret } = await booked(h)
    const row = h.rows<{ event_id: string }>(`SELECT event_id FROM booking`)[0]!
    h.google.setEvent(Z, Z, { id: row.event_id, summary: 'Intro call: Ada Quill', start: iso(a + 2 * HOUR), end: iso(a + 2 * HOUR + 30 * MIN), iCalUID: 'x@google.com', organizer: { email: Z, self: true } })
    h.advance(MIN)
    await sync(h)
    expect(val(await h.engine.guestBooking(secret))).toMatchObject({ start: a + 2 * HOUR, state: 'booked' })
    expect(val(await h.engine.bookingLinks()).links[0]?.bookings[0]).toMatchObject({ start: a + 2 * HOUR })
  })

  test('after the link is turned off a booking cannot be moved but can be cancelled; after the link is deleted the booking still stands and its visitor can cancel it', async () => {
    const h = await world()
    const { a, secret } = await booked(h)
    const link = val(await h.engine.bookingLinks()).links[0]!
    val(await h.engine.changeBookingLink(link.id, input({ enabled: false })))
    expect(val(await h.engine.guestBooking(secret))).toMatchObject({ canMove: false, canCancel: true, linkOpen: false, slug: 'intro' })
    expect(await h.engine.guestMove(secret, a + 3 * HOUR)).toMatchObject({ ok: false, reason: 'conflict' })
    val(await h.engine.deleteBookingLink(link.id))
    expect(val(await h.engine.guestBooking(secret))).toMatchObject({ canMove: false, canCancel: true, linkOpen: false, slug: null, title: 'Intro call' })
    expect(h.store.agenda(T0, T0 + DAY).events).toHaveLength(1)
    expect(val(await h.engine.guestCancel(secret)).state).toBe('cancelled')
  })

  test('a meeting that has been is past: it cannot be moved or cancelled', async () => {
    const h = await world()
    const { secret } = await booked(h)
    h.advance(2 * DAY)
    expect(val(await h.engine.guestBooking(secret))).toMatchObject({ state: 'past', canMove: false, canCancel: false })
    expect(await h.engine.guestCancel(secret)).toMatchObject({ ok: false, reason: 'conflict' })
  })
})

describe('no token and no secret is kept or leaked', () => {
  test('every answer, every log line and the whole store are free of tokens, and the write token is asked for each write and never held', async () => {
    const h = await world()
    await make(h)
    const a = fri(10)
    const results: unknown[] = []
    const got = val(await book(h, a))
    results.push(got.booking, await h.engine.guestSlots('intro'), await h.engine.bookingLinks())
    results.push(val(await h.engine.guestMove(got.secret, a + 3 * HOUR)), val(await h.engine.guestCancel(got.secret)))
    for (const text of [JSON.stringify(results), h.logs.join('\n'), dump(h)]) {
      expect(text).not.toMatch(/tok-/)
      expect(text).not.toMatch(/Bearer/i)
    }
    // A book, a move and a cancel: three writes, three tokens for `calendar.events`, each asked for and none held.
    expect(h.google.accessAsked.filter((x) => x.level === 'events')).toHaveLength(3)
    // The visitor's own secret is in no record of the owner's.
    expect(JSON.stringify(await h.engine.bookingLinks())).not.toContain(got.secret)
  })

  test('a fault in the store is one fixed sentence to the visitor and never the cause', async () => {
    const { createGuestCalendar, GUEST_READ_FAULT, GUEST_WRITE_FAULT } = await import('../src/guests')
    const logged: unknown[] = []
    const original = console.error
    console.error = (...a: unknown[]) => logged.push(a)
    try {
      const broken = createGuestCalendar({
        engine: {
          call: () => {
            throw new Error('secret detail: tok-abc and a manage secret')
          },
        },
      })
      const read = await broken.link('intro')
      const write = await broken.book('intro', {} as never, NET)
      expect(read).toEqual({ ok: false, kind: 'failed', reason: 'broken', message: GUEST_READ_FAULT })
      expect(write).toEqual({ ok: false, kind: 'failed', reason: 'broken', message: GUEST_WRITE_FAULT })
      expect(JSON.stringify([read, write])).not.toContain('tok-abc')
    } finally {
      console.error = original
    }
    expect(logged.length).toBe(2)
  })
})

describe('a link that holds its meetings in a call of the space (the space’s ADR 0026)', () => {
  const spaceLink = (h: Harness, over: Partial<BookingLinkInput> = {}) => make(h, { where: 'space', ...over })
  const call = (h: Harness) => h.calls!.made[0]!
  const lastInsert = (h: Harness) => inserts(h).at(-1)!.body as Record<string, unknown>

  test('where is Google Meet unless said otherwise, and a call in the space is offered and saved only where calls are on', async () => {
    expect(readBookingLink(input())).toMatchObject({ ok: true, value: { where: 'meet' } })
    expect(readBookingLink({ ...input(), where: 'space' })).toMatchObject({ ok: true, value: { where: 'space' } })
    for (const bad of ['zoom', '', 5, null]) expect(readBookingLink({ ...input(), where: bad }), String(bad)).toMatchObject({ ok: false, reason: 'bad-request' })
    // With no way to make a call wired: not offered, and not saved.
    const none = await world()
    expect(val(await none.engine.bookingLinks()).calls).toBe(false)
    expect(await none.engine.makeBookingLink(input({ where: 'space' }))).toMatchObject({ ok: false, reason: 'bad-request' })
    // With calls on: offered, saved, and shown on the link.
    const h = await world([Z, F], { calls: true })
    expect(val(await h.engine.bookingLinks()).calls).toBe(true)
    const link = await spaceLink(h)
    expect(link).toMatchObject({ where: 'space', problem: null })
    expect(val(await h.engine.bookingLinks()).links[0]).toMatchObject({ where: 'space' })
    expect(val(await h.engine.guestLink('intro'))).toMatchObject({ open: true, where: 'space' })
    // A link made without the choice is on Google Meet, and changing it changes the link and nothing it has already booked.
    const other = await make(h, { slug: 'other', where: undefined })
    expect(other.where).toBe('meet')
    expect(val(await h.engine.changeBookingLink(other.id, input({ slug: 'other', where: 'space' }))).where).toBe('space')
  })

  test('a booking makes one call after the time is held and Google says free, and an event whose place is the call: no Google Meet, the description says to join there, the visitor’s note is not in it', async () => {
    const h = await world([Z, F], { calls: true })
    await spaceLink(h)
    const a = fri(10)
    const got = val(await book(h, a))
    expect(got.booking).toMatchObject({ state: 'booked', where: 'space', meetLink: call(h).link })
    // One call, keyed by the booking's own id, titled as the event is, open from 30 minutes before the start to 2 hours after the end.
    const id = h.rows<{ id: string }>(`SELECT id FROM booking`)[0]!.id
    expect(h.calls!.made).toHaveLength(1)
    expect(call(h)).toMatchObject({ key: id, title: 'Intro call: Ada Quill', startsAt: a, opensAt: a - BOOKING_CALL_OPENS_BEFORE_MS, closesAt: a + 30 * MIN + BOOKING_CALL_CLOSES_AFTER_MS, guest: { name: 'Ada Quill', email: 'ada@example.org' }, closed: false })
    expect(BOOKING_CALL_OPENS_BEFORE_MS).toBe(30 * MIN)
    expect(BOOKING_CALL_CLOSES_AFTER_MS).toBe(2 * HOUR)
    const body = lastInsert(h)
    expect(body.conferenceData).toBeUndefined()
    expect(body.location).toBe(call(h).link)
    expect(String(body.description)).toContain(call(h).link)
    expect(String(body.description)).toContain('Join the video call in your browser, no account needed')
    expect(String(body.description)).toContain(`${ORIGIN}/book/manage/${got.secret}`)
    expect(JSON.stringify(body)).not.toContain('Looking forward to it.')
    expect(body.attendees).toEqual([{ email: 'ada@example.org', displayName: 'Ada Quill' }])
    // The call was made after Google was asked whether the owner was free, and before the event.
    const order = h.google.calls.filter((c) => c.startsWith('freeBusy.query') || c.startsWith('events.insert'))
    expect(order[0]).toContain('freeBusy')
    expect(h.calls!.asked.filter((x) => x.startsWith('make'))).toEqual([`make ${id}`])
    // The record in Settings says where it was held, and the visitor's page the same.
    expect(val(await h.engine.bookingLinks()).links[0]?.bookings[0]).toMatchObject({ where: 'space' })
    expect(val(await h.engine.guestBooking(got.secret))).toMatchObject({ where: 'space', meetLink: call(h).link })
  })

  test('a link on Google Meet is as it was, with calls on or off: a Meet request, no place, no call made', async () => {
    const h = await world([Z, F], { calls: true })
    await make(h)
    const got = val(await book(h, fri(10)))
    const body = lastInsert(h)
    expect(body.conferenceData).toMatchObject({ createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } } })
    expect(body.location).toBeUndefined()
    expect(String(body.description)).not.toContain('video call')
    expect(h.calls!.made).toEqual([])
    expect(got.booking.where).toBe('meet')
  })

  test('an event Google refuses leaves no open call and no hold', async () => {
    const h = await world([Z, F], { calls: true })
    await spaceLink(h)
    const a = fri(10)
    h.google.failNext('events.insert', 400, { error: { code: 400, message: 'Invalid', errors: [{ reason: 'invalid' }] } })
    expect(await book(h, a)).toEqual({ ok: false, reason: 'conflict', error: CLOSED_WORDS })
    expect(h.calls!.made).toHaveLength(1)
    expect(call(h).closed).toBe(true)
    expect(h.rows(`SELECT id FROM booking`)).toEqual([])
    expect(await starts(h)).toContain(a)
  })

  test('a time Google says is taken makes no call at all', async () => {
    const h = await world([Z, F], { calls: true })
    await spaceLink(h)
    const a = fri(10)
    h.google.setEvent(F, F, { id: 'busy', summary: 'Elsewhere', start: iso(a), end: iso(a + HOUR) })
    expect(await book(h, a)).toMatchObject({ ok: false, reason: 'conflict' })
    expect(h.calls!.made).toEqual([])
  })

  test('an insert whose answer is lost keeps the one call, and the booking found by its event has that call and no other', async () => {
    const h = await world([Z, F], { calls: true })
    await spaceLink(h)
    const a = fri(10)
    h.google.afterRequest = (op) => {
      if (op === 'events.insert') {
        h.google.afterRequest = null
        throw new Error('connection lost')
      }
    }
    const got = val(await book(h, a))
    expect(got.booking.state).toBe('pending')
    await h.work()
    expect(val(await h.engine.guestBooking(got.secret))).toMatchObject({ state: 'booked', meetLink: call(h).link })
    expect(h.calls!.made).toHaveLength(1)
    expect(call(h).closed).toBe(false)
  })

  test('an insert that did not happen at all closes the call when the hold is let go, and while Meet does not answer the hold stays and is looked at again', async () => {
    const h = await world([Z, F], { calls: true })
    await spaceLink(h)
    const a = mon(10)
    h.google.failNext('events.insert', 503, { error: { code: 503, message: 'Backend Error' } })
    const got = val(await book(h, a))
    expect(got.booking.state).toBe('pending')
    h.calls!.down = true
    h.advance(BOOKING_HOLD_MS + MIN)
    await h.work()
    expect(call(h).closed).toBe(false)
    expect(h.rows(`SELECT id FROM booking`)).toHaveLength(1)
    h.calls!.down = false
    h.advance(MIN)
    await h.work()
    expect(call(h).closed).toBe(true)
    expect(h.rows(`SELECT id FROM booking`)).toEqual([])
    expect(await starts(h)).toContain(a)
  })

  test('when a call cannot be made (calls off since the link was made, the month’s allowance used, Meet not answering) the link says it cannot be booked right now, the same sentence as an account that cannot be written to, and Settings says why; nothing falls back to Google Meet', async () => {
    const h = await world([Z, F], { calls: true })
    await spaceLink(h)
    const a = fri(10)
    // The allowance used up.
    h.calls!.meter = 'This month’s call allowance is used up.'
    h.advance(31_000)
    expect(val(await h.engine.bookingLinks()).links[0]?.problem).toBe('This month’s call allowance is used up.')
    expect(val(await h.engine.guestLink('intro')).open).toBe(false)
    expect(await h.engine.guestSlots('intro')).toEqual({ ok: false, reason: 'conflict', error: CLOSED_WORDS })
    expect(await book(h, a)).toEqual({ ok: false, reason: 'conflict', error: CLOSED_WORDS })
    // Even where the page's last look at the allowance is a moment old, Meet's own refusal is the same sentence and leaves nothing behind.
    h.calls!.meter = null
    h.advance(31_000)
    expect(val(await h.engine.guestLink('intro')).open).toBe(true)
    h.calls!.meter = 'This month’s call allowance is used up.'
    expect(await book(h, a)).toEqual({ ok: false, reason: 'conflict', error: CLOSED_WORDS })
    expect(h.rows(`SELECT id FROM booking`)).toEqual([])
    expect(inserts(h)).toEqual([])
    // Meet not answering at all.
    h.calls!.meter = null
    h.calls!.down = true
    h.advance(31_000)
    expect(val(await h.engine.bookingLinks()).links[0]?.problem).toContain('did not answer')
    expect(await book(h, a)).toEqual({ ok: false, reason: 'conflict', error: CLOSED_WORDS })
    expect(h.rows(`SELECT id FROM booking`)).toEqual([])
    // Calls switched off.
    h.calls!.down = false
    h.calls!.on = false
    expect(val(await h.engine.bookingLinks()).calls).toBe(false)
    expect(val(await h.engine.bookingLinks()).links[0]?.problem).toContain('Calls are not turned on')
    expect(val(await h.engine.guestLink('intro')).open).toBe(false)
    expect(await book(h, a)).toEqual({ ok: false, reason: 'conflict', error: CLOSED_WORDS })
    expect(inserts(h)).toEqual([])
    expect(h.calls!.made).toEqual([])
  })

  test('a move keeps the same call and link at the new time, and the call’s window follows', async () => {
    const h = await world([Z, F], { calls: true })
    await spaceLink(h)
    const a = fri(10)
    const got = val(await book(h, a))
    const link = call(h).link
    const target = fri(14)
    const moved = val(await h.engine.guestMove(got.secret, target))
    expect(moved).toMatchObject({ state: 'booked', start: target, meetLink: link })
    expect(h.calls!.made).toHaveLength(1)
    expect(call(h)).toMatchObject({ link, startsAt: target, opensAt: target - 30 * MIN, closesAt: target + 30 * MIN + 2 * HOUR, closed: false })
    // The patch did not ask for another Meet or another place.
    expect(Object.keys(writesOf(h, 'events.patch')[0]!.body).sort()).toEqual(['end', 'start'])
  })

  test('a move whose call Meet did not hear of is followed by the alarm, and nothing else is moved meanwhile', async () => {
    const h = await world([Z, F], { calls: true })
    await spaceLink(h)
    const got = val(await book(h, fri(10)))
    const target = fri(14)
    h.calls!.down = true
    expect(val(await h.engine.guestMove(got.secret, target))).toMatchObject({ start: target })
    expect(call(h).startsAt).toBe(fri(10))
    await h.work()
    expect(call(h).startsAt).toBe(fri(10))
    h.calls!.down = false
    h.advance(MIN)
    await h.work()
    expect(call(h)).toMatchObject({ startsAt: target, opensAt: target - 30 * MIN })
  })

  test('a cancel closes the call; a cancel Meet did not hear of is closed by the alarm; a closed call is not asked again', async () => {
    const h = await world([Z, F], { calls: true })
    await spaceLink(h)
    const first = val(await book(h, fri(10)))
    expect(val(await h.engine.guestCancel(first.secret)).state).toBe('cancelled')
    expect(call(h).closed).toBe(true)
    expect(val(await h.engine.guestBooking(first.secret)).meetLink).toBeNull()
    const closes = () => h.calls!.asked.filter((x) => x.startsWith('close')).length
    expect(closes()).toBe(1)
    await h.work()
    expect(closes()).toBe(1)
    // The second: Meet is down when it is cancelled.
    const second = val(await book(h, fri(14), { email: 'bea@example.org' }))
    h.calls!.down = true
    expect(val(await h.engine.guestCancel(second.secret)).state).toBe('cancelled')
    expect(h.calls!.made[1]!.closed).toBe(false)
    h.advance(MIN)
    await h.work()
    expect(h.calls!.made[1]!.closed).toBe(false)
    h.calls!.down = false
    h.advance(MIN)
    await h.work()
    expect(h.calls!.made[1]!.closed).toBe(true)
    const after = closes()
    await h.work()
    expect(closes()).toBe(after)
  })

  test('a booking keeps what it was booked with: a link changed to Google Meet, or calls turned off, leaves its call and its page as they were, and it can still be cancelled', async () => {
    const h = await world([Z, F], { calls: true })
    const link = await spaceLink(h)
    const got = val(await book(h, fri(10)))
    val(await h.engine.changeBookingLink(link.id, input({ where: 'meet' })))
    expect(val(await h.engine.guestBooking(got.secret))).toMatchObject({ where: 'space', meetLink: call(h).link })
    // Calls switched off, and the allowance used up: the booking already made is still cancelled, which closes its call.
    h.calls!.meter = 'used up'
    expect(val(await h.engine.guestCancel(got.secret)).state).toBe('cancelled')
    expect(call(h).closed).toBe(true)
  })

  test('a booking found cancelled or held by nothing is never given another booking’s call', async () => {
    const h = await world([Z, F], { calls: true })
    await spaceLink(h)
    const one = val(await book(h, fri(10)))
    const two = val(await book(h, fri(14), { email: 'bea@example.org' }))
    expect(h.calls!.made.map((c) => c.link)).toHaveLength(2)
    expect(val(await h.engine.guestBooking(one.secret)).meetLink).not.toBe(val(await h.engine.guestBooking(two.secret)).meetLink)
  })
})
