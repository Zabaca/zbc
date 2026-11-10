import { describe, expect, test } from 'bun:test'
import {
  CalendarAccessError,
  CalendarError,
  CalendarGone,
  CalendarNotFound,
  CalendarRefused,
  CHANNEL_TTL_SECONDS,
  createCalendarGoogle,
} from '../src/google'

/**
 * The real Google module against a fake `fetch`: which URLs it calls, what it sends, how it turns Google's refusals into the errors the sync acts on, and that it asks for nothing but reading. The answers are the
 * documented shapes (developers.google.com/workspace/calendar/api/v3/reference).
 */

interface Seen {
  method: string
  url: URL
  headers: Headers
  body: string
}

function google(answers: (Response | Error)[]) {
  const seen: Seen[] = []
  const queue = [...answers]
  const accessAsked: boolean[] = []
  let n = 0
  const api = createCalendarGoogle({
    fetch: async (url, init = {}) => {
      seen.push({ method: init.method ?? 'GET', url: new URL(url), headers: new Headers(init.headers), body: init.body === undefined ? '' : String(init.body) })
      const next = queue.shift()
      if (!next) throw new Error(`unexpected request to ${url}`)
      if (next instanceof Error) throw next
      return next
    },
    access: async (_address, fresh) => {
      accessAsked.push(fresh)
      n += 1
      return { ok: true, accessToken: `access-${n}`, expiresAt: 10_000_000 }
    },
    now: () => 1_000_000,
  })('tessa@northfield.example')
  return { api, seen, accessAsked }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('what it asks Google', () => {
  test('a full read of events asks for a window, expanded, with the id in the path encoded; an incremental read sends the token and no window', async () => {
    const { api, seen } = google([json({ items: [{ id: 'a' }], nextSyncToken: 'T1' }), json({ items: [], nextSyncToken: 'T2' })])
    const full = await api.listEvents('en.usa#holiday@group.v.calendar.google.com', { timeMin: Date.parse('2026-10-01T00:00:00Z'), timeMax: Date.parse('2027-05-01T00:00:00Z') })
    expect(full).toEqual({ items: [{ id: 'a' }], next: null, syncToken: 'T1' })
    expect(seen[0]?.url.pathname).toBe('/calendar/v3/calendars/en.usa%23holiday%40group.v.calendar.google.com/events')
    expect(Object.fromEntries(seen[0]?.url.searchParams ?? [])).toEqual({ singleEvents: 'true', maxResults: '2500', timeMin: '2026-10-01T00:00:00.000Z', timeMax: '2027-05-01T00:00:00.000Z' })
    await api.listEvents('c', { syncToken: 'T1', timeMin: 1, timeMax: 2 })
    expect(Object.fromEntries(seen[1]?.url.searchParams ?? [])).toEqual({ singleEvents: 'true', maxResults: '2500', syncToken: 'T1' })
  })

  test('the calendar list is read with hidden entries; a read by token also shows the deleted ones', async () => {
    const { api, seen } = google([json({ items: [] }), json({ items: [] })])
    await api.listCalendars(null, null)
    await api.listCalendars('LT', 'P2')
    expect(Object.fromEntries(seen[0]?.url.searchParams ?? [])).toEqual({ maxResults: '250', showHidden: 'true' })
    expect(Object.fromEntries(seen[1]?.url.searchParams ?? [])).toEqual({ maxResults: '250', showHidden: 'true', syncToken: 'LT', showDeleted: 'true', pageToken: 'P2' })
  })

  test('a push channel is asked for as a web hook to the address, with the secret and a seven day life, and the answer is kept', async () => {
    const { api, seen } = google([json({ kind: 'api#channel', resourceId: 'res', expiration: '1762400000000' }), json({ resourceId: 'res2', expiration: '1762400000001' })])
    const events = await api.watchEvents('c@x.example', { id: 'id-1', token: 'secret', address: 'https://inbox-push.northfield.example/calendar/push' })
    expect(events).toEqual({ resourceId: 'res', expiration: 1762400000000 })
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.url.pathname).toBe('/calendar/v3/calendars/c%40x.example/events/watch')
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ id: 'id-1', type: 'web_hook', address: 'https://inbox-push.northfield.example/calendar/push', token: 'secret', params: { ttl: String(CHANNEL_TTL_SECONDS) } })
    expect(CHANNEL_TTL_SECONDS).toBe(604_800)
    await api.watchCalendarList({ id: 'id-2', token: 's', address: 'https://inbox-push.northfield.example/calendar/push' })
    expect(seen[1]?.url.pathname).toBe('/calendar/v3/users/me/calendarList/watch')
  })

  test('an answer that names no channel to keep is an error, not a channel', async () => {
    const { api } = google([json({ kind: 'api#channel' })])
    await expect(api.watchEvents('c', { id: 'x', token: 't', address: 'https://a.example/p' })).rejects.toBeInstanceOf(CalendarError)
  })

  test('stopping a channel names its id and resource; one already gone is as good as stopped', async () => {
    const { api, seen } = google([new Response(null, { status: 204 }), json({ error: { code: 404, message: 'Channel not found' } }, 404)])
    await api.stopChannel('id-1', 'res-1')
    expect(seen[0]?.url.pathname).toBe('/calendar/v3/channels/stop')
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ id: 'id-1', resourceId: 'res-1' })
    await api.stopChannel('id-2', 'res-2')
  })

  test('it only reads: no request is anything but a GET of the list and events, a POST to watch, or a POST to stop', async () => {
    const { api, seen } = google([json({ items: [] }), json({ items: [] }), json({ resourceId: 'r', expiration: '1' }), json({ resourceId: 'r', expiration: '1' }), new Response(null, { status: 204 })])
    await api.listCalendars(null, null)
    await api.listEvents('c', {})
    await api.watchEvents('c', { id: 'a', token: 't', address: 'https://a.example/p' })
    await api.watchCalendarList({ id: 'b', token: 't', address: 'https://a.example/p' })
    await api.stopChannel('a', 'r')
    expect(seen.map((s) => `${s.method} ${s.url.pathname.replace('/calendar/v3', '')}`)).toEqual([
      'GET /users/me/calendarList',
      'GET /calendars/c/events',
      'POST /calendars/c/events/watch',
      'POST /users/me/calendarList/watch',
      'POST /channels/stop',
    ])
  })
})

describe('how it reads Google’s refusals', () => {
  test('410 is a stale token, 404 is a calendar that is not there', async () => {
    const stale = google([json({ error: { code: 410, message: 'Gone' } }, 410)])
    await expect(stale.api.listEvents('c', { syncToken: 'x' })).rejects.toBeInstanceOf(CalendarGone)
    const missing = google([json({ error: { code: 404, message: 'Not Found' } }, 404)])
    await expect(missing.api.listEvents('c', {})).rejects.toBeInstanceOf(CalendarNotFound)
  })

  test('a 403 for a missing permission is its own error; a 403 for a rate limit, a 429 and a 500 are plain ones that carry Google’s words', async () => {
    const scope = google([json({ error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } }, 403)])
    await expect(scope.api.listCalendars(null, null)).rejects.toBeInstanceOf(CalendarRefused)
    const rate = google([json({ error: { code: 403, message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } }, 403)])
    const caught = await rate.api.listCalendars(null, null).catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(CalendarError)
    expect(caught).not.toBeInstanceOf(CalendarRefused)
    expect((caught as Error).message).toContain('Rate Limit Exceeded')
    const limited = google([json({ error: { message: 'Too Many Requests' } }, 429)])
    expect(await limited.api.listCalendars(null, null).catch((e: unknown) => (e as CalendarError).status)).toBe(429)
    const down = google([new Response('<html>bad gateway</html>', { status: 502 })])
    expect(await down.api.listCalendars(null, null).catch((e: unknown) => (e as CalendarError).status)).toBe(502)
  })

  test('a 401 is tried once more with a fresh token; a second 401 is an access problem, not a lapse', async () => {
    const ok = google([json({ error: { code: 401 } }, 401), json({ items: [] })])
    await ok.api.listCalendars(null, null)
    expect(ok.accessAsked).toEqual([false, true])
    expect(ok.seen.map((s) => s.headers.get('authorization'))).toEqual(['Bearer access-1', 'Bearer access-2'])
    const twice = google([json({ error: { code: 401 } }, 401), json({ error: { code: 401 } }, 401)])
    const caught = await twice.api.listCalendars(null, null).catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(CalendarAccessError)
    expect((caught as CalendarAccessError).why).toBe('failed')
  })

  test('the access token is kept until a minute before it ends, and asked for again after', async () => {
    let now = 1_000_000
    let asked = 0
    const api = createCalendarGoogle({
      fetch: async () => json({ items: [] }),
      access: async () => ({ ok: true, accessToken: `t${++asked}`, expiresAt: now + 3_600_000 }),
      now: () => now,
    })('a@x.example')
    await api.listCalendars(null, null)
    await api.listCalendars(null, null)
    expect(asked).toBe(1)
    now += 3_600_000 - 59_000
    await api.listCalendars(null, null)
    expect(asked).toBe(2)
  })

  test('when the inbox refuses a token the reason comes through, and Google is not asked', async () => {
    let called = 0
    const api = createCalendarGoogle({
      fetch: async () => {
        called += 1
        return json({})
      },
      access: async () => ({ ok: false, why: 'lapsed', message: 'Google no longer accepts the saved sign-in' }),
      now: () => 0,
    })('a@x.example')
    const caught = await api.listCalendars(null, null).catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(CalendarAccessError)
    expect((caught as CalendarAccessError).why).toBe('lapsed')
    expect(called).toBe(0)
  })

  test('no error carries the access token', async () => {
    const { api } = google([json({ error: { code: 500, message: 'Backend Error' } }, 500)])
    const caught = await api.listCalendars(null, null).catch((e: unknown) => e)
    expect(String((caught as Error).message)).not.toContain('access-1')
  })
})
