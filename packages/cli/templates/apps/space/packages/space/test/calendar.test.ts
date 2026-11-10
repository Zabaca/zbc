// The Calendar tab and Settings, Calendars in the space, driven through the real router with a stand-in calendar app behind the part. What is asserted is what a
// person sees (the answers the page is given, what a write came to) or what is refused, never the Worker's internals: no sign-in is refused at every path and the app is never asked; the person the one check named is the one
// handed on; a write is never retried; the app's own words come through; a reply that is not the contract's shape is not half read; the agenda carries Meet's meetings beside Google's events and says when they are not
// listed; and the tab says it could not be reached while everything else keeps working. The calendar's own rules (the sync, the store) are packages/calendar's tests.
import { describe, expect, test } from 'bun:test'
import { answered, type CalendarAccountView, type CalendarEvent } from '@space/workspace'
import { T0, northfield } from '../../workspace/test/helpers'
import type { CalendarAgendaAnswer } from '../src/calendar'
import { standInCalendar } from '../src/stand-in-calendar'
import { fixtureApps } from '../src/stand-ins'
import type { ViewAnswer } from '../src/views'
import { NORTHFIELD_TEAM, world } from './world'

const ORIGIN = 'https://space.northfield.example'
const JSON_POST = { origin: ORIGIN, 'content-type': 'application/json' }
const ZONE = 'America/Los_Angeles'
const DAY = 24 * 3_600_000

async function asOwner(options: { noCalendar?: boolean; noMeet?: boolean; mode?: 'lapsed' | 'down' | 'empty' } = {}) {
  const calendar = standInCalendar(T0, ZONE, options.mode ?? '1')
  const fixtures = fixtureApps(T0)
  const w = await world(northfield(), NORTHFIELD_TEAM, { parts: { ...(options.noCalendar ? {} : { calendar: calendar.methods }), ...(options.noMeet ? {} : { meet: fixtures.meet }) } }, undefined, { answerWithinMs: 60, writeWithinMs: 200, now: () => T0 })
  const jwt = await w.signIn('tessa@northfield.example')
  const get = async <T>(path: string): Promise<ViewAnswer<T>> => {
    const res = await w.call(path, { jwt })
    expect([path, res.status]).toEqual([path, 200])
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    return (await res.json()) as ViewAnswer<T>
  }
  const agenda = (from = T0 - DAY, to = T0 + 14 * DAY) => get<CalendarAgendaAnswer>(`/api/calendar/agenda?from=${from}&to=${to}`)
  const post = (path: string, body: unknown, headers: Record<string, string> = JSON_POST) => w.call(path, { method: 'POST', jwt, headers, body: JSON.stringify(body) })
  return { w, jwt, calendar, get, agenda, post, calls: () => calendar.calls.map((c) => c.method) }
}

const READS = ['/api/calendar/agenda?from=1&to=2', '/api/calendar/accounts', '/api/calendar/event?id=a%7Cb%7Cc']
const WRITES = ['/api/calendar/shown', '/api/calendar/sync']

describe('no sign-in is refused, and the calendar app is not asked', () => {
  test('without a sign-in, whatever the method and whatever else rides along, at every read and write', async () => {
    const s = await asOwner()
    const cookie = await s.w.signIn('tessa@northfield.example')
    const forms = await s.w.signInForms('tessa@northfield.example')
    for (const path of [...READS, ...WRITES]) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        for (const init of [{}, { cookieJwt: cookie }, { jwt: forms }]) {
          const res = await s.w.call(path, { method, ...init, headers: JSON_POST, body: method === 'POST' ? '{}' : undefined })
          expect([path, method, Object.keys(init)[0] ?? 'none', res.status]).toEqual([path, method, Object.keys(init)[0] ?? 'none', 401])
        }
      }
    }
    expect(s.calendar.calls).toEqual([])
  })

  test('another company’s person is refused too, and so is Claude’s token: the calendar has no door for a machine', async () => {
    const s = await asOwner()
    const stranger = await s.w.signIn('lane@pinecrest.test')
    for (const path of READS) expect((await s.w.call(path, { jwt: stranger })).status).toBe(403)
    for (const path of WRITES) expect((await s.w.call(path, { method: 'POST', jwt: stranger, headers: JSON_POST, body: '{}' })).status).toBe(403)
    const token = await s.w.signInAgent()
    for (const path of READS) expect([path, (await s.w.call(path, { jwt: token })).status]).toEqual([path, 401])
    expect(s.calendar.calls).toEqual([])
  })
})

describe('what a write has to be', () => {
  test('from this host, as JSON and small: a form on another site cannot show or hide a calendar', async () => {
    const s = await asOwner()
    const body = JSON.stringify({ calendar: 'tessa@northfield.example|tessa@northfield.example', shown: false })
    const call = (headers: Record<string, string>, b = body) => s.w.call('/api/calendar/shown', { method: 'POST', jwt: s.jwt, headers, body: b })
    expect((await call({ 'content-type': 'application/json' })).status).toBe(403)
    expect((await call({ origin: 'https://evil.example', 'content-type': 'application/json' })).status).toBe(403)
    expect((await call({ origin: ORIGIN, 'content-type': 'text/plain' })).status).toBe(415)
    expect((await call({ origin: ORIGIN, 'content-type': 'application/json', 'content-length': '999999' })).status).toBe(413)
    expect((await call(JSON_POST, 'not json')).status).toBe(400)
    for (const bad of [{}, { calendar: 'a', shown: 'yes' }, { shown: true }, { calendar: '../../x', shown: true }, { calendar: 'a b', shown: true }, { calendar: 'x'.repeat(1000), shown: true }]) {
      expect([JSON.stringify(bad), (await s.post('/api/calendar/shown', bad)).status]).toEqual([JSON.stringify(bad), 400])
    }
    expect(s.calendar.calls).toEqual([])
  })

  test('a method other than the one the path takes is refused and asks no one', async () => {
    const s = await asOwner()
    expect((await s.w.call('/api/calendar/shown', { method: 'PUT', jwt: s.jwt, headers: JSON_POST, body: '{}' })).status).toBe(405)
    expect((await s.w.call('/api/calendar/agenda?from=1&to=2', { method: 'POST', jwt: s.jwt, headers: JSON_POST, body: '{}' })).status).toBe(405)
    expect((await s.w.call('/api/calendar/accounts', { method: 'DELETE', jwt: s.jwt })).status).toBe(405)
    expect(s.calendar.calls).toEqual([])
  })

  test('a query that is not an agenda is a 400 and asks no one', async () => {
    const s = await asOwner()
    for (const q of ['', '?from=1', '?from=a&to=b', `?from=${T0}&to=${T0}`, `?from=${T0}&to=${T0 - 1}`, `?from=${T0}&to=${T0 + 63 * DAY}`, '?from=-5&to=100', `?from=${T0}.5&to=${T0 + DAY}`]) {
      expect([q, (await s.w.call(`/api/calendar/agenda${q}`, { jwt: s.jwt })).status]).toEqual([q, 400])
    }
    for (const id of ['', '../x', 'a b', 'x'.repeat(1000)]) expect([id, (await s.w.call(`/api/calendar/event?id=${encodeURIComponent(id)}`, { jwt: s.jwt })).status]).toEqual([id, 400])
    expect((await s.w.call('/api/calendar/event', { jwt: s.jwt })).status).toBe(400)
    expect(s.calendar.calls).toEqual([])
  })
})

describe('the agenda', () => {
  test('is the app’s events, handed the person the one check named, with the meetings booked in Meet beside them', async () => {
    const s = await asOwner()
    const got = await s.agenda()
    expect(got.result).toBe('ok')
    if (got.result !== 'ok') return
    const titles = got.value.events.map((e) => e.title)
    expect(titles).toContain('Northfield Works standup')
    expect(titles).toContain('Weekly planning')
    // Meet's meetings come from Meet, in the same span, and are asked of Meet as the same person.
    expect(got.value.meetingsListed).toBe(true)
    expect(got.value.meetings.map((m) => m.title).sort()).toEqual(['Hosting review', 'Menu page review', 'Promotion walkthrough'])
    expect(got.value.meetings.every((m) => m.link.startsWith('https://') && m.startsAt >= T0 - DAY)).toBe(true)
    expect(s.calendar.calls).toHaveLength(1)
    expect(s.calendar.calls[0]).toMatchObject({ method: 'agenda', asker: 'tessa@northfield.example', args: [T0 - DAY, T0 + 14 * DAY] })
  })

  test('the same board call on two calendars is one event naming both accounts', async () => {
    const s = await asOwner()
    const got = await s.agenda()
    if (got.result !== 'ok') throw new Error('no agenda')
    const board = got.value.events.filter((e) => e.title === 'Board call')
    expect(board).toHaveLength(1)
    expect(board[0]?.accounts.map((a) => a.label)).toEqual(['northfield', 'ashgrove'])
  })

  test('a hidden calendar’s events are not in it, and showing the calendar brings them', async () => {
    const s = await asOwner()
    const titles = async () => ((await s.agenda()) as { value: CalendarAgendaAnswer }).value.events.map((e) => e.title)
    expect(await titles()).not.toContain('Observed holiday')
    const holidays = await s.post('/api/calendar/shown', { calendar: 'tessa@northfield.example|en.usa#holiday@group.v.calendar.google.com', shown: true })
    expect(await holidays.json()).toMatchObject({ result: 'ok', value: { shown: true } })
    expect(await titles()).toContain('Observed holiday')
    const res = await s.post('/api/calendar/shown', { calendar: 'tessa@northfield.example|tessa@northfield.example', shown: false })
    expect(await res.json()).toMatchObject({ result: 'ok', value: { shown: false } })
    expect(await titles()).not.toContain('Northfield Works standup')
    const back = await s.post('/api/calendar/shown', { calendar: 'tessa@northfield.example|tessa@northfield.example', shown: true })
    expect(await back.json()).toMatchObject({ result: 'ok', value: { shown: true } })
    expect(await titles()).toContain('Northfield Works standup')
  })

  test('Meet not answering leaves Google’s events and says the meetings are not listed; the calendar not answering is the tab’s notice and no events', async () => {
    const s = await asOwner({ noMeet: true })
    const got = await s.agenda()
    expect(got).toMatchObject({ result: 'ok', value: { meetings: [], meetingsListed: false } })
    const down = await asOwner({ mode: 'down' })
    expect(await down.agenda()).toMatchObject({ result: 'unreachable', message: 'Calendar could not be reached.' })
    const gone = await asOwner({ noCalendar: true })
    expect(await gone.agenda()).toMatchObject({ result: 'unreachable', message: 'Calendar is not connected to the space.' })
  })

  test('slow, throwing, broken or answering something that is not the contract’s shape: said as not reached, and nothing is half read', async () => {
    const s = await asOwner()
    s.calendar.script.push('throw')
    expect(await s.agenda()).toMatchObject({ result: 'unreachable', message: 'Calendar could not be reached.' })
    s.calendar.script.push('hang')
    expect(await s.agenda()).toMatchObject({ result: 'unreachable', message: 'Calendar took too long to answer.' })
    s.calendar.script.push('broken')
    expect(await s.agenda()).toEqual({ result: 'failed', message: 'The calendar could not answer that. Nothing was changed.' })
    s.calendar.methods.agenda = async () => answered({ from: 1, to: 2, events: [{ id: 'x' }], accounts: [] }) as never
    expect(await s.agenda()).toMatchObject({ result: 'unreachable', message: 'Calendar answered in a way the space could not read.' })
  })

  test('an event whose link is not a link the app vouched for is still only data: the page draws text, and the app already refused anything but https (packages/calendar), so a script address never arrives', async () => {
    const s = await asOwner()
    const got = await s.agenda()
    if (got.result !== 'ok') throw new Error('no agenda')
    for (const e of got.value.events) for (const link of [e.videoLink, e.htmlLink]) if (link !== null) expect(link.startsWith('https://')).toBe(true)
  })
})

describe('the accounts and an event’s card', () => {
  test('Settings reads every account with its calendars and the shown switch; a lapsed account says so in one sentence', async () => {
    const s = await asOwner({ mode: 'lapsed' })
    const got = await s.get<CalendarAccountView[]>('/api/calendar/accounts')
    if (got.result !== 'ok') throw new Error('no accounts')
    expect(got.value.map((a) => [a.label, a.state])).toEqual([
      ['northfield', 'live'],
      ['ashgrove', 'lapsed'],
      ['tessa_marlow', 'needs-calendar'],
      ['fernway', 'live'],
    ])
    expect(got.value[1]?.reason).toContain('Connect it again')
    expect(got.value[2]?.reason).toContain('Press Connect calendar')
    expect(got.value[2]?.calendars).toEqual([])
    expect(got.value[0]?.calendars.map((c) => [c.name, c.shown])).toEqual([
      ['Tessa Marlow', true],
      ['Northfield Works team', true],
      ['Holidays in United States', false],
    ])
  })

  test('an event’s card is the app’s: its guests, its place, its notes; one that is gone is not-found in the app’s words', async () => {
    const s = await asOwner()
    const list = await s.agenda()
    if (list.result !== 'ok') throw new Error('no agenda')
    const intro = list.value.events.find((e) => e.title === 'Intro chat with Arun Mehta') as CalendarEvent
    const card = await s.get<CalendarEvent>(`/api/calendar/event?id=${encodeURIComponent(intro.id)}`)
    expect(card).toMatchObject({ result: 'ok', value: { title: 'Intro chat with Arun Mehta', response: 'needsAction', location: expect.stringContaining('Juniper') } })
    expect(await s.get(`/api/calendar/event?id=${encodeURIComponent('tessa@northfield.example|nope|ev9')}`)).toEqual({ result: 'refused', reason: 'not-found', message: 'That event is gone: it was changed or removed in Google Calendar.' })
  })

  test('Check now is a write that asks the app once, never retried: a lost connection is said as unknown and not tried again', async () => {
    const s = await asOwner()
    expect(await (await s.post('/api/calendar/sync', {})).json()).toEqual({ result: 'ok', value: { asked: 5 } })
    s.calendar.script.push('throw')
    expect(await (await s.post('/api/calendar/sync', {})).json()).toMatchObject({ result: 'outcome-unknown' })
    expect(s.calls().filter((m) => m === 'syncNow')).toHaveLength(2)
  })

  test('showing a calendar that is none is the app’s refusal, in its words', async () => {
    const s = await asOwner()
    expect(await (await s.post('/api/calendar/shown', { calendar: 'nobody@example.com|nope', shown: true })).json()).toEqual({ result: 'refused', reason: 'not-found', message: 'No such calendar.' })
  })
})

describe('the page and the other tabs', () => {
  test('/api/me lists the Calendar tab after Meet', async () => {
    const s = await asOwner()
    const me = (await (await s.w.call('/api/me', { jwt: s.jwt })).json()) as { tabs: { id: string; path: string }[] }
    expect(me.tabs.map((t) => t.id)).toEqual(['today', 'inbox', 'meet', 'calendar', 'forms', 'people', 'knowledge'])
    expect(me.tabs.find((t) => t.id === 'calendar')?.path).toBe('/calendar')
  })

  test('/calendar and an event’s card are the page, behind the sign-in like every tab', async () => {
    const s = await asOwner()
    for (const path of ['/calendar', '/calendar/event/tessa%40northfield.example%7Cx%7Cy']) {
      expect((await s.w.call(path)).status).toBe(401)
      const page = await s.w.call(path, { jwt: s.jwt })
      expect(page.status).toBe(200)
      expect(page.headers.get('content-type')).toContain('text/html')
    }
  })
})
