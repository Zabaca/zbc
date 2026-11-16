import { describe, expect, test } from 'bun:test'
import {
  answered,
  type CalendarClaudeAgenda,
  type CalendarEventCancelled,
  type CalendarEventMade,
  type CalendarForInbox,
  isoAt,
  refused,
  failed as theCalendarFailed,
} from '@space/workspace'
import { type CliIo, runCli } from '../scripts/cli'
import { agendaOut, momentOf, TIME_WORDS } from '../src/claude-calendar'
import type { CalendarWrite } from '../src/types'
import { bundledInstall } from '../src/workspace'
import { AGENT, AGENT_ID, harness, OWNER } from '../test-support/harness'
import { ownerRequest } from '../test-support/owner-requests'
import { CLIENT_ID, CLIENT_SECRET, throughSpace } from '../test-support/space-door'

/**
 * Claude and the calendar (the space's ADR 0023), through the inbox's router and Claude's script, over the real store and a stand-in for the calendar's face (which is proven in packages/calendar/test/writes.test.ts against a fake Google).
 * The point of this file is the RULE: an invite, a move and a cancellation are refused without the owner's instruction and while the owner's switch is off (which is how it ships), and the calendar is not asked at all; an accepted
 * one is recorded with its instruction BEFORE the calendar is asked and again with what came of it, and the owner can read every one back. And the read: the free time, from the calendar's store, with nothing asked of Google.
 */

type H = ReturnType<typeof harness>

const AGENT_ACTOR = `agent:${AGENT_ID}`
const ZONE = bundledInstall.company.timeZone
const Z = 'tessa@northfield.example'
const KEY = `${Z}|${Z}|abc123`
/** What the owner said, as Claude records it: before the harness clock (2026-10-20T12:00Z), inside the five minutes of skew a time may be ahead. */
const SAID = { text: 'put Dana on Thursday at 10', where: 'session main', at: '2026-10-20T11:59:00Z' }
const WHEN = { start: '2026-11-19T10:00:00-08:00', end: '2026-11-19T10:30:00-08:00' }
const INVITE = { account: Z, title: 'Planning', ...WHEN, guests: ['dana@example.com'] }
const ms = (iso: string) => Date.parse(iso)

const made = (over: Partial<CalendarEventMade> = {}): CalendarEventMade => ({
  id: KEY,
  eventId: 'abc123',
  account: Z,
  title: 'Planning',
  start: ms(WHEN.start),
  end: ms(WHEN.end),
  guests: ['dana@example.com'],
  link: 'https://www.google.com/calendar/event?eid=abc123',
  meetLink: 'https://meet.example/abc123',
  stored: true,
  ...over,
})

const agenda = (): CalendarClaudeAgenda => ({
  from: ms('2026-11-17T08:00:00Z'),
  to: ms('2026-11-24T08:00:00Z'),
  accounts: [{ address: Z, label: 'northfield', state: 'live', reason: null, canEdit: true }],
  events: [
    {
      id: KEY,
      title: 'Standup',
      start: ms('2026-11-18T17:00:00Z'),
      end: ms('2026-11-18T17:30:00Z'),
      allDay: false,
      startDate: null,
      endDate: null,
      location: null,
      videoLink: null,
      htmlLink: 'https://www.google.com/calendar/event?eid=x',
      description: 'untrusted text the read leaves out',
      status: 'confirmed',
      response: 'accepted',
      organizer: { name: null, email: Z },
      guests: [{ name: 'Dana', email: 'dana@example.com', response: 'accepted', organizer: false, self: false }],
      guestsLeft: 0,
      accounts: [{ address: Z, label: 'northfield', hue: 0 }],
      free: false,
      readAt: 1,
      stale: false,
      busy: true,
    },
  ],
})

/** A stand-in for the calendar's inbox face that records what it was asked and answers what a test says. */
function calendar() {
  const calls: { method: string; args: unknown[] }[] = []
  const next: { reply: unknown } = { reply: undefined }
  const answer = <T>(fallback: T) => {
    const r = next.reply
    next.reply = undefined
    if (r instanceof Error) throw r
    return (r ?? answered(fallback)) as never
  }
  /** Record the call, then answer what the test set (once) or the usual. */
  const ask = <T>(method: string, args: unknown[], fallback: T) => {
    calls.push({ method, args })
    return answer(fallback)
  }
  const cancelled: CalendarEventCancelled = { id: KEY, eventId: 'abc123', account: Z, title: 'Planning' }
  const moved = made({ start: ms('2026-11-20T10:00:00-08:00'), end: ms('2026-11-20T10:30:00-08:00') })
  const face: CalendarForInbox = {
    events: async (...args) => ask('events', args, agenda()),
    invite: async (...args) => ask('invite', args, made()),
    move: async (...args) => ask('move', args, moved),
    cancel: async (...args) => ask('cancel', args, cancelled),
  }
  return { face, calls, next }
}

function world() {
  const c = calendar()
  const h = harness({ calendar: () => c.face })
  return { h, ...c }
}

/** The owner turns Claude's sending on, as the page does. */
async function allow(h: H, enabled = true) {
  const res = await ownerRequest(h, 'PUT', '/api/settings/claude-sending', { enabled })
  expect(res.status, JSON.stringify(res.json)).toBe(200)
}

const post = (h: H, path: string, body: Record<string, unknown>) => h.request(AGENT, 'POST', path, body)
const audit = async (h: H) =>
  (await h.request(AGENT, 'GET', '/api/audit')).json as {
    action: string
    actor: string
    subject: string
    before: unknown
    after: any
  }[]
const calendarAudit = async (h: H) => (await audit(h)).filter((a) => a.action.startsWith('calendar.'))
const writes = async (h: H) => (await h.request(AGENT, 'GET', '/api/calendar/writes')).json as CalendarWrite[]

describe('the rule: the owner’s instruction and the owner’s switch', () => {
  test('an invite, a move and a cancellation are refused while the switch is off (how it ships), and the calendar is not asked', async () => {
    const { h, calls } = world()
    for (const [path, body] of [
      ['/api/calendar/invite', { ...INVITE, instruction: SAID }],
      [`/api/calendar/events/${encodeURIComponent(KEY)}/move`, { ...WHEN, instruction: SAID }],
      [`/api/calendar/events/${encodeURIComponent(KEY)}/cancel`, { instruction: SAID }],
    ] as const) {
      const res = await post(h, path, body)
      expect(res.status, path).toBe(403)
      expect(res.json.error).toContain('switched off')
      expect(res.json.error).toContain('no event was made, moved or cancelled')
    }
    expect(calls).toEqual([])
    expect(await calendarAudit(h)).toEqual([])
  })

  test('with the switch on, a call with no instruction, or one with no words, is refused, and the calendar is not asked', async () => {
    const { h, calls } = world()
    await allow(h)
    for (const instruction of [
      undefined,
      null,
      'send it',
      [],
      {},
      { text: '', where: 'session main', at: SAID.at },
      { text: '   ', where: 'x', at: SAID.at },
    ]) {
      const res = await post(h, '/api/calendar/invite', {
        ...INVITE,
        ...(instruction !== undefined && { instruction }),
      })
      expect(res.status, JSON.stringify(instruction)).toBe(403)
      expect(res.json.error).toContain('carries no instruction')
    }
    expect(calls).toEqual([])
    expect(await calendarAudit(h)).toEqual([])
  })

  test('an instruction is the owner’s words, where and when, and the place is never the inbox: each gap is refused and nothing is asked', async () => {
    const { h, calls } = world()
    await allow(h)
    const refusals: [string, Record<string, unknown>, number][] = [
      ['no place', { ...SAID, where: '' }, 422],
      ['the inbox as the place', { ...SAID, where: 'the inbox' }, 403],
      ['no time', { ...SAID, at: '' }, 422],
      ['a time that is not a time', { ...SAID, at: 'yesterday' }, 422],
      ['a time in the future', { ...SAID, at: '2027-01-01T00:00:00Z' }, 422],
      ['a transcript, not the words', { ...SAID, text: 'x'.repeat(2001) }, 422],
    ]
    for (const [what, instruction, status] of refusals) {
      expect((await post(h, '/api/calendar/invite', { ...INVITE, instruction })).status, what).toBe(status)
    }
    expect(calls).toEqual([])
  })

  test('the owner turning the switch back off stops the next one; only the owner flips it', async () => {
    const { h, calls } = world()
    await allow(h)
    expect((await post(h, '/api/calendar/invite', { ...INVITE, instruction: SAID })).status).toBe(201)
    await allow(h, false)
    expect((await post(h, '/api/calendar/invite', { ...INVITE, instruction: SAID })).status).toBe(403)
    expect(calls.map((c) => c.method)).toEqual(['invite'])
    // Claude has no way to flip it.
    expect((await h.request(AGENT, 'PUT', '/api/settings/claude-sending', { enabled: true })).status).toBe(404)
  })

  test('the store itself refuses anyone but Claude’s actor, so no other route could make one', async () => {
    const { h } = world()
    await allow(h)
    const call = h.store.call as unknown as (m: string, ...a: unknown[]) => Promise<{ ok: boolean; status?: number }>
    expect(await call('beginCalendarWrite', 'invite', SAID, Z, {}, h.owner.email)).toMatchObject({
      ok: false,
      status: 403,
    })
    expect(await call('beginCalendarWrite', 'invite', SAID, Z, {}, 'dana@northfield.example')).toMatchObject({
      ok: false,
      status: 403,
    })
    expect(await call('noteCalendarWrite', 'invite', 1, { state: 'done', result: {} }, h.owner.email)).toMatchObject({
      ok: false,
      status: 403,
    })
    expect(await calendarAudit(h)).toEqual([])
  })
})

describe('an invite, as the owner said it', () => {
  test('is handed to the calendar as the invite and nothing else (the instruction stays here), with the times as moments, and answered with the event, its link and its Meet link on the company’s clock', async () => {
    const { h, calls } = world()
    await allow(h)
    const res = await post(h, '/api/calendar/invite', {
      ...INVITE,
      description: 'Agenda to follow.',
      instruction: SAID,
    })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(calls).toEqual([
      {
        method: 'invite',
        args: [
          {
            account: Z,
            title: 'Planning',
            start: ms(WHEN.start),
            end: ms(WHEN.end),
            guests: ['dana@example.com'],
            description: 'Agenda to follow.',
          },
        ],
      },
    ])
    expect(res.json).toEqual({
      id: KEY,
      eventId: 'abc123',
      account: Z,
      title: 'Planning',
      start: '2026-11-19T10:00:00-08:00',
      end: '2026-11-19T10:30:00-08:00',
      guests: ['dana@example.com'],
      link: 'https://www.google.com/calendar/event?eid=abc123',
      meetLink: 'https://meet.example/abc123',
      stored: true,
    })
  })

  test('is on the record with its instruction BEFORE the calendar is asked, and again with what came of it; the owner reads every one back', async () => {
    const stand = calendar()
    const askedWhen: { action: string }[] = []
    // While the calendar is being asked, the request is already in the audit: a write whose outcome is lost still has its record.
    const inspecting: CalendarForInbox = {
      ...stand.face,
      invite: async (input) => {
        askedWhen.push(...(await calendarAudit(h2)))
        return stand.face.invite(input)
      },
    }
    const h2 = harness({ calendar: () => inspecting })
    await allow(h2)
    const res = await post(h2, '/api/calendar/invite', { ...INVITE, instruction: SAID })
    expect(res.status).toBe(201)
    expect(askedWhen.map((a) => a.action)).toEqual(['calendar.invite'])
    const entries = await calendarAudit(h2)
    expect(entries.map((a) => [a.action, a.actor, a.subject])).toEqual([
      ['calendar.invite-done', AGENT_ACTOR, `calendar:${Z}`],
      ['calendar.invite', AGENT_ACTOR, `calendar:${Z}`],
    ])
    expect(entries[1]?.after).toMatchObject({
      instruction: { text: SAID.text, where: SAID.where, at: '2026-10-20T11:59:00.000Z' },
      request: {
        account: Z,
        title: 'Planning',
        start: '2026-11-19T10:00:00-08:00',
        end: '2026-11-19T10:30:00-08:00',
        guests: ['dana@example.com'],
        meet: true,
      },
    })
    const listed = await writes(h2)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      kind: 'invite',
      subject: Z,
      instruction: { text: SAID.text },
      outcome: { state: 'done', result: { eventId: 'abc123' } },
    })
  })

  test('a Meet link asked for and not yet attached says so; one not asked for says nothing', async () => {
    const { h, next } = world()
    await allow(h)
    next.reply = answered(made({ meetLink: null }))
    const waiting = await post(h, '/api/calendar/invite', { ...INVITE, instruction: SAID })
    expect(waiting.json.meetLink).toBeNull()
    expect(waiting.json.note).toContain('No Meet link yet')
    next.reply = answered(made({ meetLink: null }))
    const without = await post(h, '/api/calendar/invite', { ...INVITE, meet: false, instruction: SAID })
    expect(without.json.note).toBeUndefined()
  })

  test('a field that is not an invite, or a time with no offset, is refused at the door before the rule: nothing is asked and nothing is recorded', async () => {
    const { h, calls } = world()
    await allow(h)
    for (const body of [
      { ...INVITE, reminders: 10, instruction: SAID },
      { ...INVITE, start: '2026-11-19T10:00:00', instruction: SAID },
      { ...INVITE, end: 'tomorrow', instruction: SAID },
      { ...INVITE, start: undefined, instruction: SAID },
    ]) {
      const res = await post(h, '/api/calendar/invite', body)
      expect(res.status).toBe(422)
    }
    expect(
      (await post(h, '/api/calendar/invite', { ...INVITE, start: '2026-11-19T10:00:00', instruction: SAID })).json
        .error,
    ).toBe(TIME_WORDS)
    expect(calls).toEqual([])
    expect(await calendarAudit(h)).toEqual([])
  })
})

describe('a move and a cancellation', () => {
  test('are handed on by the event’s key (encoded in the path, and decoded), each recorded with its instruction and its outcome', async () => {
    const { h, calls } = world()
    await allow(h)
    const moved = await post(h, `/api/calendar/events/${encodeURIComponent(KEY)}/move`, {
      start: '2026-11-20T10:00:00-08:00',
      end: '2026-11-20T10:30:00-08:00',
      instruction: SAID,
    })
    expect(moved.status, JSON.stringify(moved.json)).toBe(200)
    expect(moved.json).toMatchObject({ id: KEY, start: '2026-11-20T10:00:00-08:00' })
    const cancelled = await post(h, `/api/calendar/events/${encodeURIComponent(KEY)}/cancel`, { instruction: SAID })
    expect(cancelled.status).toBe(200)
    expect(cancelled.json).toEqual({ cancelled: true, id: KEY, eventId: 'abc123', account: Z, title: 'Planning' })
    expect(calls).toEqual([
      { method: 'move', args: [KEY, { start: ms('2026-11-20T10:00:00-08:00'), end: ms('2026-11-20T10:30:00-08:00') }] },
      { method: 'cancel', args: [KEY] },
    ])
    expect((await writes(h)).map((w) => [w.kind, w.subject, w.outcome?.state])).toEqual([
      ['cancel', KEY, 'done'],
      ['move', KEY, 'done'],
    ])
  })

  test('an id that is not an event’s key is not found, and more than a move or a cancellation carries is refused, before anything is asked', async () => {
    const { h, calls } = world()
    await allow(h)
    expect(
      (await post(h, `/api/calendar/events/${encodeURIComponent('../../x y')}/cancel`, { instruction: SAID })).status,
    ).toBe(404)
    expect(
      (
        await post(h, `/api/calendar/events/${encodeURIComponent(KEY)}/move`, {
          ...WHEN,
          guests: [],
          instruction: SAID,
        })
      ).status,
    ).toBe(422)
    expect(
      (await post(h, `/api/calendar/events/${encodeURIComponent(KEY)}/cancel`, { notify: false, instruction: SAID }))
        .status,
    ).toBe(422)
    expect(calls).toEqual([])
  })
})

describe('what the calendar says back', () => {
  test('a refusal is answered under its own status and recorded as refused; a fault, or no answer, as an outcome nobody knows, and says to look before trying again', async () => {
    const { h, next } = world()
    await allow(h)
    next.reply = refused(
      'conflict',
      `${Z} is connected without the permission to change events. Press Connect calendar in Settings, Calendars and accept it.`,
    )
    const conflict = await post(h, '/api/calendar/invite', { ...INVITE, instruction: SAID })
    expect(conflict.status).toBe(409)
    expect(conflict.json.error).toContain('Press Connect calendar')
    next.reply = refused('not-found', 'x is not a connected Google account.')
    expect((await post(h, '/api/calendar/invite', { ...INVITE, instruction: SAID })).status).toBe(404)
    next.reply = refused('bad-request', 'The end must be after the start.')
    expect((await post(h, '/api/calendar/invite', { ...INVITE, instruction: SAID })).status).toBe(422)
    next.reply = theCalendarFailed(
      'The calendar could not tell whether Google did that. Read `calendar events` before trying again: it may have been done.',
    )
    const fault = await post(h, '/api/calendar/invite', { ...INVITE, instruction: SAID })
    expect(fault.status).toBe(502)
    next.reply = new Error('the object was reset')
    const lost = await post(h, '/api/calendar/invite', { ...INVITE, instruction: SAID })
    expect(lost.status).toBe(502)
    expect(lost.json.error).toContain('Read `calendar events` before trying again')
    expect(lost.json.error).not.toContain('reset')
    expect((await writes(h)).map((w) => w.outcome?.state)).toEqual([
      'unknown',
      'unknown',
      'refused',
      'refused',
      'refused',
    ])
  })

  test('where the Worker has no calendar, every route says it is not connected, asks nothing and records nothing', async () => {
    const h = harness()
    await allow(h)
    expect((await post(h, '/api/calendar/invite', { ...INVITE, instruction: SAID })).status).toBe(503)
    expect((await h.request(AGENT, 'GET', '/api/calendar/events?from=2026-11-17&to=2026-11-18')).status).toBe(503)
    expect(await calendarAudit(h)).toEqual([])
  })
})

describe('the free time', () => {
  test('is the calendar’s events between two times, on the company’s clock with its offset, each with whether it blocks the owner’s time and who answered; a description is left out', async () => {
    const { h, calls } = world()
    const res = await h.request(
      AGENT,
      'GET',
      `/api/calendar/events?from=${encodeURIComponent('2026-11-17T00:00:00-08:00')}&to=${encodeURIComponent('2026-11-24T00:00:00-08:00')}`,
    )
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(calls).toEqual([
      { method: 'events', args: [ms('2026-11-17T00:00:00-08:00'), ms('2026-11-24T00:00:00-08:00')] },
    ])
    expect(res.json).toMatchObject({
      zone: ZONE,
      accounts: [{ address: Z, state: 'live', canEdit: true }],
      events: [
        {
          id: KEY,
          title: 'Standup',
          start: '2026-11-18T09:00:00-08:00',
          end: '2026-11-18T09:30:00-08:00',
          allDay: false,
          accounts: [Z],
          busy: true,
          free: false,
          response: 'accepted',
          guests: [{ name: 'Dana', email: 'dana@example.com', response: 'accepted', organizer: false, self: false }],
        },
      ],
    })
    expect(JSON.stringify(res.json)).not.toContain('untrusted text')
  })

  test('takes a day as that day’s midnight on the company’s clock, and refuses a time with no offset or a range that is not one', async () => {
    const { h, calls } = world()
    expect((await h.request(AGENT, 'GET', '/api/calendar/events?from=2026-11-17&to=2026-11-24')).status).toBe(200)
    expect(calls[0]?.args).toEqual([ms('2026-11-17T00:00:00-08:00'), ms('2026-11-24T00:00:00-08:00')])
    for (const q of [
      '',
      '?from=2026-11-17',
      '?from=2026-11-17T09:00:00&to=2026-11-18',
      '?from=soon&to=later',
      '?from=2026-02-30&to=2026-03-02',
    ]) {
      const res = await h.request(AGENT, 'GET', `/api/calendar/events${q}`)
      expect(res.status, q).toBe(422)
    }
    expect(calls).toHaveLength(1)
  })

  test('needs no switch and no instruction: it is a read, and it asks the calendar’s store, never Google', async () => {
    const { h } = world()
    expect((await h.request(AGENT, 'GET', '/api/calendar/events?from=2026-11-17&to=2026-11-18')).status).toBe(200)
    expect((await h.request(AGENT, 'GET', '/api/calendar/writes')).status).toBe(200)
  })

  test('the moments of the clock: an offset, Z, a day, and nothing else', () => {
    expect(momentOf('2026-11-17T09:30:00-08:00', ZONE)).toBe(Date.UTC(2026, 10, 17, 17, 30))
    expect(momentOf('2026-11-17T17:30Z', ZONE)).toBe(Date.UTC(2026, 10, 17, 17, 30))
    expect(momentOf('2026-11-17', ZONE)).toBeNull()
    expect(momentOf('2026-11-17', ZONE, true)).toBe(Date.UTC(2026, 10, 17, 8, 0))
    expect(momentOf('2026-07-17', ZONE, true)).toBe(Date.UTC(2026, 6, 17, 7, 0))
    for (const bad of [5, null, '', 'tomorrow', '2026-11-17T09:30:00', '2026-13-01', '2026-02-30'])
      expect(momentOf(bad, ZONE, true)).toBeNull()
    expect(isoAt(Date.UTC(2026, 10, 17, 17, 30), ZONE)).toBe('2026-11-17T09:30:00-08:00')
    expect(isoAt(Date.UTC(2026, 6, 17, 17, 30), ZONE)).toBe('2026-07-17T10:30:00-07:00')
    expect(agendaOut({ ...agenda(), events: [] }, ZONE).from).toBe('2026-11-17T00:00:00-08:00')
  })
})

describe('the script', () => {
  const DOOR_URL = bundledInstall.agentDoor()?.url ?? 'no door'

  function script(h: H, files: Record<string, string> = {}) {
    const door = throughSpace(h)
    const requests: { method: string; url: string; body: string }[] = []
    const io: CliIo = {
      env: { INBOX_URL: DOOR_URL, INBOX_ACCESS_CLIENT_ID: CLIENT_ID, INBOX_ACCESS_CLIENT_SECRET: CLIENT_SECRET },
      sopsKey: () => {
        throw new Error('sops must not be called when the env is set')
      },
      readInput: async (spec) => (spec.startsWith('@') ? (files[spec.slice(1)] ?? '') : spec),
      fetch: (url, init) => {
        requests.push({ method: init.method ?? 'GET', url, body: String(init.body ?? '') })
        return door.fetch(url, init)
      },
    }
    return { run: (...argv: string[]) => runCli(argv, io), requests }
  }

  test('every command asks the path under the door that it should, and answers the router’s own words', async () => {
    const { h } = world()
    await allow(h)
    const { run, requests } = script(h)
    const events = await run('calendar', 'events', '2026-11-17', '2026-11-24')
    expect(events.exitCode).toBe(0)
    expect(JSON.parse(events.output).events[0].title).toBe('Standup')
    const invite = await run('calendar', 'invite', JSON.stringify({ ...INVITE, instruction: SAID }))
    expect(invite.exitCode, invite.output).toBe(0)
    expect(JSON.parse(invite.output)).toMatchObject({ id: KEY, meetLink: 'https://meet.example/abc123' })
    await run('calendar', 'move', KEY, JSON.stringify({ ...WHEN, instruction: SAID }))
    await run('calendar', 'cancel', KEY, JSON.stringify({ instruction: SAID }))
    const listed = await run('calendar', 'writes')
    expect(JSON.parse(listed.output).map((w: CalendarWrite) => w.kind)).toEqual(['cancel', 'move', 'invite'])
    expect(requests.map((r) => `${r.method} ${r.url.replace(DOOR_URL, '')}`)).toEqual([
      'GET /api/calendar/events?from=2026-11-17&to=2026-11-24',
      'POST /api/calendar/invite',
      `POST /api/calendar/events/${encodeURIComponent(KEY)}/move`,
      `POST /api/calendar/events/${encodeURIComponent(KEY)}/cancel`,
      'GET /api/calendar/writes',
    ])
  })

  test('a write with no instruction makes no request at all, and one with the switch off is the inbox’s 403', async () => {
    const { h, calls } = world()
    const { run, requests } = script(h)
    for (const argv of [
      ['calendar', 'invite', JSON.stringify(INVITE)],
      ['calendar', 'invite', JSON.stringify({ ...INVITE, instruction: { text: 'x', where: '', at: SAID.at } })],
      ['calendar', 'move', KEY, JSON.stringify(WHEN)],
      ['calendar', 'cancel', KEY, '{}'],
      ['calendar', 'invite', '[]'],
      ['calendar', 'invite', 'not json'],
    ]) {
      const res = await run(...argv)
      expect(res.exitCode, argv.join(' ')).toBe(1)
    }
    expect(requests).toEqual([])
    const off = await run('calendar', 'invite', JSON.stringify({ ...INVITE, instruction: SAID }))
    expect(off.exitCode).toBe(1)
    expect(off.output).toContain('403')
    expect(off.output).toContain('switched off')
    expect(calls).toEqual([])
  })

  test('the usage lists the commands, and a calendar command that is not one is told what they are', async () => {
    const { h } = world()
    const { run } = script(h)
    const none = await run('calendar')
    expect(none.exitCode).toBe(1)
    expect(none.output).toContain('calendar takes events, invite, move, cancel or writes')
    expect((await run('calendar', 'events', '2026-11-17')).output).toContain('missing to')
    const usage = (await run('nothing')).output
    for (const line of [
      'calendar events <from> <to>',
      'calendar invite <@file|-|json>',
      'calendar move <event-id>',
      'calendar cancel <event-id>',
      'calendar writes',
    ])
      expect(usage).toContain(line)
  })

  test('a person’s assertion on Claude’s door is refused, and there is no way to answer an invitation: the script’s commands are the three writes and the two reads', async () => {
    const { h, calls } = world()
    await allow(h)
    expect((await h.request(OWNER, 'POST', '/api/calendar/invite', { ...INVITE, instruction: SAID })).status).toBe(403)
    expect((await h.request(AGENT, 'POST', '/api/calendar/answer', {})).status).toBe(404)
    expect((await h.request(AGENT, 'POST', '/api/calendar/events/x/respond', {})).status).toBe(404)
    expect(calls).toEqual([])
  })
})
