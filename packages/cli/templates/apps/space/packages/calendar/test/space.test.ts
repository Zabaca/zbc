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
