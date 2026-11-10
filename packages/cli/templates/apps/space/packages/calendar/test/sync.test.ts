import { describe, expect, test } from 'bun:test'
import { FULL_RESYNC_MS, RENEW_BEFORE_MS, renewAtOf, SAFETY_RESYNC_MS } from '../src/store'
import { DAY, grant, HOUR, type Harness, harness, PUSH_URL, T0 } from '../test-support/harness'

/**
 * The sync, over a Google that can fail (test-support/fake-google.ts): the shape Tessa asked for ("we should not be polling all the time, we should have our own calendar persistence layer that gcal
 * data is integrating into"). What is proved: a first full read per shown calendar, then incremental reads from Google's sync token woken by Google's push, channels made before the read and replaced before they
 * end, a slow safety resync for a lost notification, a full read again on a 410, and that NOTHING asks Google while nothing is owed. What this cannot show is Google itself (the real shape of a channel's life, whether a
 * token keeps its window): the hand test, docs/runbooks/calendar-google-setup.md.
 */

const Z = 'tessa@northfield.example'
const F = 'tessa@ashgrove.example'
const IN_AN_HOUR = new Date(T0 + HOUR).toISOString()
const IN_TWO_HOURS = new Date(T0 + 2 * HOUR).toISOString()
const iso = (ms: number) => new Date(ms).toISOString()

/** Two accounts, each with a primary calendar holding one event today. */
async function world(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options)
  h.connect(Z)
  h.connect(F)
  h.google.addCalendar(Z, { id: Z, summary: 'Tessa', primary: true })
  h.google.addCalendar(F, { id: F, summary: 'Tessa (Ashgrove)', primary: true })
  h.google.setEvent(Z, Z, { id: 'z1', summary: 'Northfield Works standup', start: IN_AN_HOUR, end: IN_TWO_HOURS })
  h.google.setEvent(F, F, { id: 'f1', summary: 'Ashgrove board', start: iso(T0 + 3 * HOUR), end: iso(T0 + 4 * HOUR) })
  await h.work()
  return h
}

const agenda = async (h: Harness, from = T0 - DAY, to = T0 + 7 * DAY) => {
  const got = await h.engine.agenda(from, to)
  if (!got.ok) throw new Error(got.error)
  return got.value
}
const titles = async (h: Harness) => (await agenda(h)).events.map((e) => e.title)
/** The Google calls made since `mark`. */
const since = (h: Harness, mark: number) => h.google.calls.slice(mark)

describe('the first read', () => {
  test('each account’s calendar list, then each shown calendar in full, then every event is in the store', async () => {
    const h = await world()
    expect(h.google.calls.filter((c) => c.startsWith('calendarList.list'))).toEqual(['calendarList.list:full', 'calendarList.list:full'])
    expect(h.google.calls.filter((c) => c.startsWith('events.list'))).toEqual([`events.list:${Z}:full`, `events.list:${F}:full`])
    expect(await titles(h)).toEqual(['Northfield Works standup', 'Ashgrove board'])
    const views = h.store.accountViews()
    expect(views.map((a) => [a.address, a.state, a.calendars.length])).toEqual([
      [Z, 'live', 1],
      [F, 'live', 1],
    ])
    expect(h.told.n).toBeGreaterThan(0)
  })

  test('the full read covers a window of three months back and half a year ahead, and nothing outside it is kept', async () => {
    const h = harness()
    h.connect(Z)
    h.google.addCalendar(Z, { id: Z, summary: 'Tessa', primary: true })
    h.google.setEvent(Z, Z, { id: 'old', summary: 'Last year', start: iso(T0 - 400 * DAY), end: iso(T0 - 400 * DAY + HOUR) })
    h.google.setEvent(Z, Z, { id: 'far', summary: 'Next year', start: iso(T0 + 400 * DAY), end: iso(T0 + 400 * DAY + HOUR) })
    h.google.setEvent(Z, Z, { id: 'ok', summary: 'Next month', start: iso(T0 + 30 * DAY), end: iso(T0 + 30 * DAY + HOUR) })
    await h.work()
    expect(h.store.eventCount()).toBe(1)
  })

  test('pages are followed to the last, and the sync token comes from the last page only', async () => {
    const h = harness()
    h.connect(Z)
    h.google.pageSize = 2
    h.google.addCalendar(Z, { id: Z, summary: 'Tessa', primary: true })
    for (let i = 0; i < 5; i++) h.google.setEvent(Z, Z, { id: `p${i}`, summary: `Event ${i}`, start: iso(T0 + (i + 1) * HOUR), end: iso(T0 + (i + 1) * HOUR + 1800_000) })
    await h.work()
    expect(h.store.eventCount()).toBe(5)
    expect(h.google.calls.filter((c) => c.startsWith('events.list'))).toEqual([`events.list:${Z}:full`, `events.list:${Z}:full`, `events.list:${Z}:full`])
    expect(h.store.calendar(`${Z}|${Z}`)?.syncToken).toMatch(/^events-/)
  })

  test('a calendar is shown at first when it is the account’s own or primary, and hidden when it is subscribed; hidden ones are never read', async () => {
    const h = harness()
    h.connect(Z)
    h.google.addCalendar(Z, { id: Z, summary: 'Tessa', primary: true })
    h.google.addCalendar(Z, { id: 'team@group.calendar.google.com', summary: 'Team', accessRole: 'owner' })
    h.google.addCalendar(Z, { id: 'en.usa#holiday@group.v.calendar.google.com', summary: 'US holidays', accessRole: 'reader' })
    h.google.addCalendar(Z, { id: 'busy@x.example', summary: 'Someone’s', accessRole: 'freeBusyReader' })
    h.google.setEvent(Z, 'en.usa#holiday@group.v.calendar.google.com', { id: 'h1', summary: 'Veterans Day', startDate: '2026-11-11', endDate: '2026-11-12' })
    await h.work()
    const shown = Object.fromEntries(h.store.calendars(Z).map((c) => [c.name, c.shown]))
    expect(shown).toEqual({ Tessa: true, Team: true, 'US holidays': false, 'Someone’s': false })
    expect(h.google.calls.filter((c) => c.startsWith('events.list')).map((c) => c.split(':')[1])).toEqual([Z, 'team@group.calendar.google.com'])
    expect(await titles(h)).toEqual([])
  })
})

describe('the inbox cannot be reached', () => {
  test('for hours: the alarm is never asked for sooner than a second on, the inbox is looked for hourly and not every second, and the calendars already read keep their own schedule', async () => {
    const h = await world()
    h.inbox.down = true
    const start = h.clock.t
    const asksBefore = h.grantAsks.n
    // Every wake, as the Durable Object's alarm would ring it: at the time the last run asked for.
    let runs = 0
    while (h.clock.t < start + 3 * HOUR + 5 * 60_000 && runs < 100) {
      await h.work()
      runs++
      const next = h.alarms.at(-1) as number
      expect(next, `run ${runs}`).toBeGreaterThanOrEqual(h.clock.t + 1000)
      h.clock.t = next
    }
    expect(h.clock.t).toBeGreaterThanOrEqual(start + 3 * HOUR)
    // A handful of runs over three hours (the hourly look at the inbox, and the safety resync at six hours is not yet due), not one a second.
    expect(runs).toBeLessThanOrEqual(8)
    expect(h.grantAsks.n - asksBefore).toBeLessThanOrEqual(5)
    expect(h.logs.filter((l) => l.includes('could not ask the inbox')).length).toBe(h.grantAsks.n - asksBefore)
    // The accounts' pictures are untouched meanwhile.
    expect(await titles(h)).toEqual(['Northfield Works standup', 'Ashgrove board'])
    // And when the inbox is back, the very next look finds it.
    h.inbox.down = false
    h.grants[1] = grant(F, { lapsed: true })
    await h.work()
    expect(h.store.account(F)?.state).toBe('lapsed')
  })

  test('a store that has just started (no look at the inbox yet) is owed one at once', async () => {
    const h = harness()
    expect(h.engine.sync.nextWake()).toBe(h.clock.t)
    await h.work()
    expect(h.engine.sync.nextWake()).toBeGreaterThanOrEqual(h.clock.t + 59 * 60_000)
  })
})

describe('no polling', () => {
  test('while nothing is owed, nothing is asked of Google, however long it is left', async () => {
    const h = await world()
    const mark = h.google.calls.length
    for (let i = 0; i < 5; i++) {
      h.advance(HOUR)
      await h.work()
    }
    expect(since(h, mark)).toEqual([])
  })

  test('the alarm is asked for at the soonest owed thing, never in the past, and a quiet store waits for the safety resync', async () => {
    const h = await world()
    const wake = h.engine.sync.nextWake()
    expect(wake).toBeGreaterThan(h.clock.t)
    // The soonest thing owed is the hourly look at who is connected, then the safety resync, then a channel's renewal: nothing is owed now.
    expect(wake).toBe(T0 + HOUR)
  })

  test('a slow safety resync reads every shown calendar by its token, in case a notification was lost', async () => {
    const h = await world()
    const mark = h.google.calls.length
    h.advance(SAFETY_RESYNC_MS - 1000)
    await h.work()
    expect(since(h, mark).filter((c) => c.startsWith('events.list'))).toEqual([])
    h.advance(2000)
    await h.work()
    expect(since(h, mark).filter((c) => c.startsWith('events.list'))).toEqual([`events.list:${Z}:sync`, `events.list:${F}:sync`])
    // A change whose notification was lost is found by it.
    h.google.setEvent(Z, Z, { id: 'z2', summary: 'Lost notification', start: iso(T0 + 7 * HOUR), end: iso(T0 + 8 * HOUR) })
    h.advance(SAFETY_RESYNC_MS + 1000)
    await h.work()
    expect(await titles(h)).toContain('Lost notification')
  })

  test('a full read is made again once a week, because the window rolls and a token keeps the window it was made with', async () => {
    const h = await world()
    const mark = h.google.calls.length
    h.advance(FULL_RESYNC_MS + 1000)
    await h.work()
    expect(since(h, mark).filter((c) => c.startsWith('events.list'))).toEqual([`events.list:${Z}:full`, `events.list:${F}:full`])
  })

  test('a token made when the store kept only a month back is replaced by a full read at its next read, so the longer window arrives in hours and not in a week', async () => {
    const h = await world()
    h.rows(`UPDATE calendar SET window_from = ${T0 - 30 * DAY}`)
    const mark = h.google.calls.length
    h.advance(SAFETY_RESYNC_MS + 1000)
    await h.work()
    expect(since(h, mark).filter((c) => c.startsWith('events.list'))).toEqual([`events.list:${Z}:full`, `events.list:${F}:full`])
    // Read in full again, its window reaches three months back, and the next safety read is the cheap kind.
    const after = h.google.calls.length
    h.advance(SAFETY_RESYNC_MS + 1000)
    await h.work()
    expect(since(h, after).filter((c) => c.startsWith('events.list'))).toEqual([`events.list:${Z}:sync`, `events.list:${F}:sync`])
  })
})

describe('Google’s push', () => {
  test('a notification makes the changes since the token be read, and the event appears; nothing else is read', async () => {
    const h = await world()
    const mark = h.google.calls.length
    h.google.setEvent(Z, Z, { id: 'z2', summary: 'Lunch with Dana', start: iso(T0 + 5 * HOUR), end: iso(T0 + 6 * HOUR) })
    const headers = h.google.notification(Z, Z)
    expect(headers).not.toBeNull()
    expect(
      await h.engine.receivePush({
        channelId: headers?.['x-goog-channel-id'] as string,
        token: headers?.['x-goog-channel-token'] as string,
        resourceId: headers?.['x-goog-resource-id'] as string,
        state: 'exists',
      }),
    ).toBe(true)
    // The alarm is asked for at once.
    expect(h.alarms.at(-1)).toBe(h.clock.t)
    await h.work()
    expect(since(h, mark).filter((c) => c.startsWith('events.list'))).toEqual([`events.list:${Z}:sync`])
    expect(await titles(h)).toEqual(['Northfield Works standup', 'Ashgrove board', 'Lunch with Dana'])
  })

  test('a moved event is moved and a cancelled one is gone, from the changes alone', async () => {
    const h = await world()
    h.google.setEvent(Z, Z, { id: 'z1', summary: 'Northfield Works standup (moved)', start: iso(T0 + 9 * HOUR), end: iso(T0 + 10 * HOUR) })
    h.google.cancelEvent(F, F, 'f1')
    const push = async (account: string) => {
      const n = h.google.notification(account, account)
      await h.engine.receivePush({ channelId: n?.['x-goog-channel-id'] as string, token: n?.['x-goog-channel-token'] as string, resourceId: n?.['x-goog-resource-id'] as string, state: 'exists' })
    }
    await push(Z)
    await push(F)
    await h.work()
    const a = await agenda(h)
    expect(a.events.map((e) => [e.title, e.start])).toEqual([['Northfield Works standup (moved)', T0 + 9 * HOUR]])
  })

  test('the account’s list of calendars has a channel of its own: a calendar added in Google is found by its notification', async () => {
    const h = await world()
    h.google.addCalendar(Z, { id: 'new@group.calendar.google.com', summary: 'New', accessRole: 'owner' })
    const n = h.google.notification(Z, null)
    expect(n).not.toBeNull()
    await h.engine.receivePush({ channelId: n?.['x-goog-channel-id'] as string, token: n?.['x-goog-channel-token'] as string, resourceId: n?.['x-goog-resource-id'] as string, state: 'exists' })
    const mark = h.google.calls.length
    await h.work()
    expect(since(h, mark)).toContain('calendarList.list:sync')
    expect(h.store.calendars(Z).map((c) => c.name)).toContain('New')
    // Being new and owned, it is shown and read in full.
    expect(since(h, mark)).toContain('events.list:new@group.calendar.google.com:full')
  })

  test('a notification that arrives DURING a read is not lost: it owes another read', async () => {
    const h = await world()
    h.google.setEvent(Z, Z, { id: 'z2', summary: 'First change', start: iso(T0 + 5 * HOUR), end: iso(T0 + 6 * HOUR) })
    const n = h.google.notification(Z, Z)
    const headers = { channelId: n?.['x-goog-channel-id'] as string, token: n?.['x-goog-channel-token'] as string, resourceId: n?.['x-goog-resource-id'] as string, state: 'exists' }
    await h.engine.receivePush(headers)
    // The notification for a second change arrives while the first is being read.
    let injected = false
    h.google.afterRequest = async (op) => {
      if (!injected && op === 'events.list') {
        injected = true
        h.google.setEvent(Z, Z, { id: 'z3', summary: 'Second change', start: iso(T0 + 6 * HOUR), end: iso(T0 + 7 * HOUR) })
        await h.engine.receivePush(headers)
      }
    }
    await h.work()
    expect(injected).toBe(true)
    expect(h.store.calendar(`${Z}|${Z}`)?.dirty).toBe(true)
    h.google.afterRequest = null
    await h.work()
    expect(await titles(h)).toContain('Second change')
  })

  test('only a notification for a channel the calendar made, with its secret and its resource, is accepted; anything else owes nothing', async () => {
    const h = await world()
    const n = h.google.notification(Z, Z) as Record<string, string>
    const ok = { channelId: n['x-goog-channel-id'] as string, token: n['x-goog-channel-token'] as string, resourceId: n['x-goog-resource-id'] as string, state: 'exists' }
    const before = h.store.calendar(`${Z}|${Z}`)
    expect(before?.dirty).toBe(false)
    expect(await h.engine.receivePush({ ...ok, channelId: 'not-a-channel' })).toBe(false)
    expect(await h.engine.receivePush({ ...ok, token: 'wrong' })).toBe(false)
    expect(await h.engine.receivePush({ ...ok, token: null })).toBe(false)
    expect(await h.engine.receivePush({ ...ok, resourceId: 'res-other' })).toBe(false)
    expect(await h.engine.receivePush({ ...ok, resourceId: null })).toBe(false)
    expect(h.store.calendar(`${Z}|${Z}`)?.dirty).toBe(false)
    // Google’s first message on a channel (state sync) is accepted and owes nothing.
    expect(await h.engine.receivePush({ ...ok, state: 'sync' })).toBe(true)
    expect(h.store.calendar(`${Z}|${Z}`)?.dirty).toBe(false)
    expect(await h.engine.receivePush(ok)).toBe(true)
    expect(h.store.calendar(`${Z}|${Z}`)?.dirty).toBe(true)
  })
})

describe('a token Google no longer honours', () => {
  test('a 410 forgets the token and reads in full again, and the picture is right afterwards', async () => {
    const h = await world()
    h.google.expireTokens()
    h.google.setEvent(Z, Z, { id: 'z2', summary: 'After the gap', start: iso(T0 + 5 * HOUR), end: iso(T0 + 6 * HOUR) })
    h.google.cancelEvent(F, F, 'f1')
    h.store.markCalendarDirty(`${Z}|${Z}`)
    h.store.markCalendarDirty(`${F}|${F}`)
    const mark = h.google.calls.length
    await h.work()
    expect(since(h, mark).filter((c) => c.startsWith('events.list'))).toEqual([`events.list:${Z}:sync`, `events.list:${Z}:full`, `events.list:${F}:sync`, `events.list:${F}:full`])
    expect(await titles(h)).toEqual(['Northfield Works standup', 'After the gap'])
    expect(h.store.calendar(`${Z}|${Z}`)?.problem).toBeNull()
  })

  test('the calendar list’s token is the same: a 410 reads the list in full', async () => {
    const h = await world()
    h.google.expireTokens()
    h.store.markListDirty(Z)
    const mark = h.google.calls.length
    await h.work()
    expect(since(h, mark).filter((c) => c.startsWith('calendarList.list'))).toEqual(['calendarList.list:sync', 'calendarList.list:full'])
  })
})

describe('push channels', () => {
  test('one for each account’s list and one for each shown calendar, made BEFORE the read, to the push address, with a secret of their own', async () => {
    const h = await world()
    expect(h.google.channels.map((c) => [c.account, c.calendarId, c.address])).toEqual([
      [Z, null, PUSH_URL],
      [Z, Z, PUSH_URL],
      [F, null, PUSH_URL],
      [F, F, PUSH_URL],
    ])
    const order = h.google.calls.filter((c) => c.startsWith('events.watch') || c.startsWith('events.list'))
    expect(order).toEqual([`events.watch:${Z}`, `events.list:${Z}:full`, `events.watch:${F}`, `events.list:${F}:full`])
    expect(new Set(h.google.channels.map((c) => c.token)).size).toBe(4)
    expect(new Set(h.google.channels.map((c) => c.id)).size).toBe(4)
  })

  test('a channel with a day left is replaced: the new one first, then the old one stopped, and the old one’s notifications stop being accepted', async () => {
    const h = await world()
    h.google.channelLife = 3 * DAY
    // The channels made so far lived the default 7 days; make the next ones short and let the old ones come within a day of ending.
    h.advance(7 * DAY - RENEW_BEFORE_MS + HOUR)
    h.store.askAll()
    const old = h.google.notification(Z, Z) as Record<string, string>
    const mark = h.google.calls.length
    await h.work()
    const made = since(h, mark)
    expect(made.filter((c) => c.startsWith('events.watch')).length).toBeGreaterThan(0)
    expect(made.filter((c) => c.startsWith('channels.stop')).length).toBe(made.filter((c) => c.startsWith('events.watch') || c.startsWith('calendarList.watch')).length)
    const live = h.google.channels.filter((c) => c.account === Z && c.calendarId === Z && !c.stopped)
    expect(live.length).toBe(1)
    expect(live[0]?.id).not.toBe(old['x-goog-channel-id'])
    // The stopped one is forgotten here, so a late notification for it is refused.
    expect(await h.engine.receivePush({ channelId: old['x-goog-channel-id'] as string, token: old['x-goog-channel-token'] as string, resourceId: old['x-goog-resource-id'] as string, state: 'exists' })).toBe(false)
    expect(h.store.channels().filter((c) => c.account === Z && c.calendarId === `${Z}|${Z}`).length).toBe(1)
  })

  test('a channel Google grants for much less than a week is renewed at half its life and never churned: no spin on a short grant', async () => {
    expect(renewAtOf({ createdAt: 0, expiresAt: 7 * DAY })).toBe(6 * DAY)
    expect(renewAtOf({ createdAt: 0, expiresAt: 2 * HOUR })).toBe(HOUR)
    expect(renewAtOf({ createdAt: 0, expiresAt: 60_000 })).toBe(300_000)
    const h = harness()
    h.connect(Z)
    h.google.channelLife = 2 * HOUR
    h.google.addCalendar(Z, { id: Z, summary: 'Tessa', primary: true })
    await h.work()
    const made = h.google.channels.length
    expect(made).toBe(2)
    // Nothing is owed right after, so nothing is made: the next wake is the half-life, not "now".
    await h.work()
    expect(h.google.channels.length).toBe(made)
    expect(h.engine.sync.nextWake()).toBeGreaterThan(h.clock.t + 30 * 60_000)
    h.advance(HOUR + 1000)
    await h.work()
    expect(h.google.channels.length).toBe(made * 2)
    expect(h.store.channelsOf(Z, `${Z}|${Z}`).length).toBe(1)
  })

  test('the alarm is asked for before a channel ends, so it is renewed in time', async () => {
    const h = await world()
    const ends = Math.min(...h.google.channels.map((c) => c.expiration))
    const wake = h.engine.sync.nextWake()
    expect(wake).toBeLessThanOrEqual(ends - RENEW_BEFORE_MS)
  })

  test('when Google will not make a channel the calendar still reads it, says why on its own, and tries again later', async () => {
    const h = harness()
    h.connect(Z)
    h.google.addCalendar(Z, { id: Z, summary: 'Tessa', primary: true })
    h.google.setEvent(Z, Z, { id: 'z1', summary: 'Standup', start: IN_AN_HOUR, end: IN_TWO_HOURS })
    h.google.failNext('events.watch', 400, { error: { code: 400, message: 'Push notifications are not allowed for this calendar' } }, 3)
    await h.work()
    const c = h.store.calendar(`${Z}|${Z}`)
    expect(c?.channelProblem).toContain('not allowed')
    expect(c?.problem).toBeNull()
    expect(await titles(h)).toEqual(['Standup'])
    // Not tried again at once; tried again after its backoff, and then it holds.
    const mark = h.google.calls.length
    await h.work()
    expect(since(h, mark).filter((x) => x.startsWith('events.watch'))).toEqual([])
    h.advance(60_000)
    await h.work()
    h.advance(120_000)
    await h.work()
    h.advance(300_000)
    await h.work()
    expect(h.store.channelsOf(Z, `${Z}|${Z}`).length).toBe(1)
    expect(h.store.calendar(`${Z}|${Z}`)?.channelProblem).toBeNull()
  })

  test('the page is told, quietly, when a calendar has no live updates, and the note goes when push works', async () => {
    const h = harness()
    h.connect(Z)
    h.google.addCalendar(Z, { id: Z, summary: 'Tessa', primary: true })
    h.google.failNext('events.watch', 400, { error: { code: 400, message: 'Push notifications are not allowed for this calendar' } }, 1)
    await h.work()
    const view = h.store.accountViews()[0]
    expect(view?.calendars[0]?.note).toContain('Live updates are off for this calendar')
    expect(view?.calendars[0]?.note).toContain('every 6 hours')
    expect(view?.calendars[0]?.problem).toBeNull()
    expect(view?.reason).toBeNull()
    h.advance(60_000)
    await h.work()
    expect(h.store.accountViews()[0]?.calendars[0]?.note).toBeNull()
  })

  test('what Google actually granted a channel is said in the log, with no secret in the line', async () => {
    const h = await world()
    const said = h.logs.filter((l) => l.includes('lasts until'))
    expect(said.length).toBe(4)
    expect(said[0]).toMatch(/^calendar: a push channel for tessa@northfield\.example \(its calendar list\) lasts until 2026-11-12T20:00:00\.000Z$/)
    for (const c of h.google.channels) expect(h.logs.join('\n')).not.toContain(c.token)
  })

  test('with no push address set, no channel is made and the safety resync alone keeps the calendar current', async () => {
    const h = await world({ pushUrl: null })
    expect(h.google.channels).toEqual([])
    expect(await titles(h)).toEqual(['Northfield Works standup', 'Ashgrove board'])
    h.google.setEvent(Z, Z, { id: 'z2', summary: 'Seen by the safety net', start: iso(T0 + 5 * HOUR), end: iso(T0 + 6 * HOUR) })
    h.advance(SAFETY_RESYNC_MS + 1000)
    await h.work()
    expect(await titles(h)).toContain('Seen by the safety net')
  })
})

describe('when the grant is not good', () => {
  test('a lapsed account keeps its last picture, marked as old, and is not asked of Google again', async () => {
    const h = await world()
    const a = h.google.account(F)
    a.refusal = { why: 'lapsed', message: 'lapsed' }
    h.grants[1] = grant(F, { lapsed: true })
    h.advance(HOUR)
    await h.work()
    const view = h.store.accountViews().find((x) => x.address === F)
    expect(view?.state).toBe('lapsed')
    expect(view?.reason).toContain('Connect it again')
    const got = await agenda(h)
    expect(got.events.map((e) => [e.title, e.stale])).toEqual([
      ['Northfield Works standup', false],
      ['Ashgrove board', true],
    ])
    expect(got.accounts.find((x) => x.address === F)?.state).toBe('lapsed')
    const mark = h.google.calls.length
    h.advance(2 * DAY)
    await h.work()
    expect(since(h, mark).filter((c) => c.includes(F))).toEqual([])
  })

  test('connecting it again reads it afresh, and the old picture is replaced', async () => {
    const h = await world()
    h.google.account(F).refusal = { why: 'lapsed', message: 'lapsed' }
    h.grants[1] = grant(F, { lapsed: true })
    await h.work()
    h.google.cancelEvent(F, F, 'f1')
    h.google.setEvent(F, F, { id: 'f2', summary: 'Back again', start: iso(T0 + 3 * HOUR), end: iso(T0 + 4 * HOUR) })
    h.google.account(F).refusal = null
    h.grants[1] = grant(F)
    h.advance(HOUR)
    await h.work()
    const got = await agenda(h)
    expect(got.events.map((e) => [e.title, e.stale])).toEqual([
      ['Northfield Works standup', false],
      ['Back again', false],
    ])
  })

  test('the inbox refusing a token (the grant ended since it last said so) marks the account lapsed at once and does not retry', async () => {
    const h = await world()
    h.google.account(Z).refusal = { why: 'lapsed', message: 'lapsed' }
    h.google.endToken(Z)
    h.store.markCalendarDirty(`${Z}|${Z}`)
    // Force a call: the cached token is dead and the door refuses a fresh one.
    h.advance(61 * 60_000)
    await h.work()
    expect(h.store.account(Z)?.state).toBe('lapsed')
    // The inbox marks the grant lapsed in the same breath (calendarAccess does), so what it says of who is connected agrees.
    h.grants[0] = grant(Z, { lapsed: true })
    const askedForZ = () => h.google.accessAsked.filter((x) => x.address === Z).length
    const asked = askedForZ()
    h.advance(DAY)
    await h.work()
    expect(askedForZ()).toBe(asked)
  })

  test('an account connected for mail without the calendar permission has no calendar until the calendar is connected, and nothing is asked of Google for it', async () => {
    const h = harness()
    h.connect(Z, { calendar: false })
    h.google.addCalendar(Z, { id: Z, summary: 'Tessa', primary: true })
    await h.work()
    const view = h.store.accountViews()[0]
    expect(view).toMatchObject({ address: Z, state: 'needs-calendar', calendars: [] })
    expect(view?.reason).toContain('is connected for mail without the calendar permission. Press Connect calendar and accept it')
    expect(h.google.calls).toEqual([])
    h.grants[0] = grant(Z)
    await h.work()
    expect(h.store.accountViews()[0]?.state).toBe('live')
    expect(h.store.calendars(Z).length).toBe(1)
  })

  test('whether the grant can also change events is recorded as the inbox says it, reading is live without it, and the page is told when it changes', async () => {
    const h = harness()
    h.connect(Z, { events: false })
    h.google.addCalendar(Z, { id: Z, summary: 'Tessa', primary: true })
    await h.work()
    expect(h.store.account(Z)).toMatchObject({ state: 'live', events: false })
    expect(h.store.accountViews()[0]).toMatchObject({ address: Z, state: 'live', events: false })
    expect(h.store.calendars(Z).length).toBe(1)
    // Connect calendar again: same account, same calendars, now allowed to edit.
    h.grants[0] = grant(Z)
    expect(h.store.applyGrants(h.grants)).toEqual({ changed: true })
    expect(h.store.accountViews()[0]).toMatchObject({ state: 'live', events: true })
    expect(h.store.applyGrants(h.grants)).toEqual({ changed: false })
  })

  test('Google saying the permission is missing is the same: needs the calendar permission, not a passing fault', async () => {
    const h = harness()
    h.connect(Z)
    h.google.addCalendar(Z, { id: Z, summary: 'Tessa', primary: true })
    h.google.failNext('calendarList.list', 403, { error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } })
    await h.work()
    expect(h.store.account(Z)?.state).toBe('needs-calendar')
  })

  test('a disconnected account loses its calendars and events, and its colour slot is kept for when it returns', async () => {
    const h = await world()
    const hue = h.store.account(F)?.hue
    h.grants[1] = grant(F, { connected: false })
    await h.work()
    expect(h.store.account(F)?.state).toBe('disconnected')
    expect(h.store.calendars(F)).toEqual([])
    expect(await titles(h)).toEqual(['Northfield Works standup'])
    h.grants[1] = grant(F)
    await h.work()
    expect(h.store.account(F)).toMatchObject({ state: 'live', hue })
    expect(await titles(h)).toEqual(['Northfield Works standup', 'Ashgrove board'])
  })

  test('an address the inbox no longer lists is treated as disconnected', async () => {
    const h = await world()
    h.grants.splice(1, 1)
    await h.work()
    expect(h.store.account(F)?.state).toBe('disconnected')
  })
})

describe('a read that fails', () => {
  test('a Google that gives no sync token is a failure with a backoff, never a calendar owed again at once', async () => {
    const h = harness()
    h.connect(Z)
    h.google.noSyncToken = true
    h.google.addCalendar(Z, { id: Z, summary: 'Tessa', primary: true })
    h.google.setEvent(Z, Z, { id: 'z1', summary: 'Standup', start: IN_AN_HOUR, end: IN_TWO_HOURS })
    await h.work()
    expect(h.store.account(Z)?.listProblem).toContain('no sync token')
    expect(h.store.accountViews()[0]?.reason).toContain('no sync token')
    // Not asked again until its backoff is over, and the wake is after it.
    const mark = h.google.calls.length
    await h.work()
    expect(since(h, mark).filter((c) => c.startsWith('calendarList.list'))).toEqual([])
    expect(h.engine.sync.nextWake()).toBeGreaterThanOrEqual(h.clock.t + 29_000)
    // Once Google behaves, it reads.
    h.google.noSyncToken = false
    h.advance(31_000)
    await h.work()
    expect(await titles(h)).toEqual(['Standup'])
  })

  test('keeps the events it has, says what happened, waits out a backoff, and then succeeds', async () => {
    const h = await world()
    h.google.failNext('events.list', 500, { error: { code: 500, message: 'Backend Error' } })
    h.google.setEvent(Z, Z, { id: 'z2', summary: 'Waiting', start: iso(T0 + 5 * HOUR), end: iso(T0 + 6 * HOUR) })
    h.store.markCalendarDirty(`${Z}|${Z}`)
    await h.work()
    const c = h.store.calendar(`${Z}|${Z}`)
    expect(c?.problem).toContain('Backend Error')
    expect(await titles(h)).toEqual(['Northfield Works standup', 'Ashgrove board'])
    expect(h.store.accountViews()[0]?.reason).toContain('Backend Error')
    const mark = h.google.calls.length
    await h.work()
    expect(since(h, mark).filter((x) => x.startsWith('events.list'))).toEqual([])
    h.advance(31_000)
    await h.work()
    expect(h.store.calendar(`${Z}|${Z}`)?.problem).toBeNull()
    expect(await titles(h)).toContain('Waiting')
  })

  test('the backoff doubles with each failure in a row and stops at an hour', async () => {
    const h = await world()
    h.google.failNext('events.list', 500, { error: { code: 500, message: 'Backend Error' } }, 20, Z)
    h.store.markCalendarDirty(`${Z}|${Z}`)
    const waits: number[] = []
    for (let i = 0; i < 9; i++) {
      await h.work()
      const c = h.store.calendar(`${Z}|${Z}`)
      waits.push((c?.retryAt ?? 0) - h.clock.t)
      h.clock.t = c?.retryAt ?? h.clock.t
    }
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000])
  })

  test('a calendar Google no longer has is removed with its events', async () => {
    const h = await world()
    h.google.account(Z).calendars.delete(Z)
    h.store.markCalendarDirty(`${Z}|${Z}`)
    await h.work()
    expect(h.store.calendar(`${Z}|${Z}`)).toBeNull()
    expect(await titles(h)).toEqual(['Ashgrove board'])
  })

  test('an access token Google ended early is replaced once and the call goes through', async () => {
    const h = await world()
    h.google.endToken(Z)
    h.google.setEvent(Z, Z, { id: 'z2', summary: 'After a dead token', start: iso(T0 + 5 * HOUR), end: iso(T0 + 6 * HOUR) })
    h.store.markCalendarDirty(`${Z}|${Z}`)
    const asked = h.google.accessAsked.length
    await h.work()
    expect(await titles(h)).toContain('After a dead token')
    expect(h.google.accessAsked.slice(asked).some((x) => x.address === Z && x.fresh)).toBe(true)
  })
})

describe('the shown switch', () => {
  async function withHoliday() {
    const h = harness()
    h.connect(Z)
    h.google.addCalendar(Z, { id: Z, summary: 'Tessa', primary: true })
    h.google.addCalendar(Z, { id: 'hol', summary: 'Holidays', accessRole: 'reader' })
    h.google.setEvent(Z, 'hol', { id: 'h1', summary: 'Veterans Day', startDate: '2026-11-11', endDate: '2026-11-12' })
    await h.work()
    return h
  }

  test('showing a hidden calendar reads it in full, makes its channel, and its events join the agenda', async () => {
    const h = await withHoliday()
    expect(await titles(h)).toEqual([])
    const done = await h.engine.setShown(`${Z}|hol`, true)
    expect(done).toMatchObject({ ok: true, value: { shown: true } })
    expect(h.alarms.at(-1)).toBe(h.clock.t)
    const before = h.told.n
    await h.work()
    expect(await titles(h)).toEqual(['Veterans Day'])
    expect(h.store.channelsOf(Z, `${Z}|hol`).length).toBe(1)
    expect(h.told.n).toBeGreaterThan(before)
  })

  test('hiding a calendar drops its events at once and stops its channel at Google at the next run', async () => {
    const h = await withHoliday()
    await h.engine.setShown(`${Z}|hol`, true)
    await h.work()
    const channel = h.store.channelsOf(Z, `${Z}|hol`)[0]
    const done = await h.engine.setShown(`${Z}|hol`, false)
    expect(done).toMatchObject({ ok: true, value: { shown: false } })
    expect(await titles(h)).toEqual([])
    await h.work()
    expect(h.google.channels.find((c) => c.id === channel?.id)?.stopped).toBe(true)
    expect(h.store.channel(channel?.id as string)).toBeNull()
  })

  test('the owner’s choice is never undone by a change in Google’s list', async () => {
    const h = await withHoliday()
    await h.engine.setShown(`${Z}|hol`, true)
    await h.engine.setShown(Z + '|' + Z, false)
    await h.work()
    h.google.touchCalendar(Z, 'hol', { summary: 'Holidays (renamed)' })
    h.google.touchCalendar(Z, Z, { backgroundColor: '#123456' })
    h.store.markListDirty(Z)
    await h.work()
    const shown = Object.fromEntries(h.store.calendars(Z).map((c) => [c.googleId, c.shown]))
    expect(shown).toEqual({ [Z]: false, hol: true })
    expect(h.store.calendar(`${Z}|hol`)?.name).toBe('Holidays (renamed)')
  })

  test('a calendar that is not there, and an id that is not an id, are refused', async () => {
    const h = await withHoliday()
    expect(await h.engine.setShown(`${Z}|nope`, true)).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await h.engine.setShown('../../etc', true)).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await h.engine.setShown(`${Z}|hol`, 'yes' as never)).toMatchObject({ ok: false, reason: 'bad-request' })
  })

  test('Check now asks for everything to be read at once, and the alarm does it', async () => {
    const h = await world()
    const done = await h.engine.syncNow()
    expect(done).toEqual({ ok: true, value: { asked: 2 } })
    const mark = h.google.calls.length
    await h.work()
    expect(since(h, mark).filter((c) => c.startsWith('events.list'))).toEqual([`events.list:${Z}:sync`, `events.list:${F}:sync`])
  })
})

describe('Check now asks the inbox again, whatever the last attempt came to', () => {
  test('after a failed ask, within the hour of its timer, Check now asks again and a returning inbox is heard at once', async () => {
    const h = await world()
    h.inbox.down = true
    await h.work()
    // The timer of the next look runs from that failed attempt: an hour away, and nothing else is owed.
    h.inbox.down = false
    h.connect('dana@northfield.example')
    h.google.addCalendar('dana@northfield.example', { id: 'dana@northfield.example', summary: 'Dana', primary: true })
    const asked = h.grantAsks.n
    h.advance(60 * 1000)
    expect(await h.engine.syncNow()).toMatchObject({ ok: true })
    expect(h.grantAsks.n).toBe(asked + 1)
    expect(h.store.accounts().map((a) => a.address)).toContain('dana@northfield.example')
  })
})

describe('the page is told after the change is stored, and only for a change', () => {
  test('a run that finds something new tells; a run that finds nothing does not', async () => {
    const h = await world()
    const n = h.told.n
    h.store.markCalendarDirty(`${Z}|${Z}`)
    await h.work()
    // The incremental read found nothing: the page is not told.
    const afterQuiet = h.told.n
    expect(afterQuiet).toBe(n)
    h.google.setEvent(Z, Z, { id: 'z9', summary: 'New', start: iso(T0 + 5 * HOUR), end: iso(T0 + 6 * HOUR) })
    h.store.markCalendarDirty(`${Z}|${Z}`)
    await h.work()
    expect(h.told.n).toBe(afterQuiet + 1)
  })
})
