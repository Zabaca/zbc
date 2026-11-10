// Meet's guests' side at the space's paths (the space's ADR 0018): the SAME routes meet.northfield.example runs, mounted at /r/api, /w/api and
// Telnyx's /r/api/phone/webhook, and at nothing else. Driven through the real router with the harness's fakes, as a guest would: no sign-in, a call's name, an emailed code, a signed webhook.
import { beforeEach, describe, expect, test } from 'bun:test'
import { createGuestApp } from '../src/space-guests'
import { CALL_API, GUEST_API } from '../src/model'
import { OWNER, harness } from './helpers'
import { actors } from './workspace.helpers'

type H = Awaited<ReturnType<typeof harness>>
let h: H
let guests: ReturnType<typeof createGuestApp>
const SPACE = 'https://space.northfield.example'
const NAME = 'k7m2qx9frtn4w6hbc8jd'

const call = async (app: { request(url: string, init: RequestInit): Response | Promise<Response> }, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.request(`${SPACE}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: (await res.json().catch(() => null)) as any, headers: res.headers }
}

beforeEach(async () => {
  h = await harness({ devBypass: false })
  guests = createGuestApp(() => h.deps)
})

describe('the paths', () => {
  test('are the page’s: the call API under /r/api and the guests’ API under /w/api', () => {
    expect([CALL_API, GUEST_API]).toEqual(['/r/api', '/w/api'])
  })

  test('answer a call with no sign-in: its lobby, and a refusal of anyone without a member token', async () => {
    const made = await h.startCall()
    expect((await call(guests, 'GET', `${CALL_API}/rooms/${made}`)).status).toBe(200)
    expect((await call(guests, 'GET', `${CALL_API}/rooms/${NAME}`)).json).toEqual({ error: 'This is not a call.' })
    expect((await call(guests, 'POST', `${CALL_API}/rooms/${made}/checkin`, { generation: 1 })).status).toBe(401)
    // The answer is never cached.
    expect((await call(guests, 'GET', `${CALL_API}/rooms/${made}`)).headers.get('cache-control')).toBe('no-store')
  })

  test('answer nothing at the old addresses, nor /start, nor the development door: the space’s guest door is not meet.northfield.example', async () => {
    const made = await h.startCall()
    for (const [m, p] of [['GET', `/api/rooms/${made}`], ['GET', '/api/health'], ['GET', '/start'], ['POST', '/api/dev/rooms'], ['POST', '/api/w/auth/request'], ['GET', '/api/w/socket'], ['GET', '/api/phone/dev/telnyx'], ['GET', '/today'], ['GET', '/api/me']] as const) {
      const r = await call(guests, m, p, m === 'POST' ? {} : undefined)
      expect([m, p, r.status]).toEqual([m, p, 404])
    }
  })
})

describe('a guest’s sign-in', () => {
  test('is an emailed code, and the session cookie it sets is Secure, HttpOnly, Lax and scoped to /w/api alone', async () => {
    const a = actors(h)
    const made = await a.tm(OWNER, 'POST', '/channels', { name: 'Acme', privacy: 'private' })
    await a.tm(OWNER, 'POST', `/channels/${made.json.conversation.id}/invite`, { email: 'gus@client.test', name: 'Gus' })
    expect((await call(guests, 'POST', `${GUEST_API}/auth/request`, { email: 'gus@client.test' })).status).toBe(200)
    const code = /(\d{6})/.exec(h.mail.at(-1)?.subject ?? '')?.[1]
    const ok = await call(guests, 'POST', `${GUEST_API}/auth/verify`, { email: 'gus@client.test', code })
    expect(ok.status).toBe(200)
    const cookie = ok.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/^meet_guest=/)
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/Secure/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    expect(cookie).toMatch(/Path=\/w\/api(;|$)/)
    const token = /meet_guest=([^;]+)/.exec(cookie)?.[1] as string
    // The cookie opens the guest's own API, and a team assertion beside it or alone opens nothing.
    expect((await call(guests, 'GET', `${GUEST_API}/bootstrap`, undefined, { cookie: `meet_guest=${token}` })).status).toBe(200)
    expect((await call(guests, 'GET', `${GUEST_API}/bootstrap`)).status).toBe(401)
    expect((await call(guests, 'GET', `${GUEST_API}/bootstrap`, undefined, { 'cf-access-jwt-assertion': await a.assertion(OWNER) })).status).toBe(401)
    expect((await call(guests, 'GET', `${GUEST_API}/bootstrap`, undefined, { cookie: `CF_Authorization=${await a.assertion(OWNER)}` })).status).toBe(401)
  })

  test('is limited per caller before it costs the workspace a request', async () => {
    h.deps.authLimit = async () => false
    expect((await call(guests, 'POST', `${GUEST_API}/auth/request`, { email: 'gus@client.test' })).status).toBe(429)
  })

  test('has a live socket at /w/api/socket that wants an upgrade, a ticket and this site’s Origin', async () => {
    expect((await call(guests, 'GET', `${GUEST_API}/socket?ticket=x`)).status).toBe(426)
    const upgrade = { upgrade: 'websocket' }
    expect((await call(guests, 'GET', `${GUEST_API}/socket?ticket=x`, undefined, { ...upgrade, origin: 'https://evil.example' })).status).toBe(403)
    expect((await call(guests, 'GET', `${GUEST_API}/socket?ticket=short`, undefined, { ...upgrade, origin: SPACE })).status).toBe(401)
  })
})

describe('Telnyx’s webhook', () => {
  test('is at /r/api/phone/webhook, answers a signed event and refuses an unsigned one', async () => {
    const raw = JSON.stringify({ data: { event_type: 'unknown.event', payload: {} } })
    expect((await call(guests, 'POST', '/r/api/phone/webhook', undefined, { 'content-type': 'application/json' })).status).toBe(401)
    const signed = await guests.request(`${SPACE}/r/api/phone/webhook`, { method: 'POST', headers: await h.phone.sign(raw), body: raw })
    expect(signed.status).toBe(200)
    expect((await call(guests, 'POST', '/api/phone/webhook', {})).status).toBe(404)
  })
})

describe('meet.northfield.example, until the cutover', () => {
  test('answers the page’s new paths as well as the old ones, so a deploy does not strand an open tab, and sets the cookie for the path it was asked at', async () => {
    const a = actors(h)
    const made = await h.startCall()
    expect((await call(h.app, 'GET', `${CALL_API}/rooms/${made}`)).status).toBe(200)
    expect((await call(h.app, 'GET', `/r/api/rooms/${made}`)).status).toBe(200)
    const room = await a.tm(OWNER, 'POST', '/channels', { name: 'Acme', privacy: 'private' })
    await a.tm(OWNER, 'POST', `/channels/${room.json.conversation.id}/invite`, { email: 'gus@client.test', name: 'Gus' })
    await call(h.app, 'POST', `${GUEST_API}/auth/request`, { email: 'gus@client.test' })
    const code = /(\d{6})/.exec(h.mail.at(-1)?.subject ?? '')?.[1]
    const ok = await call(h.app, 'POST', `${GUEST_API}/auth/verify`, { email: 'gus@client.test', code })
    expect(ok.headers.get('set-cookie')).toMatch(/Path=\/w\/api(;|$)/)
  })
})
