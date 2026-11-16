import { describe, expect, spyOn, test } from 'bun:test'
import { CALENDAR_FOR_INBOX_METHODS, type CalendarEventMade } from '@space/workspace'
import { createInboxCalendar, READ_FAULT, WRITE_FAULT } from '../src/inbox'
import { readInvite, readMove } from '../src/writes'
import { DAY, type Harness, harness, HOUR, T0 } from '../test-support/harness'

/**
 * What Claude does with the calendar (the space's ADR 0023), at the engine and its face, over a real SQLite and a fake Google that answers as the documents say. The rule in front of the writes (the owner's switch and instruction) is
 * the inbox's and is proven there (packages/inbox/test/claude-calendar.test.ts); what is proven HERE is what the calendar does when it is asked: the request Google receives (its body, `sendUpdates`, the Meet request, the scope of
 * the token), what the store shows after, what is refused before Google is asked, and that no token is ever in an answer or a log line.
 */

const Z = 'tessa@northfield.example'
const F = 'tessa@ashgrove.example'
const iso = (ms: number) => new Date(ms).toISOString()
/** The moment `n` hours after the test clock's start. */
const at = (n: number) => T0 + n * HOUR

async function world(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options)
  for (const a of [Z, F]) {
    h.connect(a)
    h.google.addCalendar(a, { id: a, summary: a, primary: true })
  }
  await h.work()
  return h
}

/** Google's events changed behind the calendar's back: ask for every shown calendar to be read, and read it. */
const sync = async (h: Harness) => {
  h.store.askAll()
  await h.work()
}

const read = async (h: Harness, from = T0 - DAY, to = T0 + 14 * DAY) => {
  const got = await h.engine.claudeEvents(from, to)
  if (!got.ok) throw new Error(got.error)
  return got.value
}

const invite = (over: Record<string, unknown> = {}) => ({ account: Z, title: 'Planning', start: at(24), end: at(25), guests: ['dana@example.com'], ...over })

/** The one write Google received, as it arrived. */
const lastWrite = (h: Harness) => {
  const w = h.google.writes.at(-1)
  if (!w) throw new Error('Google received no write')
  return w
}

const made = async (h: Harness, over: Record<string, unknown> = {}): Promise<CalendarEventMade> => {
  const got = await h.engine.claudeInvite(invite(over))
  if (!got.ok) throw new Error(got.error)
  return got.value
}

describe('the free time Claude reads', () => {
  test('every event of every connected account, each with whether it blocks the owner’s time: free time and a declined invitation do not, a tentative one and one not yet answered do', async () => {
    const h = await world()
    h.google.setEvent(Z, Z, { id: 'busy', summary: 'Standup', start: iso(at(1)), end: iso(at(2)), attendees: [{ email: Z, self: true, responseStatus: 'accepted' }] })
    h.google.setEvent(Z, Z, { id: 'free', summary: 'Focus time', start: iso(at(2)), end: iso(at(3)), transparency: 'transparent' })
    h.google.setEvent(F, F, { id: 'declined', summary: 'Vendor demo', start: iso(at(3)), end: iso(at(4)), attendees: [{ email: F, self: true, responseStatus: 'declined' }] })
    h.google.setEvent(F, F, { id: 'maybe', summary: 'Lunch', start: iso(at(4)), end: iso(at(5)), status: 'tentative', attendees: [{ email: F, self: true, responseStatus: 'tentative' }] })
    h.google.setEvent(F, F, { id: 'unanswered', summary: 'Intro call', start: iso(at(5)), end: iso(at(6)), attendees: [{ email: F, self: true, responseStatus: 'needsAction' }, { email: 'dana@example.com', responseStatus: 'accepted' }] })
    await sync(h)
    const got = await read(h)
    expect(got.events.map((e) => [e.title, e.busy])).toEqual([
      ['Standup', true],
      ['Focus time', false],
      ['Vendor demo', false],
      ['Lunch', true],
      ['Intro call', true],
    ])
    // The guests and how each answered come with it.
    expect(got.events.at(-1)?.guests.map((g) => [g.email, g.response])).toEqual([
      [F, 'needsAction'],
      ['dana@example.com', 'accepted'],
    ])
    expect(got.accounts.map((a) => [a.address, a.state, a.canEdit])).toEqual([
      [Z, 'live', true],
      [F, 'live', true],
    ])
  })

  test('the same meeting in two of the owner’s calendars is one event, free only when both copies are free', async () => {
    const h = await world()
    const meeting = { iCalUID: 'sync-2026@google.com', summary: 'Weekly sync', start: iso(at(1)), end: iso(at(2)) }
    h.google.setEvent(Z, Z, { id: 'a', ...meeting, transparency: 'transparent' })
    h.google.setEvent(F, F, { id: 'b', ...meeting })
    await sync(h)
    const got = await read(h)
    expect(got.events).toHaveLength(1)
    expect(got.events[0]).toMatchObject({ title: 'Weekly sync', free: false, busy: true })
    expect(got.events[0]?.accounts.map((a) => a.address).sort()).toEqual([F, Z])
  })

  test('is read from the store: Google is not asked, and an account that cannot take an invite says so', async () => {
    const h = await world()
    h.google.setEvent(Z, Z, { id: 'e', summary: 'Standup', start: iso(at(1)), end: iso(at(2)) })
    await sync(h)
    h.connect('read.only@northfield.example', { events: false })
    h.google.addCalendar('read.only@northfield.example', { id: 'read.only@northfield.example', summary: 'x', primary: true })
    await sync(h)
    h.google.failNext('events.list', 500, {}, 99)
    const mark = h.google.calls.length
    const got = await read(h)
    expect(h.google.calls.length).toBe(mark)
    expect(got.events.map((e) => e.title)).toEqual(['Standup'])
    expect(got.accounts.find((a) => a.address === 'read.only@northfield.example')).toMatchObject({ canEdit: false })
  })

  test('is the agenda’s span: backward, or past 62 days, is refused', async () => {
    const h = await world()
    expect(await h.engine.claudeEvents(at(2), at(1))).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await h.engine.claudeEvents(T0, T0 + 63 * DAY)).toMatchObject({ ok: false, reason: 'bad-request' })
  })
})

describe('an invite', () => {
  test('is one request to Google on the account’s primary calendar: the body, the invitations Google sends, the Meet request, and a token for calendar.events alone', async () => {
    const h = await world()
    const got = await made(h, { description: 'Agenda to follow.' })
    const w = lastWrite(h)
    expect(w).toMatchObject({ op: 'events.insert', calendarId: Z, level: 'events', query: { sendUpdates: 'all', conferenceDataVersion: '1' } })
    expect(w.body).toMatchObject({
      summary: 'Planning',
      description: 'Agenda to follow.',
      attendees: [{ email: 'dana@example.com' }],
      start: { timeZone: 'America/Los_Angeles' },
      end: { timeZone: 'America/Los_Angeles' },
    })
    // The times are the moments asked for, written with the company's offset.
    expect(Date.parse((w.body.start as { dateTime: string }).dateTime)).toBe(at(24))
    expect(Date.parse((w.body.end as { dateTime: string }).dateTime)).toBe(at(25))
    expect((w.body.start as { dateTime: string }).dateTime).toMatch(/-0[78]:00$/)
    // A Google Meet link is asked for by default, in the form Google documents.
    expect((w.body.conferenceData as { createRequest: { requestId: string; conferenceSolutionKey: { type: string } } }).createRequest).toMatchObject({ conferenceSolutionKey: { type: 'hangoutsMeet' } })
    expect(got).toMatchObject({ account: Z, title: 'Planning', guests: ['dana@example.com'], stored: true })
    expect(got.link).toStartWith('https://www.google.com/calendar/')
    expect(got.meetLink).toStartWith('https://meet.example/')
    expect(got.start).toBe(at(24))
    expect(got.id).toBe(`${Z}|${Z}|${got.eventId}`)
  })

  test('a Meet link is on unless the invite says false; with false Google is sent no conference request and the event has none', async () => {
    const h = await world()
    const got = await made(h, { meet: false })
    expect(lastWrite(h).body.conferenceData).toBeUndefined()
    expect(got.meetLink).toBeNull()
  })

  test('the account’s own address is dropped from the guests, a repeated one counts once, and an address is lower-cased', async () => {
    const h = await world()
    await made(h, { guests: [Z.toUpperCase(), 'Dana@Example.com', 'dana@example.com', 'Lee <lee@example.com>'] })
    expect(lastWrite(h).body.attendees).toEqual([{ email: 'dana@example.com' }, { email: 'lee@example.com' }])
  })

  test('shows in the calendar at once, as the store holds it: the agenda has it with its guests and Meet link, and the sync that follows confirms it and does not make a second', async () => {
    const h = await world()
    const got = await made(h)
    const before = await read(h)
    expect(before.events.map((e) => [e.id, e.title, e.busy, e.videoLink !== null, e.guests.map((g) => g.email)])).toEqual([
      [got.id, 'Planning', true, true, [Z, 'dana@example.com']],
    ])
    const told = h.told.n
    await h.work()
    const after = await read(h)
    expect(after.events.map((e) => e.id)).toEqual([got.id])
    expect(h.store.eventCount()).toBe(1)
    expect(told).toBeGreaterThan(0)
  })

  test('marks the calendar owed a read and asks for the alarm, so Google’s own copy confirms it', async () => {
    const h = await world()
    const alarms = h.alarms.length
    await made(h)
    expect(h.alarms.length).toBeGreaterThan(alarms)
    expect(h.rows<{ dirty: number }>(`SELECT dirty FROM calendar WHERE id = '${Z}|${Z}'`)[0]?.dirty).toBe(1)
  })

  test('is refused, with nothing sent to Google and nothing stored, for a field that is not an invite', async () => {
    const h = await world()
    const wrong: [string, Record<string, unknown>][] = [
      ['no title', { title: '' }],
      ['a title of spaces', { title: '   ' }],
      ['a title too long', { title: 'x'.repeat(301) }],
      ['an end before the start', { start: at(25), end: at(24) }],
      ['an event of no length', { start: at(24), end: at(24) }],
      ['an event longer than 36 hours', { start: at(24), end: at(24 + 37) }],
      ['a start that is not a moment', { start: 'tomorrow' }],
      ['guests that are not a list', { guests: 'dana@example.com' }],
      ['a guest that is not an address', { guests: ['dana'] }],
      ['more than fifty guests', { guests: Array.from({ length: 51 }, (_, i) => `g${i}@example.com`) }],
      ['a description that is not text', { description: 5 }],
      ['a Meet flag that is not true or false', { meet: 'yes' }],
      ['an em dash in the title', { title: 'Planning \u2014 Q4' }],
      ['an em dash in the description', { description: 'Notes \u2014 attached' }],
      ['a field an invite does not have', { reminders: 10 }],
      ['no account', { account: undefined }],
    ]
    for (const [what, over] of wrong) {
      const got = await h.engine.claudeInvite(invite(over))
      expect(got, what).toMatchObject({ ok: false, reason: 'bad-request' })
    }
    expect(h.google.writes).toEqual([])
    expect(h.store.eventCount()).toBe(0)
  })

  test('is refused for an account that is not connected, naming those that are', async () => {
    const h = await world()
    const got = await h.engine.claudeInvite(invite({ account: 'someone@example.com' }))
    expect(got).toMatchObject({ ok: false, reason: 'not-found' })
    expect(got.ok ? '' : got.error).toContain(Z)
    expect(h.google.writes).toEqual([])
  })

  test('is refused in the inbox’s own words for a grant that reads and cannot edit, and for a lapsed one: no write reaches Google and the store is as it was', async () => {
    const h = await world()
    h.google.account(Z).eventsRefusal = { why: 'no-events', message: `${Z} is connected without the permission to change events. Press Connect calendar in Settings, Calendars and accept it.` }
    const got = await h.engine.claudeInvite(invite())
    expect(got).toMatchObject({ ok: false, reason: 'conflict' })
    expect(got.ok ? '' : got.error).toContain('Press Connect calendar')
    h.google.account(Z).eventsRefusal = null
    h.google.account(F).refusal = { why: 'lapsed', message: `Google no longer accepts the saved sign-in for ${F}.` }
    expect(await h.engine.claudeInvite(invite({ account: F }))).toMatchObject({ ok: false, reason: 'conflict' })
    expect(h.google.writes).toEqual([])
    expect(h.store.eventCount()).toBe(0)
  })

  test('is refused where no writing client is wired', async () => {
    const h = await world({ writer: false })
    expect(await h.engine.claudeInvite(invite())).toMatchObject({ ok: false, reason: 'conflict' })
    expect(h.google.writes).toEqual([])
  })

  test('a refusal by Google (a bad request) is a refusal in Google’s words and stores nothing; a fault of Google’s is an error for the face to report as unknown', async () => {
    const h = await world()
    h.google.failNext('events.insert', 400, { error: { code: 400, message: 'The specified time range is empty.' } })
    const refused = await h.engine.claudeInvite(invite())
    expect(refused).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(refused.ok ? '' : refused.error).toContain('The specified time range is empty.')
    h.google.failNext('events.insert', 503, { error: { code: 503, message: 'Backend Error' } })
    await expect(h.engine.claudeInvite(invite())).rejects.toThrow('Backend Error')
    expect(h.store.eventCount()).toBe(0)
  })

  test('on an account whose primary calendar is hidden, the event is made at Google and not written into the store, and the answer says so', async () => {
    const h = await world()
    h.store.setShown(`${Z}|${Z}`, false)
    const got = await made(h)
    expect(got.stored).toBe(false)
    expect(h.store.eventCount()).toBe(0)
    expect(h.google.writes).toHaveLength(1)
  })
})

describe('the token for changing events', () => {
  test('is asked of the inbox for each write, at the events level, and never kept: two writes ask twice, and the sync’s token is never the one that writes', async () => {
    const h = await world()
    const asked = h.google.accessAsked.length
    await made(h)
    await made(h, { title: 'Second' })
    const mine = h.google.accessAsked.slice(asked)
    expect(mine.filter((x) => x.level === 'events')).toHaveLength(2)
    expect(h.google.writes.map((w) => w.level)).toEqual(['events', 'events'])
    // Every read the sync made carried a reading token, and every write an events one: the two never share.
    expect(h.google.bearers.filter((b) => b.startsWith('tok-events-')).length).toBe(2)
    h.advance(HOUR)
    await h.work()
    expect(h.google.accessAsked.filter((x) => x.level === 'events')).toHaveLength(2)
  })

  test('is in no answer, no error and no log line: a write that fails, one that is refused and one that succeeds leave no token anywhere a caller or the tail could read it', async () => {
    const h = await world()
    const error = spyOn(console, 'error').mockImplementation(() => undefined)
    const calendar = createInboxCalendar({ engine: h.api })
    h.google.failNext('events.insert', 503, { error: { code: 503, message: 'Backend Error' } })
    const failed = await calendar.invite({ account: Z, title: 'Planning', start: at(24), end: at(25), guests: [], description: null, meet: true })
    const refused = await calendar.invite({ account: Z, title: '', start: at(24), end: at(25), guests: [], description: null, meet: true })
    const done = await calendar.invite({ account: Z, title: 'Planning', start: at(24), end: at(25), guests: [], description: null, meet: true })
    const everything = JSON.stringify([failed, refused, done, error.mock.calls, h.logs])
    for (const bearer of h.google.bearers) expect(everything).not.toContain(bearer)
    expect(everything).not.toContain('tok-')
    expect(failed).toMatchObject({ ok: false, kind: 'failed', message: WRITE_FAULT })
    expect(refused).toMatchObject({ ok: false, kind: 'refused', reason: 'bad-request' })
    expect(done.ok).toBe(true)
    error.mockRestore()
  })
})

describe('a move', () => {
  test('is one patch to Google with the new times and the guests told, a token for calendar.events alone, and the store shows the new time at once', async () => {
    const h = await world()
    const event = await made(h)
    const got = await h.engine.claudeMove(event.id, { start: at(48), end: at(49) })
    expect(got.ok).toBe(true)
    const w = lastWrite(h)
    expect(w).toMatchObject({ op: 'events.patch', calendarId: Z, eventId: event.eventId, level: 'events', query: { sendUpdates: 'all' } })
    expect(Date.parse((w.body.start as { dateTime: string }).dateTime)).toBe(at(48))
    expect(Date.parse((w.body.end as { dateTime: string }).dateTime)).toBe(at(49))
    expect(Object.keys(w.body).sort()).toEqual(['end', 'start'])
    const after = await read(h)
    expect(after.events.map((e) => [e.id, e.start, e.end])).toEqual([[event.id, at(48), at(49)]])
  })

  test('is refused for what is not in the calendar, for a time that does not make sense and for an all-day event, with nothing sent', async () => {
    const h = await world()
    h.google.setEvent(Z, Z, { id: 'holiday', summary: 'Company day', startDate: '2026-11-20', endDate: '2026-11-21' })
    await sync(h)
    const event = await made(h)
    expect(await h.engine.claudeMove(`${Z}|${Z}|nope`, { start: at(48), end: at(49) })).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await h.engine.claudeMove('nonsense', { start: at(48), end: at(49) })).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await h.engine.claudeMove(event.id, { start: at(49), end: at(48) })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await h.engine.claudeMove(event.id, { start: at(48) })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await h.engine.claudeMove(event.id, { start: at(48), end: at(49), guests: [] })).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await h.engine.claudeMove(`${Z}|${Z}|holiday`, { start: at(48), end: at(49) })).toMatchObject({ ok: false, reason: 'bad-request' })
    // Only the invite itself reached Google.
    expect(h.google.writes.map((w) => w.op)).toEqual(['events.insert'])
  })

  test('is refused for an event another person organises, and moves the organiser’s own copy when the organiser is another of the owner’s accounts', async () => {
    const h = await world()
    // Dana organises this one: it is on Tessa's calendar as an invitation, so it is not hers to move.
    h.google.setEvent(Z, Z, { id: 'theirs', summary: 'Dana’s review', start: iso(at(5)), end: iso(at(6)), organizer: { email: 'dana@example.com' }, attendees: [{ email: Z, self: true, responseStatus: 'accepted' }] })
    // The owner organises this one from the Ashgrove account and invited the Northfield one: the same meeting is held twice.
    const own = await made(h, { account: F, title: 'Board prep', guests: [Z] })
    h.google.setEvent(Z, Z, { id: 'copy', iCalUID: `${own.eventId}@google.com`, summary: 'Board prep', start: iso(at(24)), end: iso(at(25)), organizer: { email: F }, attendees: [{ email: Z, self: true, responseStatus: 'accepted' }, { email: F, organizer: true, responseStatus: 'accepted' }] })
    await sync(h)
    const refused = await h.engine.claudeMove(`${Z}|${Z}|theirs`, { start: at(7), end: at(8) })
    expect(refused).toMatchObject({ ok: false, reason: 'conflict' })
    expect(refused.ok ? '' : refused.error).toContain('dana@example.com')
    // The id of the Northfield copy moves the Ashgrove one, which is the organiser's.
    const moved = await h.engine.claudeMove(`${Z}|${Z}|copy`, { start: at(30), end: at(31) })
    expect(moved).toMatchObject({ ok: true, value: { account: F, eventId: own.eventId } })
    expect(lastWrite(h)).toMatchObject({ op: 'events.patch', calendarId: F, eventId: own.eventId })
  })
})

describe('a cancellation', () => {
  test('is one delete to Google with the guests told, a token for calendar.events alone, and the event is gone from the store at once', async () => {
    const h = await world()
    const event = await made(h)
    const got = await h.engine.claudeCancel(event.id)
    expect(got).toMatchObject({ ok: true, value: { id: event.id, eventId: event.eventId, account: Z, title: 'Planning' } })
    expect(lastWrite(h)).toMatchObject({ op: 'events.delete', calendarId: Z, eventId: event.eventId, level: 'events', query: { sendUpdates: 'all' } })
    expect((await read(h)).events).toEqual([])
    // The read that follows finds Google's cancelled event and removes nothing more.
    await h.work()
    expect(h.store.eventCount()).toBe(0)
  })

  test('is refused for an event that is not in the calendar and for one another person organises; an event Google already deleted counts as cancelled', async () => {
    const h = await world()
    h.google.setEvent(Z, Z, { id: 'theirs', summary: 'Dana’s review', start: iso(at(5)), end: iso(at(6)), organizer: { email: 'dana@example.com' } })
    await sync(h)
    expect(await h.engine.claudeCancel(`${Z}|${Z}|nope`)).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await h.engine.claudeCancel(`${Z}|${Z}|theirs`)).toMatchObject({ ok: false, reason: 'conflict' })
    expect(h.google.writes).toEqual([])
    const event = await made(h)
    h.google.cancelEvent(Z, Z, event.eventId)
    expect(await h.engine.claudeCancel(event.id)).toMatchObject({ ok: true })
  })
})

describe('the inbox’s face of the calendar', () => {
  test('has exactly the contract’s methods, reads, and answers a fault in words that never carry Google’s text', async () => {
    const h = await world()
    const error = spyOn(console, 'error').mockImplementation(() => undefined)
    const calendar = createInboxCalendar({ engine: h.api })
    expect(Object.keys(calendar).sort()).toEqual([...CALENDAR_FOR_INBOX_METHODS].sort())
    h.google.failNext('events.insert', 500, { error: { code: 500, message: 'a sentence of Google’s' } })
    const failed = await calendar.invite({ account: Z, title: 'Planning', start: at(24), end: at(25), guests: [], description: null, meet: true })
    expect(failed).toEqual({ ok: false, kind: 'failed', reason: 'broken', message: WRITE_FAULT })
    expect(JSON.stringify(failed)).not.toContain('Google’s')
    expect(await calendar.events(T0, T0 + DAY)).toMatchObject({ ok: true })
    // A read that throws is answered in its own words, with nothing changed.
    const broken = createInboxCalendar({ engine: { call: () => Promise.reject(new Error('the object was reset')) } })
    expect(await broken.events(T0, T0 + DAY)).toEqual({ ok: false, kind: 'failed', reason: 'broken', message: READ_FAULT })
    error.mockRestore()
  })
})

describe('what an invite and a move are read as', () => {
  test('the invite’s shape: the fields it has, nothing else, and the defaults', () => {
    expect(readInvite({ account: 'Tessa@Northfield.example', title: ' Planning ', start: at(1), end: at(2), guests: [] })).toEqual({
      ok: true,
      value: { account: Z, title: 'Planning', start: at(1), end: at(2), guests: [], description: null, meet: true },
    })
    expect(readInvite([])).toMatchObject({ ok: false })
    expect(readInvite(null)).toMatchObject({ ok: false })
    expect(readMove({ start: at(1), end: at(2) })).toEqual({ ok: true, value: { start: at(1), end: at(2) } })
    expect(readMove({ start: 1.5, end: 2 })).toMatchObject({ ok: false })
  })
})
