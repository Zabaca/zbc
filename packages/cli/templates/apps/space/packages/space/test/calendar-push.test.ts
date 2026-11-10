// Google Calendar's notifications at the push host (src/worker.ts, packages/calendar/src/push-door.ts): the host's SECOND path. A notification carries no body, and its headers name a channel the calendar made and the secret it chose;
// what is held here is where each request goes and what it is answered, with the calendar's real engine behind the binding for the one that matters (a notification, then the alarm's read). The sync itself is packages/calendar's tests.
import { describe, expect, test } from 'bun:test'
import { CALENDAR_PUSH_PATH } from '@space/workspace'
import { harness } from '../../calendar/test-support/harness'
import { createWorker, type WorkerEnv } from '../src/worker'

const PUSH = `https://inbox-push.northfield.example${CALENDAR_PUSH_PATH}`
const Z = 'tessa@northfield.example'

/** The Worker with a calendar store behind `CALENDAR` that answers through `call`. */
function worker(call: (method: string, args: unknown[]) => unknown = () => true, options: { bound?: boolean } = {}) {
  const calls: { method: string; args: unknown[] }[] = []
  const reached: string[] = []
  const env = {
    ...(options.bound === false
      ? {}
      : {
          CALENDAR: {
            idFromName: (name: string) => name,
            get: () => ({
              call: async (method: string, args: unknown[]) => {
                calls.push({ method, args })
                return call(method, args)
              },
            }),
          },
        }),
  }
  const w = createWorker<WorkerEnv>({
    team: async (request) => {
      reached.push(new URL(request.url).pathname)
      return new Response('team', { status: 401 })
    },
  })
  const ctx = { waitUntil: () => undefined }
  const fetch = (url: string, init: RequestInit = {}) => w.fetch(new Request(url, init), env as never, ctx as never)
  return { calls, reached, fetch }
}

const headers = (extra: Record<string, string | null> = {}): Record<string, string> =>
  Object.fromEntries(Object.entries({ 'x-goog-channel-id': 'channel-1', 'x-goog-channel-token': 'secret-1', 'x-goog-resource-id': 'res-1', 'x-goog-resource-state': 'exists', 'x-goog-message-number': '2', ...extra }).filter(([, v]) => v !== null)) as Record<string, string>

describe('the calendar’s path on the push host', () => {
  test('a notification for a channel the calendar knows is taken and handed to the calendar, as its headers say; the team’s router is never asked', async () => {
    const t = worker()
    const res = await t.fetch(PUSH, { method: 'POST', headers: headers() })
    expect(res.status).toBe(204)
    expect(t.calls).toEqual([{ method: 'receivePush', args: [{ channelId: 'channel-1', token: 'secret-1', resourceId: 'res-1', state: 'exists' }] }])
    expect(t.reached).toEqual([])
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  test('a body, if one is sent, is not read', async () => {
    const t = worker()
    const res = await t.fetch(PUSH, { method: 'POST', headers: headers(), body: 'x'.repeat(100_000) })
    expect(res.status).toBe(204)
    expect(t.calls).toHaveLength(1)
  })

  test('anything the calendar does not recognise is a 404 with the body every other path of the host gets, so nothing is learned about which channels exist', async () => {
    const t = worker((_m, _a) => false)
    const refused = await t.fetch(PUSH, { method: 'POST', headers: headers() })
    const other = await t.fetch('https://inbox-push.northfield.example/anything-else', { method: 'POST', headers: headers() })
    expect(refused.status).toBe(404)
    expect(await refused.json()).toEqual(await other.json())
  })

  test('only a POST to exactly that path, naming a channel, is for the calendar: another method, a longer path, no channel and a channel that is too long are each a 404 that asks the calendar nothing', async () => {
    const t = worker()
    const answers = [
      await t.fetch(PUSH, { method: 'GET', headers: headers() }),
      await t.fetch(PUSH, { method: 'PUT', headers: headers() }),
      await t.fetch(`${PUSH}/`, { method: 'POST', headers: headers() }),
      await t.fetch(`${PUSH}/extra`, { method: 'POST', headers: headers() }),
      await t.fetch(PUSH, { method: 'POST', headers: headers({ 'x-goog-channel-id': null }) }),
      await t.fetch(PUSH, { method: 'POST', headers: headers({ 'x-goog-channel-id': '' }) }),
      await t.fetch(PUSH, { method: 'POST', headers: headers({ 'x-goog-channel-id': 'c'.repeat(400) }) }),
    ]
    expect(answers.map((a) => a.status)).toEqual([404, 404, 404, 404, 404, 404, 404])
    expect(t.calls).toEqual([])
    expect(t.reached).toEqual([])
  })

  test('a missing secret, resource or state is passed on as missing, and the calendar refuses it', async () => {
    const t = worker((_m, args) => {
      const h = args[0] as { token: string | null; resourceId: string | null }
      return h.token !== null && h.resourceId !== null
    })
    expect((await t.fetch(PUSH, { method: 'POST', headers: headers({ 'x-goog-channel-token': null }) })).status).toBe(404)
    expect((await t.fetch(PUSH, { method: 'POST', headers: headers({ 'x-goog-resource-id': null }) })).status).toBe(404)
    expect((await t.fetch(PUSH, { method: 'POST', headers: headers({ 'x-goog-resource-state': null }) })).status).toBe(204)
  })

  test('with no calendar store bound it is a 404, and a store that fails is a 500 so Google tries again', async () => {
    expect((await worker(undefined, { bound: false }).fetch(PUSH, { method: 'POST', headers: headers() })).status).toBe(404)
    const failing = worker(() => {
      throw new Error('the store is down')
    })
    const original = console.error
    console.error = () => undefined
    try {
      expect((await failing.fetch(PUSH, { method: 'POST', headers: headers() })).status).toBe(500)
    } finally {
      console.error = original
    }
  })

  test('the same path on the space’s own host is the team’s router like any other path: it is not taken', async () => {
    const t = worker()
    const res = await t.fetch(`https://space.northfield.example${CALENDAR_PUSH_PATH}`, { method: 'POST', headers: headers() })
    expect(res.status).toBe(401)
    expect(t.reached).toEqual([CALENDAR_PUSH_PATH])
    expect(t.calls).toEqual([])
  })
})

describe('through the real calendar', () => {
  test('a notification Google would send for a calendar’s channel makes that calendar owed a read, and a forged one does not', async () => {
    const h = harness()
    h.connect(Z)
    h.google.addCalendar(Z, { id: Z, summary: 'Tessa', primary: true })
    await h.work()
    const key = `${Z}|${Z}`
    expect(h.store.calendar(key)?.dirty).toBe(false)
    const t = worker((method, args) => (h.engine as unknown as Record<string, (...a: unknown[]) => unknown>)[method]?.(...args))
    const real = h.google.notification(Z, Z) as Record<string, string>
    const forged = await t.fetch(PUSH, { method: 'POST', headers: { ...real, 'x-goog-channel-token': 'guess' } })
    expect(forged.status).toBe(404)
    expect(h.store.calendar(key)?.dirty).toBe(false)
    const genuine = await t.fetch(PUSH, { method: 'POST', headers: real })
    expect(genuine.status).toBe(204)
    expect(h.store.calendar(key)?.dirty).toBe(true)
  })
})
