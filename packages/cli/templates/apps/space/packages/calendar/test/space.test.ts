import { describe, expect, test } from 'bun:test'
import { CALENDAR_FOR_SPACE_METHODS, signedIn } from '@space/workspace'
import { createSpaceCalendar } from '../src/space'
import { harness, HOUR, OWNER, person, T0, WITH_TEAMMATE, NORTHFIELD } from '../test-support/harness'

/**
 * The calendar as the space calls it: the owner's, and nobody else's. The space's one sign-in check has already named the person; this is the rule that is left.
 */

const Z = 'tessa@northfield.example'
const iso = (ms: number) => new Date(ms).toISOString()
const exp = Math.floor(T0 / 1000) + 3600

async function world() {
  const h = harness()
  h.connect(Z)
  h.google.addCalendar(Z, { id: Z, summary: 'Tessa', primary: true })
  h.google.setEvent(Z, Z, { id: 'e', summary: 'Standup', start: iso(T0 + HOUR), end: iso(T0 + 2 * HOUR) })
  await h.work()
  const owner = signedIn(person(NORTHFIELD, OWNER), exp)
  const dana = signedIn(person(WITH_TEAMMATE, 'dana@northfield.example'), exp)
  return { h, owner, dana, calendar: createSpaceCalendar({ engine: h.api, install: NORTHFIELD }), teammates: createSpaceCalendar({ engine: h.api, install: WITH_TEAMMATE }) }
}

describe('the space’s face', () => {
  test('has exactly the contract’s methods', async () => {
    const { calendar } = await world()
    expect(Object.keys(calendar).sort()).toEqual([...CALENDAR_FOR_SPACE_METHODS].sort())
  })

  test('the owner reads the accounts, the agenda and a card, and shows and hides a calendar', async () => {
    const { h, owner, calendar } = await world()
    const accounts = await calendar.calendars(owner)
    expect(accounts).toMatchObject({ ok: true, value: [{ address: Z, state: 'live' }] })
    const agenda = await calendar.agenda(owner, T0, T0 + 24 * HOUR)
    expect(agenda).toMatchObject({ ok: true, value: { events: [{ title: 'Standup' }] } })
    const id = agenda.ok ? (agenda.value.events[0]?.id as string) : ''
    expect(await calendar.event(owner, id)).toMatchObject({ ok: true, value: { title: 'Standup' } })
    expect(await calendar.setShown(owner, `${Z}|${Z}`, false)).toMatchObject({ ok: true, value: { shown: false } })
    expect(h.store.eventCount()).toBe(0)
    expect(await calendar.syncNow(owner)).toMatchObject({ ok: true })
  })

  test('a teammate who is not an owner is signed in and admitted to none of it, and nothing is changed', async () => {
    const { h, dana, teammates } = await world()
    for (const answer of [
      await teammates.calendars(dana),
      await teammates.agenda(dana, T0, T0 + HOUR),
      await teammates.event(dana, `${Z}|${Z}|e`),
      await teammates.setShown(dana, `${Z}|${Z}`, false),
      await teammates.syncNow(dana),
    ]) {
      expect(answer).toMatchObject({ ok: false, kind: 'refused', reason: 'not-admitted' })
    }
    expect(h.store.calendar(`${Z}|${Z}`)?.shown).toBe(true)
  })

  test('a refusal of the engine is a refusal, with its words', async () => {
    const { owner, calendar } = await world()
    expect(await calendar.agenda(owner, T0 + 1, T0)).toMatchObject({ ok: false, kind: 'refused', reason: 'bad-request' })
    expect(await calendar.event(owner, 'nope')).toMatchObject({ ok: false, kind: 'refused', reason: 'not-found' })
  })

  test('a fault is a failure in one fixed sentence, logged and never shown, and never an exception', async () => {
    const { owner } = await world()
    const broken = createSpaceCalendar({
      engine: {
        call: () => {
          throw new Error('secret detail: tok-abc')
        },
      },
      install: NORTHFIELD,
    })
    const logged: unknown[] = []
    const original = console.error
    console.error = (...a: unknown[]) => logged.push(a)
    try {
      const answer = await broken.calendars(owner)
      expect(answer).toEqual({ ok: false, kind: 'failed', reason: 'broken', message: 'The calendar could not answer that. Nothing was changed.' })
      expect(JSON.stringify(answer)).not.toContain('tok-abc')
    } finally {
      console.error = original
    }
    expect(logged.length).toBe(1)
  })
})

describe('the events a mail’s calendar part names, found by iCalendar id', () => {
  const DAY = 24 * HOUR
  const weekly = (id: string, at: number) => ({ id, summary: 'Weekly sync', iCalUID: 'weekly1@google.com', start: iso(at), end: iso(at + HOUR) })

  test('the owner gets one answer per ask, in order: the event the id names, or null for one the calendar does not hold', async () => {
    const { owner, calendar } = await world()
    const answer = await calendar.eventsByUid(owner, [
      { uid: 'e@google.com', occurrence: null },
      { uid: 'nobody@google.com', occurrence: null },
      { uid: '', occurrence: null },
    ])
    expect(answer.ok).toBe(true)
    const found = answer.ok ? answer.value : []
    expect(found).toHaveLength(3)
    expect(found[0]).toMatchObject({ title: 'Standup', start: T0 + HOUR })
    expect(found[0]?.id).toBe(`${Z}|${Z}|e`)
    expect(found[1]).toBeNull()
    expect(found[2]).toBeNull()
    // The id is the card's address: the same event `event` gives.
    expect(await calendar.event(owner, found[0]?.id as string)).toMatchObject({ ok: true, value: { title: 'Standup' } })
  })

  /** The owner's calendar with these events on it from the first read. */
  async function calendarWith(seed: (h: ReturnType<typeof harness>) => void) {
    const h = harness()
    h.connect(Z)
    h.google.addCalendar(Z, { id: Z, summary: 'Tessa', primary: true })
    seed(h)
    await h.work()
    const owner = signedIn(person(NORTHFIELD, OWNER), exp)
    const calendar = createSpaceCalendar({ engine: h.api, install: NORTHFIELD })
    const ask = async (uid: string, occurrence: { at: number | null; date: string | null } | null) => {
      const answer = await calendar.eventsByUid(owner, [{ uid, occurrence }])
      return answer.ok ? answer.value[0] : undefined
    }
    return { h, owner, calendar, ask }
  }

  test('a repeating event with no occurrence named is found at its next occurrence from now; one occurrence is found by its moment', async () => {
    const { ask } = await calendarWith((h) => {
      for (const [id, at] of [['w1', T0 - 7 * DAY], ['w2', T0 + 2 * DAY], ['w3', T0 + 9 * DAY]] as const) h.google.setEvent(Z, Z, weekly(id, at))
    })
    expect((await ask('weekly1@google.com', null))?.start).toBe(T0 + 2 * DAY)
    expect((await ask('weekly1@google.com', { at: T0 + 9 * DAY, date: null }))?.start).toBe(T0 + 9 * DAY)
    expect((await ask('weekly1@google.com', { at: T0 - 7 * DAY, date: null }))?.start).toBe(T0 - 7 * DAY)
    // An occurrence the calendar does not hold is not guessed at.
    expect(await ask('weekly1@google.com', { at: T0 + 100 * DAY, date: null })).toBeNull()
  })

  test('once every occurrence is past, the latest is the one', async () => {
    const { ask } = await calendarWith((h) => {
      for (const [id, at] of [['w1', T0 - 9 * DAY], ['w2', T0 - 3 * DAY], ['w3', T0 - 1 * DAY]] as const) h.google.setEvent(Z, Z, weekly(id, at))
    })
    expect((await ask('weekly1@google.com', null))?.start).toBe(T0 - 1 * DAY)
  })

  test('an all-day occurrence is found by its day', async () => {
    const { ask } = await calendarWith((h) => {
      h.google.setEvent(Z, Z, { id: 'a1', iCalUID: 'offsite@google.com', summary: 'Offsite', startDate: '2026-11-13', endDate: '2026-11-14' })
      h.google.setEvent(Z, Z, { id: 'a2', iCalUID: 'offsite@google.com', summary: 'Offsite', startDate: '2026-11-20', endDate: '2026-11-21' })
    })
    expect(await ask('offsite@google.com', { at: null, date: '2026-11-20' })).toMatchObject({ title: 'Offsite', allDay: true, startDate: '2026-11-20' })
    expect(await ask('offsite@google.com', { at: null, date: '2026-12-01' })).toBeNull()
  })

  test('an event in a hidden calendar is not found, and nothing is asked of Google', async () => {
    const { h, owner, calendar } = await world()
    await calendar.setShown(owner, `${Z}|${Z}`, false)
    const calls = h.google.calls.length
    const answer = await calendar.eventsByUid(owner, [{ uid: 'e@google.com', occurrence: null }])
    expect(answer.ok ? answer.value : 'refused').toEqual([null])
    expect(h.google.calls.length).toBe(calls)
  })

  test('a teammate who is not an owner is admitted to none of it', async () => {
    const { dana, teammates } = await world()
    expect(await teammates.eventsByUid(dana, [{ uid: 'e@google.com', occurrence: null }])).toMatchObject({ ok: false, kind: 'refused', reason: 'not-admitted' })
  })

  test('too many asks, an id that is not text and a moment that is not a number are refused, and nothing is looked up', async () => {
    const { owner, calendar } = await world()
    const many = Array.from({ length: 51 }, () => ({ uid: 'e@google.com', occurrence: null }))
    expect(await calendar.eventsByUid(owner, many)).toMatchObject({ ok: false, kind: 'refused', reason: 'bad-request' })
    expect(await calendar.eventsByUid(owner, [{ uid: 5 as never, occurrence: null }])).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await calendar.eventsByUid(owner, [{ uid: 'x'.repeat(2000), occurrence: null }])).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await calendar.eventsByUid(owner, [{ uid: 'e@google.com', occurrence: { at: 'soon' as never, date: null } }])).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await calendar.eventsByUid(owner, [])).toMatchObject({ ok: true, value: [] })
  })
})
