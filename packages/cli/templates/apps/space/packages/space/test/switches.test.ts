// Every feature is a switch any install may turn on. Driven through the Worker's real router, as the rest of this package's tests drive it: an invented company with
// every switch off, and the same company with them on, signed in as its owner. What is proved is what the Worker answers, which tabs the page is told of, and that a part whose switch is off is not reached; each part's own reading of its
// switch is in the part's package (meet's and the inbox's switches.test.ts). Northfield's install, where every switch is on, is every other suite here, unchanged.
import { describe, expect, test } from 'bun:test'
import { createInstall, GMAIL_RETURN_PATH, GMAIL_START_PATH } from '@space/workspace'
import { googleKeys, mintPush, PUSH_ACCOUNT, PUSH_ENDPOINT } from '../../inbox/test-support/harness'
import { lane, PINECREST_FILE, readJson } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { switchOf } from '../src/switches'
import { createWorker, type WorkerEnv } from '../src/worker'
import { LANE_TEAM, world } from './world'

const raw = () => structuredClone(readJson(PINECREST_FILE)) as Record<string, any>
/** The company with nothing on. */
const OFF = lane()
/** The same company with Gmail (and so the calendar), calls, the phone and Telegram on, each with the settings it needs. */
const ON = createInstall({
  ...raw(),
  gmailPush: { host: 'inbox-push.pinecrest.test' },
  googleApp: { clientId: '123456789-abcdefghij.apps.googleusercontent.com', pushTopic: 'projects/pinecrest-mail/topics/gmail-push' },
  phone: { people: { 'lane@pinecrest.test': { emergencyNumber: 'line' } } },
  telegram: { path: '/agent/telegram' },
  switches: { gmail: true, calls: true, phone: true, telegram: true },
})

const OWNER = 'lane@pinecrest.test'
const ORIGIN = 'https://space.pinecrest.test'
const post = (path: string, jwt: string) => ({ method: 'POST', jwt, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' })

/** A part the Worker must not touch: any property read on it is recorded. */
const untouchable = (touched: string[]) => new Proxy({}, { get: (_t, key) => (touched.push(String(key)), undefined) }) as never

describe('the tabs and the switches the page is told', () => {
  test('an install with nothing on has Today, Meet, Forms, People and Knowledge, and every switch false', async () => {
    const w = await world(OFF, LANE_TEAM)
    const res = await w.call('/api/me', { jwt: await w.signIn(OWNER) })
    const me = (await res.json()) as ReturnType<typeof meOf>
    expect(me.tabs.map((t) => t.id)).toEqual(['today', 'meet', 'forms', 'people', 'knowledge'])
    expect(Object.values(me.switches).every((v) => v === false)).toBe(true)
  })

  test('with Gmail and a mailbox on it has the Inbox and the Calendar too, in today’s order, and its switches are told', async () => {
    const w = await world(ON, LANE_TEAM)
    const res = await w.call('/api/me', { jwt: await w.signIn(OWNER) })
    const me = (await res.json()) as ReturnType<typeof meOf>
    expect(me.tabs.map((t) => t.id)).toEqual(['today', 'inbox', 'meet', 'calendar', 'forms', 'people', 'knowledge'])
    expect(me.switches).toMatchObject({ gmail: true, calls: true, phone: true, telegram: true, claudeScript: false, assistant: false })
  })
})

describe('a part whose switch is off is not reached, and where it is on it is', () => {
  const PATHS: { path: string; method?: 'POST'; sw: string }[] = [
    { path: '/api/calendar/accounts', sw: 'gmail' },
    { path: '/api/calendar/agenda?from=2026-11-01T00:00:00Z&to=2026-11-08T00:00:00Z', sw: 'gmail' },
    { path: '/api/calendar/event?id=e1', sw: 'gmail' },
    { path: '/api/calendar/shown', method: 'POST', sw: 'gmail' },
    { path: '/api/calendar/sync', method: 'POST', sw: 'gmail' },
    { path: GMAIL_START_PATH, sw: 'gmail' },
    { path: GMAIL_RETURN_PATH, sw: 'gmail' },
    { path: '/api/phone', sw: 'phone' },
    { path: '/api/phone/status', sw: 'phone' },
    { path: '/api/meet/phone', sw: 'phone' },
    { path: '/api/meet/phone-read', method: 'POST', sw: 'phone' },
    { path: '/api/meet/huddle', method: 'POST', sw: 'calls' },
    { path: '/api/meet/call', method: 'POST', sw: 'calls' },
    { path: '/api/meet/meeting', method: 'POST', sw: 'calls' },
    { path: '/api/meet/calls', sw: 'calls' },
    { path: '/api/meet/usage', sw: 'calls' },
  ]

  test('each path is a path that is not there with the switch off, answered before any part is asked', async () => {
    const touched: string[] = []
    const w = await world(OFF, LANE_TEAM, { meet: untouchable(touched), inbox: untouchable(touched) })
    const jwt = await w.signIn(OWNER)
    for (const { path, method } of PATHS) {
      const res = await w.call(path, method === 'POST' ? post(path, jwt) : { jwt })
      expect([path, res.status, await res.json()]).toEqual([path, 404, { error: 'Not found' }])
    }
    expect(touched).toEqual([])
  })

  test('and is let through to its part with the switch on: the router no longer answers it as absent', async () => {
    const w = await world(ON, LANE_TEAM)
    const jwt = await w.signIn(OWNER)
    for (const { path, method } of PATHS) {
      const res = await w.call(path, method === 'POST' ? post(path, jwt) : { jwt })
      // The part behind it is not connected in this world, which each path answers in its own way (a 200 that says so, a page, a refusal of an empty body); none is the router's "not there".
      expect([path, res.status === 404 && ((await res.clone().json().catch(() => null)) as { error?: string } | null)?.error === 'Not found']).toEqual([path, false])
    }
  })

  test('the paths no switch owns are never refused here: a tab’s page, mail, chat, Forms, Knowledge and Clients are every install’s', () => {
    for (const path of ['/today', '/inbox', '/meet', '/forms', '/api/conversations', '/api/chat', '/api/knowledge', '/api/clients/list', '/api/meet/cards', '/api/meet/channel', '/api/meet/people', '/api/people', '/api/inbox/mailboxes']) {
      expect([path, switchOf(path)]).toEqual([path, null])
    }
  })
})

describe('Today', () => {
  test('says nothing of events and never asks the calendar where the install has no Google account', async () => {
    const touched: string[] = []
    const w = await world(OFF, LANE_TEAM, { parts: { calendar: untouchable(touched) } })
    const res = await w.call('/api/today', { jwt: await w.signIn(OWNER) })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { events: { connected: boolean } }).events.connected).toBe(false)
    expect(touched).toEqual([])
  })
})

describe('calls and the guests’ side', () => {
  test('a call’s page is not there where calls are off, and is the guest page’s to answer where they are on', async () => {
    const off = await world(OFF, LANE_TEAM)
    const on = await world(ON, LANE_TEAM)
    const page = '/r/k7m2qx9frtn4w6hbc8jd'
    expect((await off.call(page)).status).toBe(404)
    // With calls on the guest door takes the path (the page's bundle is not in this world's assets, which it says with a 503 and never the team's page).
    expect((await on.call(page)).status).toBe(503)
  })
})

describe('Gmail’s push host', () => {
  const PUSH = 'https://inbox-push.northfield.example/api/gmail/push'
  const body = JSON.stringify({ message: { data: btoa(JSON.stringify({ emailAddress: 'lane@pinecrest.test', historyId: '1' })) } })
  const worker = (install: typeof OFF) => {
    const stored: string[] = []
    const env = {
      GMAIL_PUSH_ENDPOINT: PUSH_ENDPOINT,
      GMAIL_PUSH_SERVICE_ACCOUNT: PUSH_ACCOUNT,
      INBOX: { idFromName: (n: string) => n, get: () => ({ call: async (m: string) => void stored.push(m) }) },
    }
    const w = createWorker<WorkerEnv>({ team: async () => new Response('team', { status: 401 }), pushKeys: googleKeys, install, spaceHost: install.declaration.space.host })
    const ctx = { waitUntil: () => {} }
    return { stored, fetch: async (init: RequestInit) => w.fetch(new Request(PUSH, init), env as never, ctx as never) }
  }

  test('an install without the Gmail switch has no push host: even a good push is a 404 and stores nothing', async () => {
    const t = worker(OFF)
    const res = await t.fetch({ method: 'POST', body, headers: { authorization: `Bearer ${await mintPush()}` } })
    expect(res.status).toBe(404)
    expect(t.stored).toEqual([])
  })

  test('with the switch on the same push is taken', async () => {
    const t = worker(ON)
    const res = await t.fetch({ method: 'POST', body, headers: { authorization: `Bearer ${await mintPush()}` } })
    expect(res.status).toBe(204)
    expect(t.stored).toEqual(['receivePush'])
  })
})
