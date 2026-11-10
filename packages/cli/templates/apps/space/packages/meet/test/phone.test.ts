// Seam 1 for the phone: the Worker's HTTP API at its three doors, with the real phone core over in-memory SQLite and a fake
// Telnyx that records what it was asked. What a person is allowed to do, what Telnyx would be told, what Tessa would be
// emailed, what the month's meter counts. Nothing here checks how the core stores things.
import { beforeEach, describe, expect, test } from 'bun:test'
import { runCron } from '../src/cron'
import { ANA, LINE_NUMBER, OWNER, harness } from './helpers'
import { type Actors, G, W, actors } from './workspace.helpers'

type H = Awaited<ReturnType<typeof harness>>
let h: H
let a: Actors

const ADDRESS = { street: '1 Main St', extended: 'Apt 4', city: 'Springfield', state: 'CA', zip: '91101' }
const P = '/phone'

beforeEach(async () => {
  h = await harness({ devBypass: false })
  a = actors(h)
})

/** Tessa acknowledges the 911 notice and gives his address, as the page asks before a first call. */
async function setUp(email = OWNER): Promise<void> {
  expect((await a.tm(email, 'POST', `${P}/ack`)).status).toBe(200)
  const r = await a.tm(email, 'PUT', `${P}/address`, ADDRESS)
  expect(r.status).toBe(200)
  expect(r.json.ready).toBe(true)
}

let eventCount = 0
/** A Telnyx event as Telnyx would send it. */
const event = (type: string, payload: Record<string, unknown>, id = `evt-${++eventCount}`) => ({
  data: { id, event_type: type, occurred_at: new Date(h.clock.now).toISOString(), payload },
})

/** Post an event to the webhook, signed as Telnyx signs. */
async function hook(body: unknown, headers?: Record<string, string>) {
  const raw = JSON.stringify(body)
  const res = await h.app.request('http://localhost/r/api/phone/webhook', { method: 'POST', headers: headers ?? (await h.phone.sign(raw)), body: raw })
  return { status: res.status, json: await res.json().catch(() => null) }
}

/** A browser call arriving parked, with the page's ticket as client state (one of the two ways it can arrive). */
const parked = (leg: string, to: string, ticket: string | null, who = 'x') => event('call.initiated', { call_control_id: leg, to, direction: 'outgoing', state: 'parked', client_state: btoa(JSON.stringify({ t: ticket, w: who })) })

/** The approval a page gets before it dials. */
async function approve(to: string, email = OWNER): Promise<{ status: number; json: any }> {
  return a.tm(email, 'POST', `${P}/call`, { to })
}

/** Place a whole call: approval, parked, answered at `t`, hung up `secs` later. Returns the call's id and the dialed leg. */
async function call(to: string, secs: number, leg = `browser-${++eventCount}`) {
  const ok = await approve(to)
  expect(ok.status).toBe(200)
  await hook(parked(leg, ok.json.to, ok.json.ticket))
  const dial = h.phone.telnyx.of('dial').at(-1)!
  expect(dial.linkTo).toBe(leg)
  const callId = Number(atob(dial.clientState).split(':')[1])
  await hook(event('call.answered', { call_control_id: dial.leg, client_state: dial.clientState }))
  h.clock.now += secs * 1000
  await hook(event('call.hangup', { call_control_id: dial.leg, client_state: dial.clientState }))
  return { callId, dial }
}

/** Everything Telnyx was asked since setUp's address registration. */
const asked = () => h.phone.telnyx.calls.filter((c) => c.op !== 'registerEmergencyAddress')
const minutes = () => h.phoneCore.minutesUsed(h.clock.now)
const mailTo = (to: string) => h.mail.filter((m) => m.to === to)

describe('who has the phone: the door, then the teammate list, then the phone list', () => {
  const routes: Array<[string, string, unknown?]> = [
    ['GET', P],
    ['POST', `${P}/ack`],
    ['PUT', `${P}/address`, ADDRESS],
    ['POST', `${P}/address/confirm`],
    ['POST', `${P}/token`],
    ['POST', `${P}/call`, { to: '6265550123' }],
    ['POST', `${P}/emergency`, { to: '911' }],
    ['GET', `${P}/calls`],
  ]

  test('every phone route is refused with no assertion', async () => {
    for (const [method, path, body] of routes) {
      const r = await h.callTeammate(method, `${W}${path}`, body)
      expect([method, path, r.status]).toEqual([method, path, 401])
    }
  })

  test('a guest cookie on a phone route is ignored, so the request has no assertion and is refused', async () => {
    const conv = (await a.tm(OWNER, 'POST', '/channels', { name: 'Acme', privacy: 'private' })).json.conversation.id
    await a.tm(OWNER, 'POST', `/channels/${conv}/invite`, { email: 'gus@client.test', name: 'Gus' })
    const token = await a.signIn('gus@client.test')
    for (const [method, path, body] of routes) {
      const r = await h.callTeammate(method, `${W}${path}`, body, { headers: { cookie: `meet_guest=${token}` } })
      expect([method, path, r.status]).toEqual([method, path, 401])
    }
  })

  test('the guests’ door has no phone at all: no route there answers, with or without a session', async () => {
    const conv = (await a.tm(OWNER, 'POST', '/channels', { name: 'Acme', privacy: 'private' })).json.conversation.id
    await a.tm(OWNER, 'POST', `/channels/${conv}/invite`, { email: 'gus@client.test', name: 'Gus' })
    const token = await a.signIn('gus@client.test')
    for (const [method, path, body] of routes) {
      for (const r of [await a.gu(token, method, path, body), await h.call(method, `${G}${path}`, body)]) {
        expect([method, path, r.status === 200]).toEqual([method, path, false])
      }
    }
    expect(h.phone.telnyx.calls).toEqual([])
  })

  test('a teammate who is not on the phone list sees no phone and can use none of it', async () => {
    expect((await a.tm(ANA, 'GET', P)).json).toEqual({ available: false })
    for (const [method, path, body] of routes.slice(1)) {
      const r = await a.tm(ANA, method, path, body)
      expect([method, path, r.status === 200]).toEqual([method, path, false])
    }
    expect(h.phone.telnyx.calls).toEqual([])
  })

  test('an address off the teammate list is refused even with a good assertion, and a phone-list entry alone does not help it', async () => {
    h.phonePeople['stranger@northfield.example'] = { emergencyNumber: 'line' }
    expect((await a.tm('stranger@northfield.example', 'GET', P)).status).toBe(403)
    expect((await a.tm('stranger@northfield.example', 'POST', `${P}/token`)).status).toBe(403)
  })

  test('a teammate taken off the teammate list loses the phone at once, whatever the phone list says', async () => {
    await setUp()
    h.teammates.splice(h.teammates.indexOf(OWNER), 1)
    expect((await a.tm(OWNER, 'POST', `${P}/token`)).status).toBe(403)
    expect(h.phone.telnyx.of('loginToken')).toHaveLength(0)
  })

  test('with no Telnyx secrets the phone is hidden and every phone route says it is not set up', async () => {
    h.phoneOff.on = true
    expect((await a.tm(OWNER, 'GET', P)).json).toEqual({ available: false })
    for (const [method, path, body] of routes.slice(1)) {
      const r = await a.tm(OWNER, method, path, body)
      expect([method, path, r.status]).toEqual([method, path, 404])
    }
    expect((await hook(parked('b', '+16265550123', null))).status).toBe(404)
  })

  test('Tessa sees the phone: its number, the notice, the meter and what is left to set up', async () => {
    const r = await a.tm(OWNER, 'GET', P)
    expect(r.json).toMatchObject({ available: true, sdk: 'telnyx', line: LINE_NUMBER, lineDisplay: '(626) 555-0100', acked: false, address: null, ready: false, minutes: { used: 0, cap: 1000 } })
    expect(r.json.notice).toContain('911 from meet may not work')
  })
})

describe('a phone login: made for Northfield Works people, short-lived, with no key in it', () => {
  test('the first request makes Tessa a credential at Telnyx and later ones reuse it; each gets a fresh token', async () => {
    const one = await a.tm(OWNER, 'POST', `${P}/token`)
    const two = await a.tm(OWNER, 'POST', `${P}/token`)
    expect(one.status).toBe(200)
    expect(Object.keys(one.json).sort()).toEqual(['sdk', 'token', 'who'])
    expect(one.json.token).not.toBe(two.json.token)
    expect(h.phone.telnyx.of('createCredential')).toHaveLength(1)
    expect(h.phone.telnyx.of('loginToken')).toHaveLength(2)
    expect(one.json.who).toBe(two.json.who)
  })

  test('a write from another site is refused', async () => {
    const r = await a.tm(OWNER, 'POST', `${P}/token`, undefined, { origin: 'https://evil.example' })
    expect(r.status).toBe(403)
    expect(h.phone.telnyx.calls).toEqual([])
  })
})

describe('911 setup: the notice, the address, and calls waiting for Telnyx to hold it', () => {
  test('a first call is refused with the reason until the notice is acknowledged and the address is registered', async () => {
    const r = await approve('626 555 0123')
    expect(r.status).toBe(403)
    expect(r.json.reason).toBe('setup')
    await a.tm(OWNER, 'POST', `${P}/ack`)
    expect((await approve('626 555 0123')).json.reason).toBe('setup')
    const put = await a.tm(OWNER, 'PUT', `${P}/address`, ADDRESS)
    expect(put.json).toMatchObject({ ready: true, registered: true, address: ADDRESS })
    expect((await approve('626 555 0123')).status).toBe(200)
  })

  test('the address goes onto the Northfield Works number at Telnyx, under Tessa’s name', async () => {
    await setUp()
    expect(h.phone.telnyx.of('registerEmergencyAddress')).toEqual([{ op: 'registerEmergencyAddress', number: LINE_NUMBER, address: ADDRESS, name: { first: 'Tessa', last: 'Northfield Works', business: 'Northfield Works' } }])
  })

  test('a person with a number of their own has their address put on that number, not on the line’s', async () => {
    h.phonePeople[ANA] = { emergencyNumber: '+12135550111' }
    await setUp(ANA)
    expect((h.phone.telnyx.of('registerEmergencyAddress')[0]).number).toBe('+12135550111')
  })

  test('an address Telnyx will not accept leaves calls out waiting, and says why', async () => {
    h.phone.telnyx.failRegister = 'invalid'
    await a.tm(OWNER, 'POST', `${P}/ack`)
    const r = await a.tm(OWNER, 'PUT', `${P}/address`, ADDRESS)
    expect(r.status).toBe(400)
    expect(r.json.error).toContain('could not verify')
    expect((await a.tm(OWNER, 'GET', P)).json).toMatchObject({ ready: false, registered: false, address: ADDRESS })
    expect((await approve('626 555 0123')).json.reason).toBe('setup')
    h.phone.telnyx.failRegister = 'down'
    expect((await a.tm(OWNER, 'PUT', `${P}/address`, ADDRESS)).status).toBe(502)
    h.phone.telnyx.failRegister = 'no'
    expect((await a.tm(OWNER, 'PUT', `${P}/address`, ADDRESS)).json.ready).toBe(true)
  })

  test('changing the address means Telnyx must hold the new one before the next call', async () => {
    await setUp()
    h.phone.telnyx.failRegister = 'down'
    await a.tm(OWNER, 'PUT', `${P}/address`, { ...ADDRESS, street: '9 Elm Ave' })
    expect((await approve('626 555 0123')).json.reason).toBe('setup')
  })

  test('nonsense addresses are refused before Telnyx is asked', async () => {
    await a.tm(OWNER, 'POST', `${P}/ack`)
    for (const bad of [{ ...ADDRESS, street: '' }, { ...ADDRESS, city: '' }, { ...ADDRESS, state: 'ZZ' }, { ...ADDRESS, zip: '9110' }, 'text', null]) {
      expect((await a.tm(OWNER, 'PUT', `${P}/address`, bad)).status).toBe(400)
    }
    expect(h.phone.telnyx.of('registerEmergencyAddress')).toHaveLength(0)
  })

  test('the page is asked to check an address when the person is in another state, until they say it is right', async () => {
    await setUp()
    const at = (region: string | null) => h.phoneCore.status(OWNER, h.clock.now, region)
    expect((await at('CA')).addressCheck).toBe(false)
    expect((await at(null)).addressCheck).toBe(false)
    expect((await at('NY')).addressCheck).toBe(true)
    await h.phoneCore.confirmAddress(OWNER, 'NY')
    expect((await at('NY')).addressCheck).toBe(false)
    expect((await at('TX')).addressCheck).toBe(true)
    // A new address starts again.
    await a.tm(OWNER, 'PUT', `${P}/address`, { ...ADDRESS, state: 'NY', city: 'Albany', zip: '12207' })
    expect((await at('NY')).addressCheck).toBe(false)
  })
})

describe('the approval for a call: every rule, with its reason', () => {
  beforeEach(setUp)

  const table: Array<[string, 'ok' | string]> = [
    ['(626) 555-0123', 'ok'],
    ['626-555-0123', 'ok'],
    ['626.555.0123', 'ok'],
    ['1 626 555 0123', 'ok'],
    ['+1 (626) 555-0123', 'ok'],
    ['+16265550123', 'ok'],
    ['800 555 0123', 'ok'],
    ['', 'format'],
    ['555-0123', 'format'],
    ['1-800-FLOWERS', 'format'],
    ['0265550123', 'format'],
    ['626 155 0123', 'format'],
    ['+44 20 7946 0958', 'country'],
    ['011 44 20 7946 0958', 'country'],
    ['00 33 1 23 45 67 89', 'country'],
    ['+52 55 1234 5678', 'country'],
    ['416 555 0123', 'territory'],
    ['+1 604 555 0123', 'territory'],
    ['876 555 0123', 'territory'],
    ['+1 809 555 0123', 'territory'],
    ['809 555 0123', 'territory'],
    ['787 555 0123', 'territory'],
    ['671 555 0123', 'territory'],
    ['900 555 0123', 'premium'],
    ['976 555 0123', 'premium'],
    ['700 555 0123', 'premium'],
    ['500 555 0123', 'premium'],
  ]
  for (const [number, want] of table) {
    test(`${JSON.stringify(number)} is ${want === 'ok' ? 'approved' : `refused as ${want}`}`, async () => {
      const r = await approve(number)
      if (want === 'ok') {
        expect(r.status).toBe(200)
        expect(r.json.to).toMatch(/^\+1[2-9]\d\d[2-9]\d{6}$/)
        expect(r.json.ticket).toMatch(/^[A-Za-z0-9_-]{22,}$/)
        expect(r.json.emergency).toBe(false)
      } else {
        expect(r.status).toBeGreaterThanOrEqual(400)
        expect(r.json.reason).toBe(want)
        expect(r.json.error.length).toBeGreaterThan(10)
      }
    })
  }

  test('a refused number is never put to Telnyx, and a refused approval keeps nothing', async () => {
    await approve('900 555 0123')
    expect(h.phone.telnyx.calls.filter((c) => c.op === 'dial')).toEqual([])
    expect(h.phoneCore.minutesUsed(h.clock.now)).toBe(0)
  })

  test('911 and 933 are approved in any spelling, with no ticket, and the page is told it is an emergency', async () => {
    for (const to of ['911', ' 911 ', '+1 911', '1911', 'sip:911@sip.telnyx.com', '933', '+1933']) {
      const r = await approve(to)
      expect([to, r.status, r.json.emergency, r.json.ticket]).toEqual([to, 200, true, null])
    }
    // +911 is another country's code and 9-1-1-5-5-5 is no number: refused like any malformed one.
    for (const to of ['+911', '911 555 0123', '9111']) expect([to, (await approve(to)).status >= 400]).toEqual([to, true])
  })
})

describe('the stand-in’s routes exist on a localhost run with the stand-in Telnyx and nowhere else', () => {
  test('here, with a real Telnyx runtime, they answer 404 to anyone, including Tessa on localhost with the bypass', async () => {
    h = await harness({ devBypass: true })
    a = actors(h)
    await setUp()
    const ev = event('call.initiated', { call_control_id: 'b1', to: '911', direction: 'outgoing' })
    for (const [method, path, body] of [['POST', '/api/phone/dev/event', ev], ['GET', '/api/phone/dev/telnyx', undefined]] as const) {
      const r = await h.call(method, path, body)
      expect([path, r.status]).toEqual([path, 404])
    }
    expect(h.phone.telnyx.of('dial')).toHaveLength(0)
  })
})

describe('Telnyx’s webhook: signed, or it is not read', () => {
  beforeEach(setUp)

  test('an unsigned, a wrongly signed, a stale and a tampered request are refused and change nothing', async () => {
    const ok = await approve('626 555 0123')
    const body = parked('b1', ok.json.to, ok.json.ticket)
    const raw = JSON.stringify(body)
    const other = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const now = Math.floor(h.clock.now / 1000)
    const cases: Array<[string, Record<string, string>]> = [
      ['unsigned', { 'content-type': 'application/json' }],
      ['another key', await h.phone.sign(raw, now, other.privateKey)],
      ['stale', await h.phone.sign(raw, now - 301)],
      ['from the future', await h.phone.sign(raw, now + 301)],
      ['signature of another body', await h.phone.sign(raw + ' ')],
      ['no timestamp', { 'telnyx-signature-ed25519': (await h.phone.sign(raw))['telnyx-signature-ed25519'] as string }],
      ['garbage signature', { 'telnyx-signature-ed25519': 'AAAA', 'telnyx-timestamp': String(now) }],
    ]
    for (const [what, headers] of cases) {
      const r = await h.app.request('http://localhost/r/api/phone/webhook', { method: 'POST', headers, body: raw })
      expect([what, r.status]).toEqual([what, 401])
    }
    expect(asked()).toEqual([])
    // The ticket was not spent by any of them: the real, signed event still goes through.
    expect((await hook(body)).status).toBe(200)
    expect(h.phone.telnyx.of('dial')).toHaveLength(1)
  })

  test('a signed event that is not a call event, or not JSON, is accepted and ignored', async () => {
    expect((await hook({ data: { id: 'x', event_type: 'call.speak.ended', payload: {} } })).status).toBe(200)
    const raw = 'not json'
    expect((await h.app.request('http://localhost/r/api/phone/webhook', { method: 'POST', headers: await h.phone.sign(raw), body: raw })).status).toBe(200)
    expect(asked()).toEqual([])
  })
})

describe('a call goes out only with its approval, and is dialed from the Northfield Works number', () => {
  beforeEach(setUp)

  test('an approved call is dialed: from the Northfield Works number, named Northfield Works, linked to the parked leg, for at most 4 hours', async () => {
    const ok = await approve('(626) 555-0123')
    expect((await hook(parked('b1', ok.json.to, ok.json.ticket))).status).toBe(200)
    const dial = h.phone.telnyx.of('dial')
    expect(dial).toHaveLength(1)
    expect(dial[0]).toMatchObject({ to: '+16265550123', from: LINE_NUMBER, fromName: 'Northfield Work', linkTo: 'b1', timeLimitSecs: 14400 })
    expect(atob((dial[0]).clientState)).toMatch(/^meet:\d+:[0-9a-f]{16}$/)
    expect(h.phone.telnyx.of('hangup')).toHaveLength(0)
  })

  test('the approval also works when it rides as a custom header instead of client state', async () => {
    const ok = await approve('626 555 0123')
    await hook(event('call.initiated', { call_control_id: 'b1', to: ok.json.to, direction: 'outgoing', custom_headers: [{ header_name: 'X-Meet-Ticket', header_value: ok.json.ticket }, { header_name: 'X-Meet-Who', header_value: 'w' }] }))
    expect(h.phone.telnyx.of('dial')).toHaveLength(1)
  })

  test('a parked call with no approval is hung up and nothing is dialed', async () => {
    await hook(parked('b1', '+16265550123', null))
    await hook(parked('b2', '+16265550123', 'made-up-ticket-aaaaaaaaaaaaaaaaaa'))
    expect(h.phone.telnyx.of('dial')).toHaveLength(0)
    expect(h.phone.telnyx.of('hangup').map((c) => c.leg)).toEqual(['b1', 'b2'])
  })

  test('an approval is for one number and is spent by one call', async () => {
    const ok = await approve('626 555 0123')
    await hook(parked('b1', '+16265550199', ok.json.ticket))
    expect(h.phone.telnyx.of('dial')).toHaveLength(0)
    // The wrong-number try spent it: a stolen ticket gets one guess.
    await hook(parked('b2', ok.json.to, ok.json.ticket))
    expect(h.phone.telnyx.of('dial')).toHaveLength(0)
    const again = await approve('626 555 0123')
    await hook(parked('b3', again.json.to, again.json.ticket))
    await hook(parked('b4', again.json.to, again.json.ticket))
    expect(h.phone.telnyx.of('dial')).toHaveLength(1)
    expect(h.phone.telnyx.of('hangup').map((c) => c.leg)).toEqual(['b1', 'b2', 'b4'])
  })

  test('an approval lasts a minute', async () => {
    const ok = await approve('626 555 0123')
    h.clock.now += 61_000
    await hook(parked('b1', ok.json.to, ok.json.ticket))
    expect(h.phone.telnyx.of('dial')).toHaveLength(0)
  })

  test('a parked call to a premium number is refused even with a real approval for another number', async () => {
    const ok = await approve('626 555 0123')
    await hook(parked('b1', '+19005550123', ok.json.ticket))
    expect(h.phone.telnyx.of('dial')).toHaveLength(0)
    expect(h.phone.telnyx.of('hangup')).toHaveLength(1)
  })

  test('the leg meet dialed announces itself and is not mistaken for a browser call: no second dial', async () => {
    const ok = await approve('626 555 0123')
    await hook(parked('b1', ok.json.to, ok.json.ticket))
    const state = (h.phone.telnyx.of('dial')[0]).clientState
    await hook(event('call.initiated', { call_control_id: 'leg-9', to: ok.json.to, direction: 'outgoing', client_state: state }))
    expect(h.phone.telnyx.of('dial')).toHaveLength(1)
  })

  test('an event Telnyx delivers twice is acted on once', async () => {
    const ok = await approve('626 555 0123')
    const ev = parked('b1', ok.json.to, ok.json.ticket)
    await hook(ev)
    await hook(ev)
    expect(h.phone.telnyx.of('dial')).toHaveLength(1)
  })

  test('when Telnyx will not dial, the browser’s call is hung up and the log says it failed', async () => {
    h.phone.telnyx.failDial = true
    const ok = await approve('626 555 0123')
    await hook(parked('b1', ok.json.to, ok.json.ticket))
    expect(h.phone.telnyx.of('hangup').map((c) => c.leg)).toEqual(['b1'])
    expect((await a.tm(OWNER, 'GET', `${P}/calls`)).json.calls[0]).toMatchObject({ outcome: 'failed', number: '+16265550123' })
  })

  test('when the browser hangs up while the other phone still rings, the dialed leg is hung up too', async () => {
    const ok = await approve('626 555 0123')
    await hook(parked('b1', ok.json.to, ok.json.ticket))
    await hook(event('call.hangup', { call_control_id: 'b1', client_state: btoa(JSON.stringify({ t: ok.json.ticket, w: 'x' })) }))
    expect(h.phone.telnyx.of('hangup').map((c) => c.leg)).toEqual(['leg-1'])
  })
})

describe('the month’s minutes: counted once per call, rounded up, refused past the cap', () => {
  test('a call adds its answered time rounded up to the minute, once, however often Telnyx says it ended', async () => {
    await setUp()
    const { dial } = await call('626 555 0123', 130)
    expect(minutes()).toBe(3)
    await hook(event('call.hangup', { call_control_id: 'again', client_state: dial.clientState }))
    expect(minutes()).toBe(3)
    expect((await a.tm(OWNER, 'GET', P)).json.minutes).toEqual({ used: 3, cap: 1000 })
  })

  test('a call nobody answered adds nothing, and a one-second call adds a minute', async () => {
    await setUp()
    const ok = await approve('626 555 0123')
    await hook(parked('b1', ok.json.to, ok.json.ticket))
    const state = (h.phone.telnyx.of('dial')[0]).clientState
    await hook(event('call.hangup', { call_control_id: 'leg-1', client_state: state }))
    expect(minutes()).toBe(0)
    expect((await a.tm(OWNER, 'GET', `${P}/calls`)).json.calls[0].outcome).toBe('not-answered')
    await call('626 555 0124', 1)
    expect(minutes()).toBe(1)
  })

  test('a hang-up that arrives before its answer is counted when the answer arrives', async () => {
    await setUp()
    const ok = await approve('626 555 0123')
    await hook(parked('b1', ok.json.to, ok.json.ticket))
    const state = (h.phone.telnyx.of('dial')[0]).clientState
    const answeredAt = new Date(h.clock.now).toISOString()
    h.clock.now += 61_000
    await hook(event('call.hangup', { call_control_id: 'leg-1', client_state: state }))
    expect(minutes()).toBe(0)
    await hook({ data: { id: 'late', event_type: 'call.answered', occurred_at: answeredAt, payload: { call_control_id: 'leg-1', client_state: state } } })
    expect(minutes()).toBe(2)
  })

  test('past the cap new calls are refused with the reason, an approval handed out before it is refused at the door, and 911 is not', async () => {
    h = await harness({ devBypass: false, phoneCap: 10 })
    a = actors(h)
    await setUp()
    const early = await approve('626 555 0199')
    await call('626 555 0123', 600)
    expect(minutes()).toBe(10)
    const r = await approve('626 555 0123')
    expect([r.status, r.json.reason]).toEqual([403, 'cap'])
    // The approval from before the cap tripped was good when it was made; the webhook asks again.
    const dials = h.phone.telnyx.of('dial').length
    await hook(parked('late', early.json.to, early.json.ticket))
    expect(h.phone.telnyx.of('dial')).toHaveLength(dials)
    // 911 never counts and never waits.
    expect((await approve('911')).status).toBe(200)
    await hook(parked('e1', '911', null))
    expect(h.phone.telnyx.of('dial')).toHaveLength(dials + 1)
  })

  test('Tessa is emailed at 80% and at 100% of the cap, once each, and never for 911', async () => {
    h = await harness({ devBypass: false, phoneCap: 10 })
    a = actors(h)
    await setUp()
    await call('626 555 0123', 7 * 60)
    expect(mailTo(OWNER)).toHaveLength(0)
    await call('626 555 0123', 60)
    expect(mailTo(OWNER).map((m) => m.subject)).toEqual(['meet has used 80% of its phone minutes for the month'])
    await call('626 555 0123', 30)
    expect(mailTo(OWNER)).toHaveLength(1)
    await call('626 555 0123', 60)
    expect(mailTo(OWNER).map((m) => m.subject)).toEqual(['meet has used 80% of its phone minutes for the month', 'meet has used all its phone minutes for the month'])
    await call('626 555 0123', 60).catch(() => null)
    expect(mailTo(OWNER)).toHaveLength(2)
  })

  test('the minutes belong to the month the call ended in', async () => {
    await setUp()
    await call('626 555 0123', 60)
    h.clock.now = Date.UTC(2026, 10, 2, 12, 0, 0)
    expect(minutes()).toBe(0)
  })
})

describe('911: never blocked, dialed from the number that holds the address, and Tessa is told once', () => {
  test('a 911 call from a person who has done no setup, past the cap, with the line paused by nothing, is dialed', async () => {
    h = await harness({ devBypass: false, phoneCap: 1 })
    a = actors(h)
    const who = (await a.tm(OWNER, 'GET', P)).json.who
    await hook(parked('e1', '911', null, who))
    expect(h.phone.telnyx.of('dial')[0]).toMatchObject({ to: '911', from: LINE_NUMBER, linkTo: 'e1', fromName: 'Northfield Work' })
    expect(h.phone.telnyx.of('hangup')).toHaveLength(0)
  })

  test('Tessa is emailed who dialed and the address they gave, with fixed text in the subject', async () => {
    await setUp()
    const who = (await a.tm(OWNER, 'GET', P)).json.who
    await hook(parked('e1', '911', null, who))
    const mail = mailTo(OWNER)
    expect(mail).toHaveLength(1)
    expect(mail[0]?.subject).toBe('911 was dialed from meet')
    expect(mail[0]?.text).toContain('Tessa dialed 911 from meet')
    expect(mail[0]?.text).toContain('1 Main St, Apt 4, Springfield, CA 91101')
    expect(mail[0]?.from.email).toBe('meet@northfield.example')
    // The call is dialed before the email is sent: the order of what Telnyx and the mailer were asked.
    expect(h.phone.telnyx.of('dial')).toHaveLength(1)
  })

  test('the page’s report and Telnyx’s webhook for one call make one email, and a later call (after two minutes) makes another', async () => {
    await setUp()
    const who = (await a.tm(OWNER, 'GET', P)).json.who
    expect((await a.tm(OWNER, 'POST', `${P}/emergency`, { to: '911' })).status).toBe(200)
    await hook(parked('e1', '911', null, who))
    expect(mailTo(OWNER)).toHaveLength(1)
    h.clock.now += 3 * 60_000
    await hook(parked('e2', '911', null, who))
    expect(mailTo(OWNER)).toHaveLength(2)
  })

  test('if the email cannot be sent the call is still dialed', async () => {
    await setUp()
    h.mailFails.on = true
    await hook(parked('e1', '911', null, 'x'))
    expect(h.phone.telnyx.of('dial')).toHaveLength(1)
  })

  test('a 911 call that cannot be matched to anyone is dialed from the Northfield Works number and told as unidentified', async () => {
    await setUp()
    await hook(parked('e1', '911', null, 'nobody-has-this-id'))
    expect(h.phone.telnyx.of('dial')[0]).toMatchObject({ from: LINE_NUMBER })
    expect(mailTo(OWNER)[0]?.text).toContain('Someone dialed 911')
    expect(mailTo(OWNER)[0]?.text).toContain('could not tell who it was')
  })

  test('a person with a number of their own dials 911 from it, so the right address goes with the call', async () => {
    h.phonePeople[ANA] = { emergencyNumber: '+12135550111' }
    await setUp(ANA)
    const who = (await a.tm(ANA, 'GET', P)).json.who
    await hook(parked('e1', '911', null, who))
    expect(h.phone.telnyx.of('dial')[0]).toMatchObject({ to: '911', from: '+12135550111' })
  })

  test('someone who has no phone entry cannot pose as a phone person to choose the number a 911 call leaves from', async () => {
    h.phonePeople[ANA] = { emergencyNumber: '+12135550111' }
    await setUp(ANA)
    const who = (await a.tm(ANA, 'GET', P)).json.who
    delete h.phonePeople[ANA]
    await hook(parked('e1', '911', null, who))
    expect(h.phone.telnyx.of('dial')[0]).toMatchObject({ from: LINE_NUMBER })
  })

  test('933, Telnyx’s test line, is dialed and no one is emailed', async () => {
    await setUp()
    await hook(parked('e1', '933', null, 'x'))
    expect(h.phone.telnyx.of('dial')[0]).toMatchObject({ to: '933' })
    expect(h.mail).toHaveLength(0)
  })

  test('911 minutes are shown in the log but never added to the month', async () => {
    await setUp()
    const who = (await a.tm(OWNER, 'GET', P)).json.who
    await hook(parked('e1', '911', null, who))
    const state = (h.phone.telnyx.of('dial')[0]).clientState
    await hook(event('call.answered', { call_control_id: 'leg-1', client_state: state }))
    h.clock.now += 5 * 60_000
    await hook(event('call.hangup', { call_control_id: 'leg-1', client_state: state }))
    expect(minutes()).toBe(0)
    expect((await a.tm(OWNER, 'GET', `${P}/calls`)).json.calls[0]).toMatchObject({ emergency: true, outcome: 'completed', minutes: 5 })
  })

  test('the report route takes 911 and nothing else', async () => {
    await setUp()
    expect((await a.tm(OWNER, 'POST', `${P}/emergency`, { to: '626 555 0123' })).status).toBe(400)
    expect((await a.tm(OWNER, 'POST', `${P}/emergency`, { to: '933' })).status).toBe(400)
    expect(h.mail).toHaveLength(0)
  })
})

describe('a browser that hangs up while meet’s dial request is still out', () => {
  /** The browser hangs up while the dial request is out; the leg then comes up. Returns the dialed leg's client state. */
  async function abandonedDial() {
    await setUp()
    const ok = await approve('626 555 0123')
    const browserState = btoa(JSON.stringify({ t: ok.json.ticket, w: 'x' }))
    h.phone.telnyx.duringDial = async () => {
      h.phone.telnyx.duringDial = null
      await hook(event('call.hangup', { call_control_id: 'b1', client_state: browserState }))
    }
    await hook(parked('b1', ok.json.to, ok.json.ticket))
    return h.phone.telnyx.of('dial')[0]!.clientState as string
  }

  test('the leg that comes up is hung up at once, and if nobody answers it counts nothing', async () => {
    const state = await abandonedDial()
    expect(h.phone.telnyx.of('hangup').map((c) => c.leg)).toEqual(['leg-1'])
    await hook(event('call.hangup', { call_control_id: 'leg-1', client_state: state }))
    expect(minutes()).toBe(0)
    expect((await a.tm(OWNER, 'GET', `${P}/calls`)).json.calls[0]).toMatchObject({ outcome: 'abandoned', minutes: 0 })
  })

  test('if that leg was answered before the hang-up reached it, the minutes it ran are counted like any call’s', async () => {
    const state = await abandonedDial()
    await hook(event('call.answered', { call_control_id: 'leg-1', client_state: state }))
    h.clock.now += 100_000
    await hook(event('call.hangup', { call_control_id: 'leg-1', client_state: state }))
    expect(minutes()).toBe(2)
    expect((await a.tm(OWNER, 'GET', `${P}/calls`)).json.calls[0]).toMatchObject({ outcome: 'completed', minutes: 2 })
  })

  test('a hang-up Telnyx does not take is tried again by the cron, until it is taken', async () => {
    h.phone.telnyx.failHangup = true
    await abandonedDial()
    expect(h.phone.telnyx.of('hangup')).toHaveLength(1)
    await runCron(h.deps)
    expect(h.phone.telnyx.of('hangup').map((c) => c.leg)).toEqual(['leg-1', 'leg-1'])
    h.phone.telnyx.failHangup = false
    await runCron(h.deps)
    expect(h.phone.telnyx.of('hangup')).toHaveLength(3)
    // Taken: not asked for again.
    await runCron(h.deps)
    expect(h.phone.telnyx.of('hangup')).toHaveLength(3)
  })

  test('and a hang-up that was taken the first time is never retried', async () => {
    await abandonedDial()
    await runCron(h.deps)
    expect(h.phone.telnyx.of('hangup')).toHaveLength(1)
  })

  test('the core says so when the dial comes back for a call already abandoned, and not otherwise', async () => {
    await setUp()
    const ok = await approve('626 555 0123')
    const [dial] = h.phoneCore.webhook({ id: 'e-a', type: 'call.initiated', at: h.clock.now, leg: 'b9', to: ok.json.to, direction: 'outgoing', state: 'parked', connection: null, from: '', digits: null, gather: null, recordingId: null, recordingStart: null, recordingEnd: null, ours: null, who: 'x', start: null, end: null, cause: null, ticketHash: await sha(ok.json.ticket) }, h.clock.now)
    if (dial?.do !== 'dial') throw new Error('expected a dial')
    expect(h.phoneCore.dialStarted(dial.callId, 'leg-x')).toEqual({ abandoned: false })
    const ok2 = await approve('626 555 0124')
    const [dial2] = h.phoneCore.webhook({ id: 'e-b', type: 'call.initiated', at: h.clock.now, leg: 'b10', to: ok2.json.to, direction: 'outgoing', state: 'parked', connection: null, from: '', digits: null, gather: null, recordingId: null, recordingStart: null, recordingEnd: null, ours: null, who: 'x', start: null, end: null, cause: null, ticketHash: await sha(ok2.json.ticket) }, h.clock.now)
    if (dial2?.do !== 'dial') throw new Error('expected a dial')
    h.phoneCore.webhook({ id: 'e-c', type: 'call.hangup', at: h.clock.now, leg: 'b10', to: '', direction: 'outgoing', state: null, connection: null, from: '', digits: null, gather: null, recordingId: null, recordingStart: null, recordingEnd: null, ours: null, who: null, start: null, end: null, cause: null, ticketHash: null }, h.clock.now)
    expect(h.phoneCore.dialStarted(dial2.callId, 'leg-y')).toEqual({ abandoned: true })
  })
})

const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('')

describe('client state is the browser’s to set: it never reaches another call', () => {
  /** A call in progress: answered, not yet ended. Its dialed leg, state and call id. */
  async function inProgress() {
    await setUp()
    const ok = await approve('626 555 0123')
    await hook(parked('victim', ok.json.to, ok.json.ticket))
    const dial = h.phone.telnyx.of('dial').at(-1)!
    await hook(event('call.answered', { call_control_id: dial.leg, client_state: dial.clientState }))
    const [, id, nonce] = atob(dial.clientState).split(':') as [string, string, string]
    return { dial, id, nonce }
  }

  test('events on a leg of someone’s own, carrying the victim’s id, a guessed nonce or even the right nonce, change nothing', async () => {
    const { dial, id, nonce } = await inProgress()
    const forged = [`meet:${id}`, `meet:${id}:0000000000000000`, `meet:${id}:${nonce}`, `meet:${Number(id) + 1}:${nonce}`]
    h.clock.now += 5 * 60_000
    for (const f of forged) {
      await hook(event('call.hangup', { call_control_id: 'thief-leg', client_state: btoa(f) }))
      await hook(event('call.answered', { call_control_id: 'thief-leg', client_state: btoa(f) }))
    }
    expect(minutes()).toBe(0)
    expect(h.phone.telnyx.of('hangup')).toHaveLength(0)
    expect((await a.tm(OWNER, 'GET', `${P}/calls`)).json.calls[0]).toMatchObject({ outcome: 'dialing', minutes: 0 })
    // The real leg still ends the call, and its minutes are the real ones.
    await hook(event('call.hangup', { call_control_id: dial.leg, client_state: dial.clientState }))
    expect(minutes()).toBe(5)
  })

  test('the real leg is told by its id even when its client state is missing or wrong', async () => {
    const { dial } = await inProgress()
    h.clock.now += 60_000
    await hook(event('call.hangup', { call_control_id: dial.leg }))
    expect(minutes()).toBe(1)
  })

  test('a call dressed in meet’s client state is not thereby meet’s own: with no approval it is hung up like any other', async () => {
    await setUp()
    await hook(event('call.initiated', { call_control_id: 'thief', to: '+16265550123', direction: 'outgoing', state: 'parked', client_state: btoa('meet:1:0123456789abcdef') }))
    expect(h.phone.telnyx.of('dial')).toHaveLength(0)
    expect(h.phone.telnyx.of('hangup').map((c) => c.leg)).toEqual(['thief'])
  })

  test('the id is not a count anyone can walk: two calls’ nonces differ and are 64 bits', async () => {
    await setUp()
    const states: string[] = []
    for (const leg of ['n1', 'n2']) {
      const ok = await approve('626 555 0123')
      await hook(parked(leg, ok.json.to, ok.json.ticket))
      states.push(atob(h.phone.telnyx.of('dial').at(-1)!.clientState))
    }
    const nonces = states.map((x) => x.split(':')[2])
    expect(nonces[0]).toMatch(/^[0-9a-f]{16}$/)
    expect(nonces[0]).not.toBe(nonces[1])
  })
})

describe('911 does not depend on one field, and meet’s own 911 leg never starts another', () => {
  const forms = ['911', '+1911', '1911', 'sip:911@sip.telnyx.com', 'sips:+1911@sip.telnyx.com;user=phone', '<sip:911@sip.telnyx.com>', 'tel:911', '933', 'sip:933@sip.telnyx.com']
  for (const to of forms) {
    test(`a parked call to ${JSON.stringify(to)} is dialed as ${to.includes('933') ? '933' : '911'}, once`, async () => {
      await setUp()
      await hook(event('call.initiated', { call_control_id: 'e1', to, direction: 'outgoing', state: 'parked' }))
      const dials = h.phone.telnyx.of('dial')
      expect(dials).toHaveLength(1)
      expect(dials[0]).toMatchObject({ to: to.includes('933') ? '933' : '911', from: LINE_NUMBER })
    })
  }

  test('either Telnyx’s parked state or an outgoing direction is enough, and an incoming call is neither', async () => {
    await setUp()
    await hook(event('call.initiated', { call_control_id: 'a', to: '911', state: 'parked' }))
    await hook(event('call.initiated', { call_control_id: 'b', to: '911', direction: 'outgoing' }))
    expect(h.phone.telnyx.of('dial')).toHaveLength(2)
    await hook(event('call.initiated', { call_control_id: 'c', to: '911', direction: 'incoming', state: 'ringing' }))
    expect(h.phone.telnyx.of('dial')).toHaveLength(2)
  })

  test('meet’s dialed 911 leg, announcing itself with no client state, while the dial request is still out, is not handled again', async () => {
    await setUp()
    h.phone.telnyx.duringDial = async () => {
      await hook(event('call.initiated', { call_control_id: 'whatever-the-new-leg-is', to: '911', direction: 'outgoing', state: 'parked' }))
    }
    await hook(event('call.initiated', { call_control_id: 'e1', to: '911', direction: 'outgoing', state: 'parked' }))
    h.phone.telnyx.duringDial = null
    expect(h.phone.telnyx.of('dial')).toHaveLength(1)
    expect(h.phone.telnyx.of('hangup')).toHaveLength(0)
  })

  test('and once its leg is stored, any later event for that leg is its own, whatever the client state says', async () => {
    await setUp()
    await hook(event('call.initiated', { call_control_id: 'e1', to: '911', direction: 'outgoing', state: 'parked' }))
    await hook(event('call.initiated', { call_control_id: 'leg-1', to: '911', direction: 'outgoing', state: 'parked' }))
    await hook(event('call.initiated', { call_control_id: 'leg-1', to: 'sip:911@sip.telnyx.com', direction: 'outgoing', client_state: btoa('rubbish') }))
    expect(h.phone.telnyx.of('dial')).toHaveLength(1)
  })

  test('a second, real 911 call from the browser afterwards is dialed: the in-flight rule is for a moment, not for ever', async () => {
    await setUp()
    await hook(event('call.initiated', { call_control_id: 'e1', to: '911', direction: 'outgoing', state: 'parked' }))
    await hook(event('call.initiated', { call_control_id: 'e2', to: '911', direction: 'outgoing', state: 'parked' }))
    expect(h.phone.telnyx.of('dial')).toHaveLength(2)
  })

  test('a number in a SIP form that is not 911 is judged as the number it is', async () => {
    await setUp()
    const ok = await approve('626 555 0123')
    await hook(event('call.initiated', { call_control_id: 'b1', to: 'sip:+16265550123@sip.telnyx.com', direction: 'outgoing', state: 'parked', client_state: btoa(JSON.stringify({ t: ok.json.ticket, w: 'x' })) }))
    expect(h.phone.telnyx.of('dial')[0]).toMatchObject({ to: '+16265550123' })
  })
})

describe('a second person’s call is never swallowed by a dial in flight', () => {
  test('two people dialing 911 within the first call’s dial window: both are dialed, and both are emailed', async () => {
    h.phonePeople[ANA] = { emergencyNumber: '+12135550111' }
    await setUp()
    await setUp(ANA)
    const tessa = (await a.tm(OWNER, 'GET', P)).json.who
    const ana = (await a.tm(ANA, 'GET', P)).json.who
    h.phone.telnyx.duringDial = async () => {
      h.phone.telnyx.duringDial = null
      await hook(event('call.initiated', { call_control_id: 'e2', to: '911', direction: 'outgoing', state: 'parked', client_state: btoa(JSON.stringify({ t: null, w: ana })) }))
    }
    await hook(event('call.initiated', { call_control_id: 'e1', to: '911', direction: 'outgoing', state: 'parked', client_state: btoa(JSON.stringify({ t: null, w: tessa })) }))
    const dials = h.phone.telnyx.of('dial')
    expect(dials.map((d) => d.from).sort()).toEqual(['+12135550111', LINE_NUMBER].sort())
    expect(mailTo(OWNER).filter((m) => m.subject === '911 was dialed from meet')).toHaveLength(2)
    // A redelivery of the second call's event is not a third dial.
    await hook(event('call.initiated', { call_control_id: 'e2', to: '911', direction: 'outgoing', state: 'parked', client_state: btoa(JSON.stringify({ t: null, w: ana })) }, 'evt-again'))
    expect(h.phone.telnyx.of('dial')).toHaveLength(2)
  })

  test('the same for an ordinary call: a second approved call to the same number while the first is dialing is dialed', async () => {
    h.phonePeople[ANA] = { emergencyNumber: '+12135550111' }
    await setUp()
    await setUp(ANA)
    const second = await approve('626 555 0123', ANA)
    h.phone.telnyx.duringDial = async () => {
      h.phone.telnyx.duringDial = null
      await hook(parked('b2', second.json.to, second.json.ticket, 'x'))
    }
    const first = await approve('626 555 0123')
    await hook(parked('b1', first.json.to, first.json.ticket))
    expect(h.phone.telnyx.of('dial')).toHaveLength(2)
  })
})

describe('only calls the browser placed on meet’s connection are meet’s to decide', () => {
  test('an incoming call to a number that is not meet’s, in any state, is left alone: nothing dialed, nothing hung up, nothing logged', async () => {
    await setUp()
    // (A call to the Northfield Works number itself rings; that is calls in, in phone-inbound.test.ts.)
    for (const [leg, state] of [['i1', 'parked'], ['i2', 'ringing'], ['i3', undefined]] as const) {
      await hook(event('call.initiated', { call_control_id: leg, to: '+16265550199', from: '+12135550199', direction: 'incoming', ...(state ? { state } : {}) }))
    }
    await hook(event('call.initiated', { call_control_id: 'psap', to: '+16265550199', direction: 'inbound', state: 'parked' }))
    await hook(event('call.hangup', { call_control_id: 'i1' }))
    expect(asked()).toEqual([])
    expect((await a.tm(OWNER, 'GET', `${P}/calls`)).json.calls).toEqual([])
    expect(h.phoneCore.recent(OWNER)).toEqual([])
  })

  test('an event on another connection than meet’s is ignored, and one on meet’s own is handled', async () => {
    await setUp()
    const ok = await approve('626 555 0123')
    const state = btoa(JSON.stringify({ t: ok.json.ticket, w: 'x' }))
    await hook(event('call.initiated', { call_control_id: 'other', to: ok.json.to, direction: 'outgoing', state: 'parked', connection_id: 'someone-elses', client_state: state }))
    expect(asked()).toEqual([])
    await hook(event('call.initiated', { call_control_id: 'mine', to: ok.json.to, direction: 'outgoing', state: 'parked', connection_id: 'conn-1', client_state: state }))
    expect(h.phone.telnyx.of('dial')).toHaveLength(1)
  })

  test('a parked call that names no direction is still a browser call', async () => {
    await setUp()
    await hook(event('call.initiated', { call_control_id: 'p', to: '911', state: 'parked' }))
    expect(h.phone.telnyx.of('dial')).toHaveLength(1)
  })
})

describe('the daily balance check is done only when the balance was read', () => {
  test('a Telnyx that did not answer is asked again at the next run, and a read ends the day', async () => {
    h.phone.telnyx.failBalance = true
    await runCron(h.deps)
    await runCron(h.deps)
    expect(h.phone.telnyx.of('balance')).toHaveLength(2)
    h.phone.telnyx.failBalance = false
    h.phone.telnyx.balanceUsd = 2
    await runCron(h.deps)
    await runCron(h.deps)
    expect(h.phone.telnyx.of('balance')).toHaveLength(3)
    expect(mailTo(OWNER).map((m) => m.subject)).toEqual(['meet is running low on phone credit'])
  })
})

describe('the log', () => {
  test('each person sees their own calls, newest first, with the number as people read it', async () => {
    h.phonePeople[ANA] = { emergencyNumber: '+12135550111' }
    await setUp()
    await setUp(ANA)
    await call('626 555 0123', 30)
    const ok = await approve('626 555 0177', ANA)
    await hook(parked('ana', ok.json.to, ok.json.ticket))
    const mine = (await a.tm(OWNER, 'GET', `${P}/calls`)).json.calls
    expect(mine.map((c: { display: string }) => c.display)).toEqual(['(626) 555-0123'])
    expect(mine[0]).toMatchObject({ outcome: 'completed', minutes: 1, emergency: false })
    expect((await a.tm(ANA, 'GET', `${P}/calls`)).json.calls.map((c: { display: string }) => c.display)).toEqual(['(626) 555-0177'])
  })

  test('a call refused at the webhook after a real approval is logged under the person, with its reason; one with no approval has no person to log it under', async () => {
    await setUp()
    const ok = await approve('626 555 0123')
    await hook(parked('b1', '+16265550199', ok.json.ticket))
    await hook(parked('b2', '+19005550123', null))
    const log = (await a.tm(OWNER, 'GET', `${P}/calls`)).json.calls
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ outcome: 'refused', reason: 'ticket', number: '+16265550199', minutes: 0 })
  })
})

describe('the cron: the phone’s tidy-up and its daily balance check', () => {
  test('once a day the balance is read, and Tessa is emailed only when it is under $5', async () => {
    h.phone.telnyx.balanceUsd = 3.5
    await runCron(h.deps)
    expect(mailTo(OWNER).map((m) => m.subject)).toEqual(['meet is running low on phone credit'])
    expect(mailTo(OWNER)[0]?.text).toContain('$3.50')
    // Run again the same day, and again the next with enough in it.
    await runCron(h.deps)
    expect(h.phone.telnyx.of('balance')).toHaveLength(1)
    h.clock.now += 24 * 3_600_000
    h.phone.telnyx.balanceUsd = 50
    await runCron(h.deps)
    expect(h.phone.telnyx.of('balance')).toHaveLength(2)
    expect(mailTo(OWNER)).toHaveLength(1)
  })

  test('a Telnyx that does not answer does not stop the cron', async () => {
    h.phone.telnyx.failBalance = true
    await runCron(h.deps)
    expect(h.mail).toHaveLength(0)
  })

  test('expired approvals are swept', async () => {
    await setUp()
    await approve('626 555 0123')
    h.clock.now += 120_000
    h.phoneCore.sweep(h.clock.now)
    const ok = await approve('626 555 0124')
    expect(ok.status).toBe(200)
  })
})

describe('the low-balance check is done only when Tessa has been told', () => {
  test('a send that fails leaves the day’s check to the next run, which sends it once', async () => {
    h.phone.telnyx.balanceUsd = 1
    h.mailFails.on = true
    await runCron(h.deps)
    expect(mailTo(OWNER)).toHaveLength(0)
    h.mailFails.on = false
    await runCron(h.deps)
    expect(mailTo(OWNER).map((m) => m.subject)).toEqual(['meet is running low on phone credit'])
    await runCron(h.deps)
    expect(mailTo(OWNER)).toHaveLength(1)
    expect(h.phone.telnyx.of('balance')).toHaveLength(2)
  })
})
