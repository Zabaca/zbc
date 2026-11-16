// The calendar as Claude's script reaches it (the space's ADR 0023): the space hands the inbox's part the calendar's inbox face over fresh stubs of the calendar's store, and hands it to nothing else.
// The rule in front of the writes is the inbox's (packages/inbox/test/claude-calendar.test.ts); the writes themselves are proven in packages/calendar/test/writes.test.ts. What is shown here is the wiring: the face the inbox is handed
// reaches the real engine through the namespace as the Worker's binding does, and the space's own face, the one a person's page calls, has no way to a write.
import { describe, expect, test } from 'bun:test'
import { harness, HOUR, T0 } from '@space/calendar/test-support/harness'
import { CALENDAR_FOR_INBOX_METHODS, CALENDAR_FOR_SPACE_METHODS, createInstall } from '@space/workspace'
import declaration from '../../workspace/northfield/workspace.json'
import { inboxEnvOf, type PartsEnv } from '../src/parts'

const install = createInstall(declaration)
const Z = 'tessa@northfield.example'

/** The calendar's store as the Worker's binding: a namespace whose every stub reaches the real engine's methods, over a real SQLite and a fake Google. */
async function calendarWorld() {
  const h = harness()
  h.connect(Z)
  h.google.addCalendar(Z, { id: Z, summary: 'Tessa', primary: true })
  await h.work()
  const gets: string[] = []
  const CALENDAR = {
    idFromName: (name: string) => name,
    get: (name: string) => {
      gets.push(name)
      return { call: (method: string, args: unknown[]) => (h.api.call as (m: string, ...a: unknown[]) => Promise<unknown>)(method, ...args) }
    },
  }
  return { h, gets, env: { INBOX: {} as never, CALENDAR: CALENDAR as never } as unknown as PartsEnv }
}

describe('the calendar the inbox is handed for Claude’s script', () => {
  test('is there where the Worker binds the calendar’s store, with exactly the contract’s methods, and absent where it does not', async () => {
    const { env } = await calendarWorld()
    const calendar = inboxEnvOf(env, install).calendar
    expect(Object.keys(calendar ?? {}).sort()).toEqual([...CALENDAR_FOR_INBOX_METHODS].sort())
    expect(inboxEnvOf({ INBOX: {} as never } as unknown as PartsEnv, install).calendar).toBeUndefined()
  })

  test('reaches the real engine through the namespace, a fresh stub for every call: the free time is read from the store, and an invite is made at Google with a token for changing events', async () => {
    const { h, gets, env } = await calendarWorld()
    const calendar = inboxEnvOf(env, install).calendar
    if (!calendar) throw new Error('no calendar handed')
    const events = await calendar.events(T0, T0 + 24 * HOUR)
    expect(events).toMatchObject({ ok: true, value: { accounts: [{ address: Z, canEdit: true }], events: [] } })
    const made = await calendar.invite({ account: Z, title: 'Planning', start: T0 + 24 * HOUR, end: T0 + 25 * HOUR, guests: ['dana@example.com'], description: null, meet: true })
    expect(made).toMatchObject({ ok: true, value: { account: Z, title: 'Planning', stored: true } })
    expect(h.google.writes.map((w) => [w.op, w.level, w.query.sendUpdates])).toEqual([['events.insert', 'events', 'all']])
    expect(await calendar.events(T0, T0 + 48 * HOUR)).toMatchObject({ ok: true, value: { events: [{ title: 'Planning', busy: true }] } })
    expect(gets).toEqual(['calendar', 'calendar', 'calendar'])
  })
})

describe('the space’s own face of the calendar', () => {
  test('has no method that makes, moves or cancels an event: the writes are the inbox’s face alone', () => {
    for (const name of ['invite', 'move', 'cancel', 'events']) expect(CALENDAR_FOR_SPACE_METHODS as readonly string[]).not.toContain(name)
  })
})
