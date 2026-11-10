import { describe, expect, test } from 'bun:test'
import { CALENDAR_WINDOW_MAX_MS } from '@space/workspace'
import { DAY, grant, HOUR, type Harness, harness, T0 } from '../test-support/harness'

/**
 * What the tab, Today and Settings are drawn from: the agenda merged across accounts, the event's card, and the accounts with their calendars, all read from the STORE (never from Google: every test here reads
 * after Google has been made to refuse). What this cannot show is how the page draws them (the space's screen tests).
 */

const Z = 'tessa@northfield.example'
const F = 'tessa@ashgrove.example'
const U = 'tessa_marlow@gmail.com'
const H = 'tessa.marlow@fernway.example'
const iso = (ms: number) => new Date(ms).toISOString()

async function world() {
  const h = harness()
  for (const a of [Z, F, U, H]) {
    h.connect(a)
    h.google.addCalendar(a, { id: a, summary: a, primary: true })
  }
  return h
}

const agenda = async (h: Harness, from = T0 - DAY, to = T0 + 14 * DAY) => {
  const got = await h.engine.agenda(from, to)
  if (!got.ok) throw new Error(got.error)
  return got.value
}

describe('the agenda', () => {
  test('is every shown calendar of every account merged by time, each event naming its account and that account’s colour slot', async () => {
    const h = await world()
    h.google.setEvent(F, F, { id: 'late', summary: 'Ashgrove board', start: iso(T0 + 5 * HOUR), end: iso(T0 + 6 * HOUR) })
    h.google.setEvent(Z, Z, { id: 'early', summary: 'Northfield Works standup', start: iso(T0 + HOUR), end: iso(T0 + 2 * HOUR) })
    h.google.setEvent(H, H, { id: 'mid', summary: 'Fernway sync', start: iso(T0 + 3 * HOUR), end: iso(T0 + 4 * HOUR) })
    h.google.setEvent(U, U, { id: 'next-day', summary: 'Dentist', start: iso(T0 + DAY), end: iso(T0 + DAY + HOUR) })
    await h.work()
    const a = await agenda(h)
    expect(a.events.map((e) => [e.title, e.accounts.map((x) => x.label)])).toEqual([
      ['Northfield Works standup', ['tessa']],
      ['Fernway sync', ['tessa.marlow']],
      ['Ashgrove board', ['tessa']],
      ['Dentist', ['tessa_marlow']],
    ])
    // Four accounts, four different colour slots, given in the order they were first seen and kept.
    expect(a.accounts.map((x) => x.hue)).toEqual([0, 1, 2, 3])
    expect(a.events.map((e) => e.accounts[0]?.hue)).toEqual([0, 3, 1, 2])
  })

  test('is read from the store: with Google refusing everything, the agenda is still there', async () => {
    const h = await world()
    h.google.setEvent(Z, Z, { id: 'e', summary: 'Standup', start: iso(T0 + HOUR), end: iso(T0 + 2 * HOUR) })
    await h.work()
    h.google.failNext('events.list', 500, {}, 99)
    h.google.failNext('calendarList.list', 500, {}, 99)
    h.advance(DAY)
    const mark = h.google.calls.length
    const a = await agenda(h)
    expect(a.events.map((e) => e.title)).toEqual(['Standup'])
    expect(h.google.calls.length).toBe(mark)
  })

  test('the same meeting in two of the person’s calendars is ONE event naming both accounts', async () => {
    const h = await world()
    const meeting = { iCalUID: 'board-2026-11@google.com', summary: 'Board call', start: iso(T0 + 2 * HOUR), end: iso(T0 + 3 * HOUR) }
    h.google.setEvent(Z, Z, { id: 'a', ...meeting, attendees: [{ email: Z, self: true, responseStatus: 'accepted' }, { email: 'dana@example.com', responseStatus: 'accepted' }] })
    h.google.setEvent(F, F, { id: 'b', ...meeting, attendees: [{ email: F, self: true, responseStatus: 'needsAction' }] })
    // A different meeting at the same time with another id is its own event.
    h.google.setEvent(U, U, { id: 'c', iCalUID: 'other@google.com', summary: 'Also at 2', start: meeting.start, end: meeting.end })
    await h.work()
    const a = await agenda(h)
    expect(a.events.map((e) => [e.title, e.accounts.map((x) => x.address)])).toEqual([
      ['Also at 2', [U]],
      ['Board call', [Z, F]],
    ])
    const card = h.engine.event(a.events[1]?.id as string)
    expect(card).toMatchObject({ ok: true })
    expect(card.ok && card.value.accounts.map((x) => x.address)).toEqual([Z, F])
  })

  test('the same meeting answered differently at two addresses is read as the best of the answers, in whichever order the rows are read: a yes anywhere is a yes, so Today never hides a meeting for a no at the other address', async () => {
    const cases: [string, string, string][] = [
      ['declined', 'accepted', 'accepted'],
      ['accepted', 'declined', 'accepted'],
      ['declined', 'tentative', 'tentative'],
      ['declined', 'needsAction', 'needsAction'],
      ['needsAction', 'tentative', 'tentative'],
      ['declined', 'declined', 'declined'],
    ]
    for (const [atZ, atF, want] of cases) {
      const h = await world()
      const meeting = { iCalUID: 'both@google.com', summary: 'Both addresses', start: iso(T0 + 2 * HOUR), end: iso(T0 + 3 * HOUR) }
      h.google.setEvent(Z, Z, { id: 'a', ...meeting, attendees: [{ email: Z, self: true, responseStatus: atZ }] })
      h.google.setEvent(F, F, { id: 'b', ...meeting, attendees: [{ email: F, self: true, responseStatus: atF }] })
      await h.work()
      const [e] = (await agenda(h)).events
      expect([atZ, atF, e?.response]).toEqual([atZ, atF, want])
      const card = h.engine.event(e?.id as string)
      expect(card.ok && (card.value.response as string | null)).toBe(want)
      // And the copy that has no answer (the account's own event) never hides one that has.
    }
    const h = await world()
    const meeting = { iCalUID: 'one@google.com', summary: 'One answer', start: iso(T0 + 2 * HOUR), end: iso(T0 + 3 * HOUR) }
    h.google.setEvent(Z, Z, { id: 'a', ...meeting })
    h.google.setEvent(F, F, { id: 'b', ...meeting, attendees: [{ email: F, self: true, responseStatus: 'declined' }] })
    await h.work()
    expect((await agenda(h)).events[0]?.response).toBe('declined')
  })

  test('an event is placed by when it overlaps the window; one that ended before it, or starts after it, is not in it', async () => {
    const h = await world()
    h.google.setEvent(Z, Z, { id: 'in', summary: 'Spans the start', start: iso(T0 - HOUR), end: iso(T0 + HOUR) })
    h.google.setEvent(Z, Z, { id: 'before', summary: 'Ended', start: iso(T0 - 3 * HOUR), end: iso(T0 - 2 * HOUR) })
    h.google.setEvent(Z, Z, { id: 'after', summary: 'Starts at the end', start: iso(T0 + 4 * HOUR), end: iso(T0 + 5 * HOUR) })
    await h.work()
    const a = await agenda(h, T0, T0 + 4 * HOUR)
    expect(a.events.map((e) => e.title)).toEqual(['Spans the start'])
  })

  test('an all-day event is drawn by its days, on the company’s clock', async () => {
    const h = await world()
    h.google.setEvent(Z, Z, { id: 'off', summary: 'Off site', startDate: '2026-11-06', endDate: '2026-11-08' })
    await h.work()
    const [e] = (await agenda(h)).events
    expect(e).toMatchObject({ allDay: true, startDate: '2026-11-06', endDate: '2026-11-07', start: Date.parse('2026-11-06T08:00:00Z'), end: Date.parse('2026-11-08T08:00:00Z') })
  })

  test('hidden calendars and accounts that are disconnected or need the calendar permission contribute nothing', async () => {
    const h = await world()
    h.google.setEvent(Z, Z, { id: 'e', summary: 'Shown', start: iso(T0 + HOUR), end: iso(T0 + 2 * HOUR) })
    h.google.addCalendar(Z, { id: 'hol', summary: 'Holidays', accessRole: 'reader' })
    h.google.setEvent(Z, 'hol', { id: 'h', summary: 'Hidden holiday', start: iso(T0 + HOUR), end: iso(T0 + 2 * HOUR) })
    await h.work()
    expect((await agenda(h)).events.map((e) => e.title)).toEqual(['Shown'])
  })

  test('a lapsed account’s events are the last picture and say so; the account says when it was read', async () => {
    const h = await world()
    h.google.setEvent(F, F, { id: 'f', summary: 'Old picture', start: iso(T0 + 3 * HOUR), end: iso(T0 + 4 * HOUR) })
    await h.work()
    const readAt = h.clock.t
    h.advance(2 * DAY)
    h.grants[1] = grant(F, { lapsed: true })
    await h.work()
    const a = await agenda(h)
    expect(a.events[0]).toMatchObject({ title: 'Old picture', stale: true, readAt })
    expect(a.accounts.find((x) => x.address === F)).toMatchObject({ state: 'lapsed', readAt })
  })

  test('a window that is backwards, or wider than 62 days, is refused', async () => {
    const h = await world()
    expect(await h.engine.agenda(T0, T0)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await h.engine.agenda(T0, T0 - 1)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await h.engine.agenda(T0, T0 + CALENDAR_WINDOW_MAX_MS + 1)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await h.engine.agenda(T0, T0 + CALENDAR_WINDOW_MAX_MS)).toMatchObject({ ok: true })
    expect(await h.engine.agenda(Number.NaN, T0)).toMatchObject({ ok: false })
  })
})

describe('the event’s card', () => {
  test('its place, its video link, who is invited and how each answered, who is organising, and the person’s own answer', async () => {
    const h = await world()
    h.google.setEvent(Z, Z, {
      id: 'e',
      summary: 'Intro with Arun',
      start: iso(T0 + 2 * HOUR),
      end: iso(T0 + 3 * HOUR),
      location: 'Juniper, 1 Main St',
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
      htmlLink: 'https://www.google.com/calendar/event?eid=abc',
      description: '<p>Bring <b>numbers</b></p>',
      organizer: { email: 'arun@example.org', displayName: 'Arun Mehta' },
      attendees: [
        { email: 'arun@example.org', displayName: 'Arun Mehta', organizer: true, responseStatus: 'accepted' },
        { email: Z, self: true, responseStatus: 'needsAction' },
      ],
    })
    await h.work()
    const id = (await agenda(h)).events[0]?.id as string
    const got = h.engine.event(id)
    if (!got.ok) throw new Error(got.error)
    expect(got.value).toMatchObject({
      title: 'Intro with Arun',
      location: 'Juniper, 1 Main St',
      videoLink: 'https://meet.google.com/abc-defg-hij',
      htmlLink: 'https://www.google.com/calendar/event?eid=abc',
      description: 'Bring numbers',
      organizer: { name: 'Arun Mehta', email: 'arun@example.org' },
      response: 'needsAction',
      status: 'confirmed',
    })
    expect(got.value.guests.map((g) => [g.email, g.response, g.self])).toEqual([
      ['arun@example.org', 'accepted', false],
      [Z, 'needsAction', true],
    ])
  })

  test('an event that has gone, a key that names none and a key that is not one are all not-found', async () => {
    const h = await world()
    h.google.setEvent(Z, Z, { id: 'e', summary: 'Gone soon', start: iso(T0 + HOUR), end: iso(T0 + 2 * HOUR) })
    await h.work()
    const id = (await agenda(h)).events[0]?.id as string
    expect(h.engine.event(id).ok).toBe(true)
    h.google.cancelEvent(Z, Z, 'e')
    h.store.markCalendarDirty(`${Z}|${Z}`)
    await h.work()
    expect(h.engine.event(id)).toMatchObject({ ok: false, reason: 'not-found' })
    expect(h.engine.event(`${Z}|${Z}|nope`)).toMatchObject({ ok: false, reason: 'not-found' })
    expect(h.engine.event('nope')).toMatchObject({ ok: false, reason: 'not-found' })
    expect(h.engine.event('../../x')).toMatchObject({ ok: false, reason: 'not-found' })
    expect(h.engine.event('a'.repeat(2000))).toMatchObject({ ok: false, reason: 'not-found' })
  })
})

describe('the accounts', () => {
  test('each account with its calendars, the shown switch, and one sentence when it is not whole', async () => {
    const h = await world()
    h.google.addCalendar(Z, { id: 'hol', summary: 'Holidays', accessRole: 'reader', backgroundColor: '#0b8043' })
    h.grants[1] = grant(F, { lapsed: true })
    h.grants[2] = grant(U, { calendar: false })
    h.grants[3] = grant(H, { connected: false })
    await h.work()
    const got = await h.engine.calendars()
    if (!got.ok) throw new Error(got.error)
    const [z, f, u, hs] = got.value
    expect(z).toMatchObject({ address: Z, label: 'tessa', state: 'live', reason: null })
    expect(z?.calendars.map((c) => [c.name, c.shown, c.primary, c.color])).toEqual([
      [Z, true, true, null],
      ['Holidays', false, false, '#0b8043'],
    ])
    expect(f).toMatchObject({ state: 'lapsed' })
    expect(f?.reason).toContain('Connect it again')
    expect(u).toMatchObject({ state: 'needs-calendar' })
    expect(u?.reason).toContain('Press Connect calendar')
    expect(hs).toMatchObject({ state: 'disconnected' })
  })

  test('a read of the list asks the inbox who is connected, but not more than every half minute', async () => {
    const h = await world()
    await h.engine.calendars()
    const asked = h.grantAsks.n
    await h.engine.calendars()
    await h.engine.agenda(T0, T0 + DAY)
    expect(h.grantAsks.n).toBe(asked)
    h.advance(31_000)
    await h.engine.calendars()
    expect(h.grantAsks.n).toBe(asked + 1)
  })

  test('a new account the inbox now lists is found at the next read of the list, and owes the alarm', async () => {
    const h = harness()
    const first = await h.engine.calendars()
    expect(first).toEqual({ ok: true, value: [] })
    h.connect(Z)
    h.google.addCalendar(Z, { id: Z, summary: 'Tessa', primary: true })
    h.advance(31_000)
    const mark = h.alarms.length
    const got = await h.engine.calendars()
    expect(got.ok && got.value.map((a) => a.address)).toEqual([Z])
    expect(h.alarms.length).toBeGreaterThan(mark)
  })
})

describe('what never reaches a screen', () => {
  test('no token of any kind, in the agenda, a card, the accounts, the logs or a refusal', async () => {
    const h = await world()
    h.google.setEvent(Z, Z, { id: 'e', summary: 'Standup', start: iso(T0 + HOUR), end: iso(T0 + 2 * HOUR) })
    h.google.failNext('events.list', 500, { error: { code: 500, message: 'Backend Error' } })
    await h.work()
    h.store.markCalendarDirty(`${Z}|${Z}`)
    await h.work()
    const everything = JSON.stringify([await agenda(h), h.engine.event(`${Z}|${Z}|e`), await h.engine.calendars(), h.logs, h.store.accountViews()])
    expect(everything).not.toMatch(/tok-/)
    for (const c of h.google.channels) expect(everything).not.toContain(c.token)
    expect(h.rows<{ n: number }>(`SELECT count(*) AS n FROM channel WHERE token <> ''`)[0]?.n).toBeGreaterThan(0)
  })
})
