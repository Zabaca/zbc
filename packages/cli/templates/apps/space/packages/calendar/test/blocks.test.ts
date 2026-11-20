import { describe, expect, test } from 'bun:test'
import { CALENDAR_BLOCK_AHEAD_MS, signedIn } from '@space/workspace'
import { BLOCKS_PACE_MS, BLOCKS_PER_RUN, blockBody, blockEventId, installKey, meetingKey } from '../src/blocks'
import { createSpaceCalendar } from '../src/space'
import { FakeGoogle } from '../test-support/fake-google'
import { type Harness, harness, HOUR, DAY, NORTHFIELD, OWNER, person, T0 } from '../test-support/harness'

/**
 * The busy blocks (the space's ADR 0024), at the engine over a real SQLite and a fake Google that answers as the documents say: a meeting on one account makes a "Busy" on the others and says nothing of itself, the blocks follow the
 * meeting, a block makes no block and is never drawn or counted, the switch and an account taken out remove them, a write whose outcome nobody knows is not doubled, and the pace and the backoff leave nothing spinning.
 */

const Z = 'tessa@northfield.example'
const F = 'tessa@ashgrove.example'
const G = 'tessa_marlow@gmail.com'
const iso = (ms: number) => new Date(ms).toISOString()
/** The moment `n` hours after the test clock's start. */
const at = (n: number) => T0 + n * HOUR

async function world(accounts: string[] = [Z, F], options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options)
  for (const a of accounts) {
    h.connect(a)
    h.google.addCalendar(a, { id: a, summary: a, primary: true })
  }
  await h.work()
  return h
}

/** Google's events changed behind the calendar's back: ask for every shown calendar to be read, and read it (the blocks follow in the same run). */
const sync = async (h: Harness) => {
  h.store.askAll()
  await h.work()
}

const turnOn = async (h: Harness) => {
  const got = await h.engine.setBlocking(true)
  if (!got.ok) throw new Error(got.error)
  await h.work()
}

/** A meeting on an account's own calendar. */
const meet = (h: Harness, account: string, id: string, from: number, to: number, extra: Record<string, unknown> = {}) =>
  h.google.setEvent(account, account, { id, summary: `Secret plan ${id}`, location: 'Room 9', description: 'Do not tell', iCalUID: `${id}@meet.test`, start: iso(from), end: iso(to), ...extra })

/** The live blocks at Google on an account's own calendar, as Google holds them. */
const blocksAt = (h: Harness, account: string) =>
  [...(h.google.account(account).calendars.get(account)?.events.values() ?? [])]
    .filter((e) => e.raw.status !== 'cancelled' && (e.raw.extendedProperties as { private?: Record<string, string> } | undefined)?.private?.spaceBlock !== undefined)
    .map((e) => e.raw)

const writes = (h: Harness, op?: string) => h.google.writes.filter((w) => op === undefined || w.op === op)
const agendaTitles = async (h: Harness) => {
  const got = await h.engine.agenda(T0 - DAY, T0 + 60 * DAY)
  if (!got.ok) throw new Error(got.error)
  return got.value.events.map((e) => e.title)
}

describe('the switch', () => {
  test('is off at first, and with it off nothing is written to Google however many meetings there are', async () => {
    const h = await world()
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    expect(writes(h)).toEqual([])
    const view = await h.engine.blocking()
    expect(view).toMatchObject({ ok: true, value: { on: false, kept: 0, problem: null } })
  })

  test('is only a setting: turning it on stores it and owes the alarm a run, and asks Google nothing by itself', async () => {
    const h = await world()
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    const before = h.alarms.length
    expect(await h.engine.setBlocking(true)).toMatchObject({ ok: true, value: { on: true } })
    expect(writes(h)).toEqual([])
    expect(h.alarms.length).toBeGreaterThan(before)
    expect(await h.engine.setBlocking('yes')).toMatchObject({ ok: false, reason: 'bad-request' })
  })
})

describe('what gets a block', () => {
  test('a meeting on one account makes one "Busy" on each other account that does not hold it, and none on its own', async () => {
    const h = await world([Z, F, G])
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    await turnOn(h)
    expect(writes(h).map((w) => [w.op, w.calendarId])).toEqual([
      ['events.insert', F],
      ['events.insert', G],
    ])
    expect(blocksAt(h, Z)).toEqual([])
    expect(blocksAt(h, F)).toHaveLength(1)
    expect(blocksAt(h, G)).toHaveLength(1)
    const block = blocksAt(h, F)[0] as Record<string, unknown>
    expect(block).toMatchObject({ summary: 'Busy', transparency: 'opaque', visibility: 'private' })
    expect(Date.parse((block.start as { dateTime: string }).dateTime)).toBe(at(24))
    expect(Date.parse((block.end as { dateTime: string }).dateTime)).toBe(at(25))
    expect(await h.engine.blocking()).toMatchObject({ ok: true, value: { on: true, kept: 2, problem: null } })
  })

  test('a block says "Busy" and nothing else: no title, guests, place, description or link of the meeting; nobody is told; no reminders; and it is marked as the calendar’s own', async () => {
    const h = await world()
    meet(h, Z, 'm1', at(24), at(25), { attendees: [{ email: Z, self: true, responseStatus: 'accepted' }, { email: 'dana@example.com', responseStatus: 'accepted' }], hangoutLink: 'https://meet.example/abc', htmlLink: 'https://www.google.com/calendar/event?eid=1' })
    await sync(h)
    await turnOn(h)
    const w = writes(h)[0]
    expect(w?.op).toBe('events.insert')
    expect(w?.query).toEqual({ sendUpdates: 'none' })
    expect(w?.level).toBe('events')
    const sent = JSON.stringify(w?.body)
    for (const leak of ['Secret plan', 'Room 9', 'Do not tell', 'dana@example.com', 'meet.example', 'm1@meet.test', 'attendees', 'location', 'description', 'conferenceData']) expect(sent).not.toContain(leak)
    expect(w?.body).toMatchObject({ summary: 'Busy', status: 'confirmed', transparency: 'opaque', visibility: 'private', reminders: { useDefault: false, overrides: [] } })
    const marks = (w?.body.extendedProperties as { private: Record<string, string> }).private
    expect(marks.spaceBlockFor).toBe(F)
    expect(marks.spaceBlock).toBe(await meetingKey('m1@meet.test', at(24)))
    // The install is named by a key hashed from its declared company id, never by the id itself.
    const install = await installKey(NORTHFIELD.company.id)
    expect(marks.spaceBlockBy).toBe(install)
    expect(sent).not.toContain(NORTHFIELD.company.id)
    // The id is derived from the install, the meeting and the account: the letters Google allows, five to 1024 of them.
    expect(w?.body.id).toBe(await blockEventId(install, marks.spaceBlock as string, F))
    expect(String(w?.body.id)).toMatch(/^[0-9a-v]{5,1024}$/)
  })

  test('a meeting both accounts already hold (the same iCalendar id and start) makes no block on either', async () => {
    const h = await world()
    meet(h, Z, 'a1', at(24), at(25), { iCalUID: 'board@meet.test' })
    meet(h, F, 'b1', at(24), at(25), { iCalUID: 'board@meet.test' })
    await sync(h)
    await turnOn(h)
    expect(writes(h)).toEqual([])
  })

  test('a copy the other account has DECLINED does not hold the meeting: the owner is busy by the first, so the second is blocked', async () => {
    const h = await world()
    meet(h, Z, 'a1', at(24), at(25), { iCalUID: 'board@meet.test', attendees: [{ email: Z, self: true, responseStatus: 'accepted' }] })
    meet(h, F, 'b1', at(24), at(25), { iCalUID: 'board@meet.test', attendees: [{ email: F, self: true, responseStatus: 'declined' }] })
    await sync(h)
    await turnOn(h)
    expect(writes(h).map((w) => [w.op, w.calendarId])).toEqual([['events.insert', F]])
  })

  test('not an all-day event, not free time, not a declined invitation; a tentative event and an unanswered one make the owner busy and are blocked', async () => {
    const h = await world()
    h.google.setEvent(Z, Z, { id: 'day', summary: 'Offsite', startDate: '2026-11-10', endDate: '2026-11-11' })
    meet(h, Z, 'free', at(24), at(25), { transparency: 'transparent' })
    meet(h, Z, 'no', at(26), at(27), { attendees: [{ email: Z, self: true, responseStatus: 'declined' }] })
    meet(h, Z, 'maybe', at(28), at(29), { status: 'tentative', attendees: [{ email: Z, self: true, responseStatus: 'tentative' }] })
    meet(h, Z, 'unanswered', at(30), at(31), { attendees: [{ email: Z, self: true, responseStatus: 'needsAction' }, { email: 'dana@example.com', responseStatus: 'accepted' }] })
    await sync(h)
    await turnOn(h)
    expect(writes(h)).toHaveLength(2)
    expect(blocksAt(h, F).map((b) => Date.parse((b.start as { dateTime: string }).dateTime)).sort()).toEqual([at(28), at(30)])
  })

  test('only a meeting that ends in the future and starts within 60 days; one further out is blocked when it comes inside the window', async () => {
    const h = await world()
    meet(h, Z, 'over', at(-3), at(-2))
    meet(h, Z, 'now', at(-1), at(1))
    meet(h, Z, 'far', at(24 * 70), at(24 * 70 + 1))
    await sync(h)
    await turnOn(h)
    expect(blocksAt(h, F)).toHaveLength(1)
    expect(Date.parse(((blocksAt(h, F)[0] as Record<string, unknown>).start as { dateTime: string }).dateTime)).toBe(at(-1))
    // Eleven days on, the far meeting is inside the window (the full read that keeps the window rolling brings it in).
    h.advance(11 * DAY)
    await sync(h)
    expect(blocksAt(h, F).map((b) => Date.parse((b.start as { dateTime: string }).dateTime))).toContain(at(24 * 70))
    expect(CALENDAR_BLOCK_AHEAD_MS).toBe(60 * DAY)
  })

  test('each occurrence of a repeating meeting is blocked on its own', async () => {
    const h = await world()
    for (const n of [0, 1, 2]) meet(h, Z, `standup_${n}`, at(24 * (n + 1)), at(24 * (n + 1) + 1), { iCalUID: 'standup@meet.test' })
    await sync(h)
    await turnOn(h)
    expect(blocksAt(h, F)).toHaveLength(3)
    expect(new Set(blocksAt(h, F).map((b) => b.id)).size).toBe(3)
  })
})

describe('blocks follow the meeting', () => {
  async function blocked() {
    const h = await world()
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    await turnOn(h)
    expect(blocksAt(h, F)).toHaveLength(1)
    h.google.writes.length = 0
    return h
  }

  test('a meeting that moves moves its block: made at the new time, the old one removed, nobody told', async () => {
    const h = await blocked()
    meet(h, Z, 'm1', at(48), at(49))
    await sync(h)
    expect(writes(h).map((w) => w.op)).toEqual(['events.insert', 'events.delete'])
    expect(writes(h).every((w) => w.query.sendUpdates === 'none')).toBe(true)
    expect(blocksAt(h, F)).toHaveLength(1)
    expect(Date.parse(((blocksAt(h, F)[0] as Record<string, unknown>).start as { dateTime: string }).dateTime)).toBe(at(48))
  })

  test('a meeting that only gets longer or shorter changes its block’s end', async () => {
    const h = await blocked()
    meet(h, Z, 'm1', at(24), at(26))
    await sync(h)
    expect(writes(h).map((w) => w.op)).toEqual(['events.patch'])
    expect(writes(h)[0]?.query).toEqual({ sendUpdates: 'none' })
    expect(Date.parse(((blocksAt(h, F)[0] as Record<string, unknown>).end as { dateTime: string }).dateTime)).toBe(at(26))
  })

  test('a cancelled meeting, a declined one and one marked as free time each remove their block', async () => {
    for (const change of [
      (h: Harness) => h.google.cancelEvent(Z, Z, 'm1'),
      (h: Harness) => meet(h, Z, 'm1', at(24), at(25), { attendees: [{ email: Z, self: true, responseStatus: 'declined' }] }),
      (h: Harness) => meet(h, Z, 'm1', at(24), at(25), { transparency: 'transparent' }),
    ]) {
      const h = await blocked()
      change(h)
      await sync(h)
      expect(writes(h).map((w) => [w.op, w.query.sendUpdates])).toEqual([['events.delete', 'none']])
      expect(blocksAt(h, F)).toEqual([])
      expect(await h.engine.blocking()).toMatchObject({ ok: true, value: { kept: 0 } })
    }
  })

  test('a meeting whose calendar is hidden stops counting: its block is removed', async () => {
    const h = await world()
    h.google.addCalendar(Z, { id: 'team', summary: 'Team', accessRole: 'owner' })
    await h.work()
    h.google.setEvent(Z, 'team', { id: 't1', summary: 'Team sync', iCalUID: 't1@meet.test', start: iso(at(24)), end: iso(at(25)) })
    await sync(h)
    await turnOn(h)
    expect(blocksAt(h, F)).toHaveLength(1)
    await h.engine.setShown(`${Z}|team`, false)
    await h.work()
    expect(blocksAt(h, F)).toEqual([])
  })

  test('a meeting the other account is invited to as well later is no longer blocked there', async () => {
    const h = await blocked()
    meet(h, F, 'b1', at(24), at(25), { iCalUID: 'm1@meet.test' })
    await sync(h)
    expect(writes(h).map((w) => w.op)).toEqual(['events.delete'])
    expect(blocksAt(h, F)).toEqual([])
  })

  test('a block that was removed is made again when its meeting returns: Google refuses the same id (409) and the same body confirms it', async () => {
    const h = await blocked()
    meet(h, Z, 'm1', at(24), at(25), { attendees: [{ email: Z, self: true, responseStatus: 'declined' }] })
    await sync(h)
    expect(blocksAt(h, F)).toEqual([])
    h.google.writes.length = 0
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    expect(writes(h).map((w) => w.op)).toEqual(['events.insert', 'events.patch'])
    expect(blocksAt(h, F)).toHaveLength(1)
    expect(await h.engine.blocking()).toMatchObject({ ok: true, value: { kept: 1, problem: null } })
  })

  test('once every block is made, a read that finds them changes nothing: no second write, and the work is done', async () => {
    const h = await blocked()
    await sync(h)
    await sync(h)
    expect(writes(h)).toEqual([])
    expect(blocksAt(h, F)).toHaveLength(1)
  })
})

describe('a block is the calendar’s own and nothing else’s', () => {
  test('it makes no block, is never drawn in the agenda, never counted busy for Claude, never found by an email’s card and never a thing Claude can move or cancel', async () => {
    const h = await world([Z, F, G])
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    await turnOn(h)
    await sync(h)
    await sync(h)
    // Three accounts, one meeting: two blocks, and the blocks read back from Google made no blocks of their own.
    expect(writes(h, 'events.insert')).toHaveLength(2)
    expect(h.store.blocksHeld()).toHaveLength(2)
    expect(await agendaTitles(h)).toEqual(['Secret plan m1'])
    const claude = await h.engine.claudeEvents(T0, T0 + 3 * DAY)
    expect(claude.ok && claude.value.events.map((e) => [e.title, e.busy])).toEqual([['Secret plan m1', true]])
    const block = h.store.blocksHeld()[0]
    const key = `${block?.calendarId}|${block?.eventId}`
    expect(h.engine.event(key)).toMatchObject({ ok: false, reason: 'not-found' })
    expect(h.store.held(key)).toBeNull()
    expect(h.engine.eventsByUid([{ uid: `${block?.eventId}@google.com`, occurrence: null }])).toMatchObject({ ok: true, value: [null] })
    expect(await h.engine.claudeMove(key, { start: at(30), end: at(31) })).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await h.engine.claudeCancel(key)).toMatchObject({ ok: false, reason: 'not-found' })
  })

  test('a mark that is not the calendar’s shape is no mark: a block someone typed by hand is an ordinary event', async () => {
    const h = await world()
    h.google.setEvent(F, F, { id: 'hand', summary: 'Busy', start: iso(at(3)), end: iso(at(4)) })
    await sync(h)
    expect(await agendaTitles(h)).toEqual(['Busy'])
    expect(h.store.blocksHeld()).toEqual([])
  })
})

describe('the owner’s settings', () => {
  test('switching off removes every block, a past one included, and nothing is made again', async () => {
    const h = await world()
    meet(h, Z, 'm1', at(24), at(25))
    meet(h, Z, 'm2', at(48), at(49))
    meet(h, Z, 'old', at(2), at(3))
    await sync(h)
    await turnOn(h)
    expect(blocksAt(h, F)).toHaveLength(3)
    // The past one stays while the switch is on (it stands for nothing but is history); the switch off takes it too.
    h.advance(5 * HOUR)
    await sync(h)
    expect(blocksAt(h, F)).toHaveLength(3)
    expect(await h.engine.setBlocking(false)).toMatchObject({ ok: true, value: { on: false } })
    await h.work()
    expect(blocksAt(h, F)).toEqual([])
    expect(writes(h, 'events.delete').every((w) => w.query.sendUpdates === 'none')).toBe(true)
    h.google.writes.length = 0
    await sync(h)
    expect(writes(h)).toEqual([])
  })

  test('an account taken out stops giving its busy times and stops receiving blocks, and is brought back by ticking it again', async () => {
    const h = await world([Z, F, G])
    meet(h, Z, 'mz', at(24), at(25))
    meet(h, F, 'mf', at(26), at(27))
    await sync(h)
    await turnOn(h)
    expect([blocksAt(h, Z).length, blocksAt(h, F).length, blocksAt(h, G).length]).toEqual([1, 1, 2])
    expect(await h.engine.setBlockingAccount(F, false)).toMatchObject({ ok: true, value: { accounts: [{ address: Z, takesPart: true }, { address: F, takesPart: false }, { address: G, takesPart: true }] } })
    await h.work()
    // F's blocks are gone, F's meeting blocks nothing, and Z's meeting is not blocked on F.
    expect([blocksAt(h, Z).length, blocksAt(h, F).length, blocksAt(h, G).length]).toEqual([0, 0, 1])
    expect(await h.engine.setBlockingAccount(F, true)).toMatchObject({ ok: true })
    await h.work()
    expect([blocksAt(h, Z).length, blocksAt(h, F).length, blocksAt(h, G).length]).toEqual([1, 1, 2])
    expect(await h.engine.setBlockingAccount('nobody@x.example', true)).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await h.engine.setBlockingAccount(F, 'yes')).toMatchObject({ ok: false, reason: 'bad-request' })
  })

  test('the setting is the space’s face’s, the owner’s alone', async () => {
    const h = await world()
    const owner = signedIn(person(NORTHFIELD, OWNER), Math.floor(T0 / 1000) + 3600)
    const calendar = createSpaceCalendar({ engine: h.api, install: NORTHFIELD })
    expect(await calendar.setBlocking(owner, true)).toMatchObject({ ok: true, value: { on: true } })
    expect(await calendar.setBlockingAccount(owner, F, false)).toMatchObject({ ok: true })
    expect(await calendar.blocking(owner)).toMatchObject({ ok: true, value: { on: true, accounts: [{ address: Z, takesPart: true }, { address: F, takesPart: false }] } })
  })
})

describe('an account that cannot hold a block', () => {
  test('one whose grant reads and cannot change events is skipped, and says so with Connect calendar; the others are blocked as usual', async () => {
    const h = await world([Z, F, G])
    h.grants.find((g) => g.address === F)!.events = false
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    await turnOn(h)
    expect(blocksAt(h, F)).toEqual([])
    expect(blocksAt(h, G)).toHaveLength(1)
    const view = await h.engine.blocking()
    expect(view.ok && view.value.accounts.find((a) => a.address === F)).toMatchObject({ takesPart: true, fix: 'connect-calendar' })
    expect(view.ok && view.value.accounts.find((a) => a.address === F)?.skipped).toContain('Connect calendar')
    expect(view.ok && view.value.accounts.find((a) => a.address === G)).toMatchObject({ skipped: null, fix: null })
    expect(view.ok && view.value.problem).toBeNull()
  })

  test('one whose sign-in ended is skipped (Connect again), keeps its last picture as a giver of busy times, and nothing is asked of Google for it', async () => {
    const h = await world([Z, F, G])
    meet(h, F, 'mf', at(24), at(25))
    await sync(h)
    await turnOn(h)
    expect(blocksAt(h, G)).toHaveLength(1)
    h.grants.find((g) => g.address === F)!.lapsed = true
    h.advance(31_000)
    await sync(h)
    const view = await h.engine.blocking()
    expect(view.ok && view.value.accounts.find((a) => a.address === F)).toMatchObject({ fix: 'connect-again' })
    // G still holds the block for F's last-read meeting; and no write went to F.
    expect(blocksAt(h, G)).toHaveLength(1)
    expect(writes(h).some((w) => w.calendarId === F && w.op !== 'events.insert')).toBe(false)
  })

  test('one whose main calendar is hidden is skipped with a sentence and no button', async () => {
    const h = await world()
    await h.engine.setShown(`${F}|${F}`, false)
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    await turnOn(h)
    const view = await h.engine.blocking()
    expect(view.ok && view.value.accounts.find((a) => a.address === F)).toMatchObject({ fix: null })
    expect(view.ok && view.value.accounts.find((a) => a.address === F)?.skipped).toContain('hidden')
    expect(writes(h)).toEqual([])
  })

  test('an install with no writing client says that the blocks are not kept, and asks Google nothing', async () => {
    const h = await world([Z, F], { writer: false })
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    await turnOn(h)
    expect(writes(h)).toEqual([])
    const view = await h.engine.blocking()
    expect(view.ok && view.value.problem).toContain('cannot change calendar events')
  })
})

describe('a write whose outcome is not known', () => {
  test('is not doubled: Google made the block and did not answer, and the next run finds it again by its id (409, then the same body confirms it)', async () => {
    const h = await world()
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    await h.engine.setBlocking(true)
    // Google makes the event and the answer never arrives.
    h.google.afterRequest = async (op) => {
      if (op === 'events.insert') throw new Error('the connection was lost')
    }
    await h.work()
    h.google.afterRequest = null
    expect(blocksAt(h, F)).toHaveLength(1)
    const view = await h.engine.blocking()
    expect(view.ok && view.value.problem).toContain('tried again')
    // The store does not hold it, so the plan makes it again once the backoff is over, with the same id.
    expect(h.store.blocksHeld()).toEqual([])
    h.advance(31_000)
    await h.work()
    expect(writes(h).map((w) => w.op)).toEqual(['events.insert', 'events.insert', 'events.patch'])
    expect(new Set(writes(h, 'events.insert').map((w) => w.body.id)).size).toBe(1)
    expect(blocksAt(h, F)).toHaveLength(1)
    expect([...(h.google.account(F).calendars.get(F)?.events.values() ?? [])]).toHaveLength(1)
    expect(await h.engine.blocking()).toMatchObject({ ok: true, value: { problem: null, kept: 1 } })
  })
})

describe('pace and failure', () => {
  test('at most BLOCKS_PER_RUN writes a run, the rest owed a few seconds on; each run ends, and nothing spins', async () => {
    const h = await world()
    for (let n = 0; n < BLOCKS_PER_RUN + 5; n++) meet(h, Z, `m${n}`, at(24 + n), at(24.5 + n))
    await sync(h)
    await h.engine.setBlocking(true)
    h.alarms.length = 0
    await h.work()
    expect(writes(h)).toHaveLength(BLOCKS_PER_RUN)
    // The next alarm is the pace and never sooner than a second.
    expect(Math.max(...h.alarms)).toBeLessThanOrEqual(h.clock.t + BLOCKS_PACE_MS + 1)
    expect(h.alarms.at(-1)).toBeGreaterThanOrEqual(h.clock.t + 1000)
    h.advance(BLOCKS_PACE_MS)
    await h.work()
    expect(writes(h)).toHaveLength(BLOCKS_PER_RUN + 5)
    expect(blocksAt(h, F)).toHaveLength(BLOCKS_PER_RUN + 5)
    h.alarms.length = 0
    h.advance(BLOCKS_PACE_MS)
    await h.work()
    expect(writes(h)).toHaveLength(BLOCKS_PER_RUN + 5)
    // Nothing is owed: the next wake is the sync's own (hours away), not the blocks'.
    expect(h.alarms.at(-1)).toBeGreaterThan(h.clock.t + 60_000)
  })

  test('a failure is a sentence and a backoff that doubles; nothing is tried before its time; the owner’s own change is tried at once; success takes the sentence down', async () => {
    const h = await world()
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    await h.engine.setBlocking(true)
    h.google.failNext('events.insert', 500, { error: { code: 500, message: 'Backend Error' } }, 2)
    await h.work()
    const first = await h.engine.blocking()
    expect(first.ok && first.value.problem).toContain('tried again')
    expect(h.google.count('events.insert')).toBe(1)
    // Before the backoff ends the run asks nothing.
    h.advance(10_000)
    await h.work()
    expect(h.google.count('events.insert')).toBe(1)
    expect(h.store.blocking().failures).toBe(1)
    h.advance(21_000)
    await h.work()
    expect(h.google.count('events.insert')).toBe(2)
    expect(h.store.blocking()).toMatchObject({ failures: 2, retryAt: h.clock.t + 60_000 })
    // The owner turns an account out and in: the sentence and the backoff are cleared and it is tried at once.
    await h.engine.setBlockingAccount(F, false)
    await h.engine.setBlockingAccount(F, true)
    await h.work()
    expect(blocksAt(h, F)).toHaveLength(1)
    expect(await h.engine.blocking()).toMatchObject({ ok: true, value: { problem: null } })
    expect(h.store.blocking()).toMatchObject({ failures: 0, retryAt: null })
  })

  test('a decision about one write (a 400) is kept as the sentence and the other writes go on', async () => {
    const h = await world()
    meet(h, Z, 'm1', at(24), at(25))
    meet(h, Z, 'm2', at(26), at(27))
    await sync(h)
    await h.engine.setBlocking(true)
    h.google.failNext('events.insert', 400, { error: { code: 400, message: 'Invalid value' } }, 1)
    await h.work()
    expect(h.google.count('events.insert')).toBe(2)
    expect(blocksAt(h, F)).toHaveLength(1)
    const view = await h.engine.blocking()
    expect(view.ok && view.value.problem).toContain('Invalid value')
  })

  test('the permission to change events is refused at Google: the account is skipped for the run and the sentence says to press Connect calendar', async () => {
    const h = await world([Z, F, G])
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    await h.engine.setBlocking(true)
    h.google.account(F).eventsRefusal = { why: 'no-events', message: 'tessa@ashgrove.example is connected without the permission to change events. Press Connect calendar in Settings, Calendars and accept it.' }
    await h.work()
    const view = await h.engine.blocking()
    expect(view.ok && view.value.problem).toContain('Connect calendar')
    expect(blocksAt(h, G)).toHaveLength(1)
    expect(blocksAt(h, F)).toEqual([])
  })

  test('a block is not removed for want of a meeting that has not been read in yet: with an account’s calendar unread, nothing is taken down until it is, and the block then stands', async () => {
    const h = await world()
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    await turnOn(h)
    expect(blocksAt(h, F)).toHaveLength(1)
    h.google.writes.length = 0
    // Z's copy of the store is gone (a store made new) and Z cannot be read just now: F's block, read back, looks like it stands for nothing.
    h.db.run(`DELETE FROM event WHERE calendar_id = '${Z}|${Z}'`)
    h.store.forgetToken(`${Z}|${Z}`)
    h.google.failNext('events.list', 500, { error: { code: 500, message: 'Backend Error' } }, 1, Z)
    await sync(h)
    expect(h.store.calendar(`${Z}|${Z}`)?.syncToken).toBeNull()
    expect(writes(h)).toEqual([])
    expect(blocksAt(h, F)).toHaveLength(1)
    // Read again, the meeting is there and its block stands: nothing was removed and nothing is made twice.
    h.advance(61_000)
    await sync(h)
    expect(writes(h)).toEqual([])
    expect(blocksAt(h, F)).toHaveLength(1)
  })

  test('and once every account is read, a block whose meeting is gone is removed', async () => {
    const h = await world()
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    await turnOn(h)
    h.google.writes.length = 0
    h.google.cancelEvent(Z, Z, 'm1')
    await sync(h)
    expect(writes(h).map((w) => w.op)).toEqual(['events.delete'])
  })
})

describe('the token for changing events', () => {
  test('a run asks the inbox for one token for each account it writes to, at the events level, and none for the sync’s own reads; the next run asks again', async () => {
    const h = await world([Z, F])
    for (const n of [1, 2, 3]) meet(h, Z, `m${n}`, at(24 * n), at(24 * n + 1))
    await sync(h)
    const reads = h.google.accessAsked.filter((a) => a.level === 'read').length
    await turnOn(h)
    expect(writes(h)).toHaveLength(3)
    expect(h.google.accessAsked.filter((a) => a.level === 'events')).toEqual([{ address: F, fresh: false, level: 'events' }])
    expect(h.google.accessAsked.filter((a) => a.level === 'read').length).toBeGreaterThanOrEqual(reads)
    // Every write carried a token for `calendar.events`, and it is not kept: the next run asks again.
    expect(writes(h).every((w) => w.level === 'events')).toBe(true)
    meet(h, Z, 'm4', at(24 * 5), at(24 * 5 + 1))
    await sync(h)
    expect(h.google.accessAsked.filter((a) => a.level === 'events')).toHaveLength(2)
  })

  test('no token is in what the page is shown or in a log line', async () => {
    const h = await world()
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    await turnOn(h)
    h.google.failNext('events.insert', 400, { error: { code: 400, message: 'Invalid value' } }, 1)
    meet(h, Z, 'm2', at(26), at(27))
    await sync(h)
    const view = JSON.stringify(await h.engine.blocking())
    expect(view).not.toMatch(/tok-/)
    expect(h.logs.join('\n')).not.toMatch(/tok-/)
  })
})

describe('what a block is made of', () => {
  test('the body is exactly the calendar’s: Busy, private, opaque, no reminders, the mark; and the id is stable for a meeting and an account', async () => {
    const body = blockBody('abcde', 'i'.repeat(16), 'k'.repeat(16), F, at(1), at(2), 'America/Los_Angeles')
    expect(Object.keys(body).sort()).toEqual(['end', 'extendedProperties', 'id', 'reminders', 'start', 'status', 'summary', 'transparency', 'visibility'])
    const a = await blockEventId('i'.repeat(16), 'm'.repeat(16), F)
    expect(a).toBe(await blockEventId('i'.repeat(16), 'm'.repeat(16), F))
    expect(a).not.toBe(await blockEventId('i'.repeat(16), 'm'.repeat(16), Z))
    expect(a).not.toBe(await blockEventId('i'.repeat(16), 'n'.repeat(16), F))
    expect(a).not.toBe(await blockEventId('j'.repeat(16), 'm'.repeat(16), F))
    expect(a).toMatch(/^[0-9a-v]{32}$/)
    expect(await meetingKey('x@y', 1)).not.toBe(await meetingKey('x@y', 2))
    expect(await meetingKey('x@y', 1)).toMatch(/^[0-9a-v]{16}$/)
  })
})

describe('a Google that does not give the mark back', () => {
  async function unmarked() {
    const h = await world([Z, F, G])
    h.google.dropPrivateProperties = true
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    await turnOn(h)
    return h
  }

  test('a block is not read back as a meeting: no block of a block, no write at any later read (a full read included), and the meeting is still the only thing drawn', async () => {
    const h = await unmarked()
    expect(writes(h).map((w) => [w.op, w.calendarId])).toEqual([['events.insert', F], ['events.insert', G]])
    for (let n = 0; n < 3; n++) await sync(h)
    // A read in full replaces every row: the store keeps what it knew of each.
    h.store.forgetToken(`${F}|${F}`)
    h.store.forgetToken(`${G}|${G}`)
    await sync(h)
    expect(writes(h)).toHaveLength(2)
    expect(h.store.blocksHeld()).toHaveLength(2)
    expect(await agendaTitles(h)).toEqual(['Secret plan m1'])
    expect(await h.engine.blocking()).toMatchObject({ ok: true, value: { kept: 2 } })
  })

  test('a block whose meeting is gone is still a block, by the mark the store kept: it is removed, and not read as a meeting', async () => {
    const h = await unmarked()
    h.google.writes.length = 0
    h.google.cancelEvent(Z, Z, 'm1')
    await sync(h)
    expect(writes(h).map((w) => [w.op, w.calendarId]).sort()).toEqual([['events.delete', F], ['events.delete', G]])
    expect(h.store.blocksHeld()).toEqual([])
  })

  test('a block the store has lost the mark of is known again by its id, and switching off removes it all the same', async () => {
    const h = await unmarked()
    h.db.run('UPDATE event SET block = NULL, block_by = NULL')
    expect(h.store.blocksHeld()).toEqual([])
    h.google.writes.length = 0
    await sync(h)
    // Worked out again from the meeting the id was derived for: marked, not blocked in turn, nothing written.
    expect(h.store.blocksHeld()).toHaveLength(2)
    expect(writes(h)).toEqual([])
    expect(await agendaTitles(h)).toEqual(['Secret plan m1'])
    await h.engine.setBlocking(false)
    await h.work()
    expect(writes(h, 'events.delete').map((w) => w.calendarId).sort()).toEqual([F, G])
    expect(h.store.blocksHeld()).toEqual([])
    const events = (a: string) => [...(h.google.account(a).calendars.get(a)?.events.values() ?? [])].filter((e) => e.raw.status !== 'cancelled')
    expect([events(F).length, events(G).length]).toEqual([0, 0])
  })
})

describe('two spaces on one Google account', () => {
  async function two() {
    const google = new FakeGoogle({ t: T0 })
    const a = harness({ google, installId: 'northfield' })
    const b = harness({ google, installId: 'ashgrove-space' })
    for (const h of [a, b]) {
      for (const acct of [Z, F]) h.grants.push({ address: acct, label: acct.split('@')[0] as string, connected: true, lapsed: false, calendar: true, events: true })
    }
    for (const acct of [Z, F]) {
      google.account(acct)
      google.addCalendar(acct, { id: acct, summary: acct, primary: true })
    }
    await a.work()
    await b.work()
    return { google, a, b }
  }

  test('each makes and removes its own block and never touches the other’s; a block of the other is hidden, never a meeting, never counted', async () => {
    const { google, a, b } = await two()
    meet(a, Z, 'm1', at(24), at(25))
    await sync(a)
    await sync(b)
    await turnOn(a)
    expect(blocksAt(a, F)).toHaveLength(1)
    await sync(b)
    // The other space reads it: not a meeting, not drawn, not counted, and nothing is written for it.
    await turnOn(b)
    await sync(b)
    expect(await agendaTitles(b)).toEqual(['Secret plan m1'])
    expect(b.store.blocksHeld()).toHaveLength(1)
    expect(await b.engine.blocking()).toMatchObject({ ok: true, value: { kept: 0 } })
    expect(await a.engine.blocking()).toMatchObject({ ok: true, value: { kept: 1 } })
    // The meeting is blocked on F once, by the space that was first, and neither removes the other's.
    for (let n = 0; n < 3; n++) {
      await sync(a)
      await sync(b)
    }
    expect(blocksAt(a, F)).toHaveLength(1)
    expect(google.writes.filter((w) => w.op !== 'events.insert')).toEqual([])
    expect(google.writes).toHaveLength(1)
    // The first space switches off: its block goes, and the other space, which only waited, makes its own.
    await a.engine.setBlocking(false)
    await a.work()
    expect(blocksAt(a, F)).toEqual([])
    await sync(b)
    expect(blocksAt(b, F)).toHaveLength(1)
    expect(await b.engine.blocking()).toMatchObject({ ok: true, value: { kept: 1 } })
    expect(google.writes.filter((w) => w.op === 'events.delete')).toHaveLength(1)
  })
})

describe('what the owner is told', () => {
  test('while no block is taken down because a calendar has not been read, the sentence says which', async () => {
    const h = await world()
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    await turnOn(h)
    expect(await h.engine.blocking()).toMatchObject({ ok: true, value: { problem: null } })
    h.google.cancelEvent(Z, Z, 'm1')
    h.db.run(`DELETE FROM event WHERE calendar_id = '${Z}|${Z}'`)
    h.store.forgetToken(`${Z}|${Z}`)
    h.google.failNext('events.list', 500, { error: { code: 500, message: 'Backend Error' } }, 5, Z)
    await sync(h)
    const view = await h.engine.blocking()
    expect(view.ok && view.value.problem).toContain('No block is taken down for now')
    expect(view.ok && view.value.problem).toContain(Z)
    expect(blocksAt(h, F)).toHaveLength(1)
    // Switched off, nothing is held back and nothing is said of it.
    await h.engine.setBlocking(false)
    const off = await h.engine.blocking()
    expect(off.ok && off.value.problem).toBeNull()
  })

  test('an account that cannot be written to keeps its blocks when the switch goes off, and says so beside its tick', async () => {
    const h = await world([Z, F, G])
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    await turnOn(h)
    h.grants.find((g) => g.address === F)!.lapsed = true
    h.advance(31_000)
    await sync(h)
    await h.engine.setBlocking(false)
    await h.work()
    expect(blocksAt(h, G)).toEqual([])
    expect(blocksAt(h, F)).toHaveLength(1)
    const view = await h.engine.blocking()
    const card = view.ok ? view.value.accounts.find((a) => a.address === F) : undefined
    expect(card?.skipped).toContain('1 Busy block stays on it until it can be written to')
    expect(card?.fix).toBe('connect-again')
    expect(view.ok && view.value.accounts.find((a) => a.address === G)?.skipped).toBeNull()
    // Ticked out the same way.
    await h.engine.setBlocking(true)
    await h.engine.setBlockingAccount(F, false)
    const out = await h.engine.blocking()
    expect(out.ok && out.value.accounts.find((a) => a.address === F)?.skipped).toContain('stays on it')
  })
})

describe('a step Google keeps refusing', () => {
  test('is tried last from then on, so one that cannot be done does not fill every batch: the rest of the work is done at the next run', async () => {
    const h = await world()
    const n = BLOCKS_PER_RUN + 2
    for (let i = 0; i < n; i++) meet(h, Z, `m${i}`, at(24 + i), at(24.5 + i))
    await sync(h)
    await turnOn(h)
    await h.work()
    expect(blocksAt(h, F)).toHaveLength(n)
    // Off, then on: every block was removed at Google, so making one again is a 409 and then a change that says confirmed, which Google refuses here (404) for every one of them.
    await h.engine.setBlocking(false)
    await h.work()
    await h.work()
    expect(blocksAt(h, F)).toEqual([])
    h.google.failNext('events.patch', 404, { error: { code: 404, message: 'Not Found' } }, 1000)
    meet(h, Z, 'late', at(24 + n + 5), at(25 + n + 5))
    await sync(h)
    await h.engine.setBlocking(true)
    await h.work()
    expect(await h.engine.blocking()).toMatchObject({ ok: true, value: { problem: expect.stringContaining('Could not keep every Busy block') } })
    // Next run, the ones Google refused go last: the meeting that was never tried (the last of 23, which the first batch of 20 did not reach) gets its block at once.
    h.advance(31_000)
    await h.work()
    expect(blocksAt(h, F)).toHaveLength(1)
    expect(blocksAt(h, F).some((b) => Date.parse((b.start as { dateTime: string }).dateTime) === at(24 + n + 5))).toBe(true)
  })
})

describe('an invitation made with a guessed id is an ordinary event', () => {
  const forgedId = async (account: string) => blockEventId(await installKey(NORTHFIELD.company.id), await meetingKey('m1@meet.test', at(24)), account)

  test('it keeps its id and stays drawn and busy: it is not hidden, not made over, and never removed by the writer, even when its meeting is cancelled and the switch goes off', async () => {
    const h = await world([Z, F, G])
    h.google.setEvent(F, F, {
      id: await forgedId(F),
      summary: 'Dinner with a stranger',
      start: iso(at(24)),
      end: iso(at(25)),
      organizer: { email: 'stranger@example.com' },
      attendees: [{ email: 'stranger@example.com', organizer: true, responseStatus: 'accepted' }, { email: F, self: true, responseStatus: 'needsAction' }],
    })
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    await turnOn(h)
    await sync(h)
    // The invitation is a meeting like any other (blocked on the other accounts); on F, where it holds the id, nothing is made over it, and it is not a block.
    expect(writes(h).filter((w) => w.calendarId === F)).toEqual([])
    expect(h.store.blocksHeld().every((b) => b.account !== F)).toBe(true)
    expect(await agendaTitles(h)).toContain('Dinner with a stranger')
    const claude = await h.engine.claudeEvents(T0, T0 + 3 * DAY)
    expect(claude.ok && claude.value.events.find((e) => e.title === 'Dinner with a stranger')?.busy).toBe(true)
    h.google.cancelEvent(Z, Z, 'm1')
    await sync(h)
    await h.engine.setBlocking(false)
    await h.work()
    expect(writes(h).filter((w) => w.calendarId === F)).toEqual([])
    expect(await agendaTitles(h)).toEqual(['Dinner with a stranger'])
    expect(h.store.blocksHeld()).toEqual([])
    expect([...(h.google.account(F).calendars.get(F)?.events.values() ?? [])].filter((e) => e.raw.status !== 'cancelled')).toHaveLength(1)
  })

  test('one that looks like a block but sits on another account than the id was derived for is an ordinary event too', async () => {
    const h = await world([Z, F, G])
    h.google.setEvent(G, G, { id: await forgedId(F), summary: 'Busy', start: iso(at(24)), end: iso(at(25)) })
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    await turnOn(h)
    const id = await forgedId(F)
    expect(await agendaTitles(h)).toContain('Busy')
    expect(h.store.blocksHeld().some((b) => b.eventId === id)).toBe(false)
    await h.engine.setBlocking(false)
    await h.work()
    expect(writes(h).filter((w) => w.eventId === id)).toEqual([])
  })

  test('a block the owner has made their own (retitled) is an ordinary event again: drawn, busy for Claude, a source of blocks, and not the writer’s to change or remove, nor its id to make over', async () => {
    const h = await world()
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    await turnOn(h)
    expect(blocksAt(h, F)).toHaveLength(1)
    const held = h.store.blocksHeld()[0]
    const id = held?.eventId as string
    // The owner renames it in Google Calendar (the private properties are gone with the edit in this fake, as they may be).
    h.google.setEvent(F, F, { id, summary: 'Dentist', start: iso(at(24)), end: iso(at(25)) })
    h.google.writes.length = 0
    h.google.cancelEvent(Z, Z, 'm1')
    await sync(h)
    // What is shown and counted: it is on the agenda, busy in the free time Claude reads, and no longer a block.
    expect(await agendaTitles(h)).toEqual(['Dentist'])
    const claude = await h.engine.claudeEvents(T0, T0 + 3 * DAY)
    expect(claude.ok && claude.value.events.map((e) => [e.title, e.busy])).toEqual([['Dentist', true]])
    expect(h.store.blocksHeld().some((b) => b.eventId === id)).toBe(false)
    // It is a meeting like any other: blocked on the other account.
    expect(blocksAt(h, Z)).toHaveLength(1)
    await h.engine.setBlocking(false)
    await h.work()
    expect(writes(h).filter((w) => w.eventId === id)).toEqual([])
    expect(await agendaTitles(h)).toEqual(['Dentist'])
  })
})

describe('limits of the store and a run that throws', () => {
  test('more than 100 candidates are asked in chunks: no query binds more than a Durable Object’s SQLite allows', async () => {
    const h = await world()
    const original = h.sql.exec
    let widest = 0
    h.sql.exec = ((query: string, ...bindings: unknown[]) => {
      widest = Math.max(widest, bindings.length)
      if (bindings.length > 100) throw new Error('too many SQL variables')
      return original(query, ...bindings)
    }) as typeof h.sql.exec
    // 130 events whose ids have the shape of a block's, each starting at a moment of its own: 130 starts to look up.
    for (let n = 0; n < 130; n++) h.google.setEvent(F, F, { id: `a${String(n).padStart(3, '0')}`.padEnd(32, 'v'), summary: `Thing ${n}`, start: iso(at(24 + n)), end: iso(at(24.5 + n)) })
    await sync(h)
    await turnOn(h)
    expect(widest).toBeGreaterThan(0)
    expect(await h.engine.blocking()).toMatchObject({ ok: true, value: { problem: null } })
    // Each is a meeting like any other, blocked on the other account.
    expect(blocksAt(h, Z).length).toBeGreaterThan(0)
  })

  test('a run that throws is said in Settings’ sentence, backed off, and taken down when the next run works', async () => {
    const h = await world()
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    await h.engine.setBlocking(true)
    const real = h.store.blockSources.bind(h.store)
    h.store.blockSources = () => {
      throw new Error('the store could not be read')
    }
    await h.work()
    const view = await h.engine.blocking()
    expect(view.ok && view.value.problem).toContain('could not be worked out this time')
    expect(view.ok && view.value.problem).toContain('the store could not be read')
    expect(h.store.blocking().failures).toBe(1)
    // Backed off: the next wake is not a spin.
    expect(h.store.blocking().retryAt).toBe(h.clock.t + 30_000)
    h.store.blockSources = real
    h.advance(31_000)
    await h.work()
    expect(await h.engine.blocking()).toMatchObject({ ok: true, value: { problem: null, kept: 1 } })
    expect(blocksAt(h, F)).toHaveLength(1)
  })
})

describe('a Google that names the account another way', () => {
  test('blocks come back with an organiser spelled as an alias: the mark stays, no block of a block, no rewrite at any read, and switching off removes them', async () => {
    const h = await world([Z, F, G])
    h.google.aliasAddresses = true
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    await turnOn(h)
    expect(writes(h).map((w) => [w.op, w.calendarId])).toEqual([['events.insert', F], ['events.insert', G]])
    for (let n = 0; n < 3; n++) await sync(h)
    h.store.forgetToken(`${F}|${F}`)
    h.store.forgetToken(`${G}|${G}`)
    await sync(h)
    expect(writes(h)).toHaveLength(2)
    expect(h.store.blocksHeld()).toHaveLength(2)
    expect(await agendaTitles(h)).toEqual(['Secret plan m1'])
    expect(await h.engine.blocking()).toMatchObject({ ok: true, value: { kept: 2, problem: null } })
    await h.engine.setBlocking(false)
    await h.work()
    expect(blocksAt(h, F)).toEqual([])
    expect(blocksAt(h, G)).toEqual([])
  })

  test('a guest added to a block, or its title changed, still makes it an ordinary event', async () => {
    const h = await world()
    meet(h, Z, 'm1', at(24), at(25))
    await sync(h)
    await turnOn(h)
    const id = h.store.blocksHeld()[0]?.eventId as string
    h.google.setEvent(F, F, { id, summary: 'Busy', start: iso(at(24)), end: iso(at(25)), attendees: [{ email: F, self: true, responseStatus: 'accepted' }, { email: 'dana@example.com', responseStatus: 'accepted' }] })
    await sync(h)
    // On F it is a meeting now (drawn, and blocked in turn on Z); it is not a block there.
    expect(h.store.blocksHeld().every((b) => b.account !== F)).toBe(true)
    expect(await agendaTitles(h)).toContain('Busy')
  })
})
