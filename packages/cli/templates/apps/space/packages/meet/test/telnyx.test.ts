// Telnyx's side of the phone, with no network: the requests meet makes (path and body, pinned so a change is seen), the
// signature check on its webhooks, the reading of its events, and the one-time setup script against a fake account.
import { describe, expect, test } from 'bun:test'
import { BUNDLED_INSTALL } from '../src/company'
import { LINE, PHONE_SECRETS, lineWords, phoneSecretsToPush } from '../src/phone-line'
import { cleanAddress, formatUs, parseDestination } from '../src/phone-model'
import { type Http, TelnyxError, parseEvent, telnyxClient, telnyxHttp, verifyWebhook } from '../src/telnyx'
import { phoneRuntime } from '../src/phone-runtime'
import { runSetup } from '../src/telnyx-setup'

const KEY = 'KEY0123456789-never-printed'

/** A fetch that records each request and answers from a table. */
function stubFetch(answer: (method: string, path: string, body: any) => { status?: number; body?: unknown; text?: string }) {
  const seen: Array<{ method: string; path: string; body: any; headers: Headers }> = []
  const fetchImpl = async (url: string, init: RequestInit) => {
    const path = url.replace('https://api.telnyx.com/v2', '')
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    seen.push({ method: String(init.method), path, body, headers: new Headers(init.headers) })
    const r = answer(String(init.method), path, body)
    return new Response(r.text ?? JSON.stringify(r.body ?? {}), { status: r.status ?? 200 })
  }
  return { seen, fetchImpl }
}

describe('the requests meet makes to Telnyx', () => {
  test('the key is sent as a bearer header and appears in nothing else, not even an error', async () => {
    const s = stubFetch(() => ({ status: 401, text: 'bad key' }))
    const http = telnyxHttp(KEY, s.fetchImpl)
    const err = (await http.request('GET', '/balance').catch((e) => e)) as TelnyxError
    expect(err).toBeInstanceOf(TelnyxError)
    expect(err.status).toBe(401)
    expect(`${err.message}`).not.toContain(KEY)
    expect(s.seen[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    const down = telnyxHttp(KEY, async () => Promise.reject(new Error(`could not reach with ${KEY}`)))
    const e2 = (await down.request('GET', '/balance').catch((e) => e)) as TelnyxError
    expect(e2.status).toBe(0)
    expect(e2.message).not.toContain(KEY)
  })

  test('a credential is made on the connection, tagged ours; its login token is the plain-text answer of the token endpoint', async () => {
    const s = stubFetch((_m, path) => (path.endsWith('/token') ? { text: 'jwt.token.here\n' } : { body: { data: { id: 'cred-1', sip_username: 'gencred9' } } }))
    const t = telnyxClient(telnyxHttp(KEY, s.fetchImpl), { connectionId: 'conn-1' })
    expect(await t.createCredential('meet tessa@northfield.example')).toEqual({ id: 'cred-1', sipUsername: 'gencred9' })
    expect(await t.loginToken('cred-1')).toBe('jwt.token.here')
    expect(s.seen.map((r) => [r.method, r.path])).toEqual([
      ['POST', '/telephony_credentials'],
      ['POST', '/telephony_credentials/cred-1/token'],
    ])
    expect(s.seen[0]?.body).toEqual({ connection_id: 'conn-1', name: 'meet tessa@northfield.example', tag: 'meet' })
  })

  test('a dial is a call from the number, named, linked to the parked leg and bridged on answer, with a time limit and meet’s client state', async () => {
    const s = stubFetch(() => ({ body: { data: { call_control_id: 'leg-7' } } }))
    const t = telnyxClient(telnyxHttp(KEY, s.fetchImpl), { connectionId: 'conn-1' })
    expect(await t.dial({ to: '+16265550123', from: '+16265550100', fromName: 'Northfield Works', linkTo: 'parked-1', clientState: 'c3RhdGU=', timeLimitSecs: 14400 })).toEqual({ leg: 'leg-7' })
    expect(s.seen[0]).toMatchObject({
      method: 'POST',
      path: '/calls',
      body: { connection_id: 'conn-1', to: '+16265550123', from: '+16265550100', from_display_name: 'Northfield Works', link_to: 'parked-1', bridge_on_answer: true, time_limit_secs: 14400, client_state: 'c3RhdGU=' },
    })
    // No recording is asked for: California needs every party's consent.
    expect(JSON.stringify(s.seen[0]?.body)).not.toContain('record')
  })

  test('hanging up a leg that is already gone is not an error, any other refusal is', async () => {
    for (const [status, throws] of [[404, false], [422, false], [500, true]] as const) {
      const t = telnyxClient(telnyxHttp(KEY, stubFetch(() => ({ status, text: 'x' })).fetchImpl), { connectionId: 'c' })
      expect(await t.hangup('leg').then(() => false, () => true)).toBe(throws)
    }
  })

  test('a 911 address is made, then enabled on the number found by its digits', async () => {
    const s = stubFetch((_m, path) => {
      if (path.startsWith('/phone_numbers?')) return { body: { data: [{ id: 'num-1' }] } }
      if (path === '/addresses') return { body: { data: { id: 'addr-1' } } }
      return { body: {} }
    })
    const t = telnyxClient(telnyxHttp(KEY, s.fetchImpl), { connectionId: 'c' })
    const done = await t.registerEmergencyAddress('+16265550100', { street: '1 Main St', extended: '', city: 'Springfield', state: 'CA', zip: '91101' }, { first: 'Tessa', last: 'Northfield Works', business: 'Northfield Works' })
    expect(done).toEqual({ addressId: 'addr-1' })
    expect(s.seen.map((r) => [r.method, r.path])).toEqual([
      ['GET', '/phone_numbers?filter[phone_number]=%2B16265550100'],
      ['POST', '/addresses'],
      ['POST', '/phone_numbers/num-1/actions/enable_emergency'],
    ])
    expect(s.seen[1]?.body).toMatchObject({ first_name: 'Tessa', last_name: 'Northfield Works', business_name: 'Northfield Works', street_address: '1 Main St', locality: 'Springfield', administrative_area: 'CA', postal_code: '91101', country_code: 'US' })
    expect(s.seen[2]?.body).toEqual({ emergency_enabled: true, emergency_address_id: 'addr-1' })
  })

  test('a number Telnyx does not have is an error, not a silent skip', async () => {
    const t = telnyxClient(telnyxHttp(KEY, stubFetch(() => ({ body: { data: [] } })).fetchImpl), { connectionId: 'c' })
    expect(await t.registerEmergencyAddress('+16265550100', { street: 'a', extended: '', city: 'b', state: 'CA', zip: '91101' }, { first: 'a', last: 'b', business: 'c' }).catch((e) => e.status)).toBe(404)
  })

  test('the balance is read as a number, from either of the fields Telnyx uses', async () => {
    for (const body of [{ data: { available_credit: '12.50' } }, { data: { balance: 12.5 } }]) {
      const t = telnyxClient(telnyxHttp(KEY, stubFetch(() => ({ body })).fetchImpl), { connectionId: 'c' })
      expect(await t.balance()).toEqual({ availableUsd: 12.5 })
    }
  })
})

describe('the requests meet makes to take a call (docs/adr/0005)', () => {
  const client = (answer: Parameters<typeof stubFetch>[0] = () => ({ body: { data: { call_control_id: 'leg-1' } } })) => {
    const s = stubFetch(answer)
    return { s, t: telnyxClient(telnyxHttp(KEY, s.fetchImpl), { connectionId: 'conn-1' }) }
  }

  test('a leg for a call in is a call from the caller’s number, linked to the parked call with the intent to bridge, timed out, and NOT bridged on answer or recorded', async () => {
    const { s, t } = client()
    expect(await t.ring({ to: 'sip:gencred1@sip.telnyx.com', from: '+12135550199', fromName: '(213) 555-0199', linkTo: 'parked-1', clientState: 'c3RhdGU=', timeoutSecs: 20, timeLimitSecs: 14400 })).toEqual({ leg: 'leg-1' })
    expect(s.seen[0]).toMatchObject({
      method: 'POST',
      path: '/calls',
      body: { connection_id: 'conn-1', to: 'sip:gencred1@sip.telnyx.com', from: '+12135550199', from_display_name: '(213) 555-0199', link_to: 'parked-1', bridge_intent: true, timeout_secs: 20, time_limit_secs: 14400, client_state: 'c3RhdGU=' },
    })
    expect(s.seen[0]?.body).not.toHaveProperty('bridge_on_answer')
    expect(JSON.stringify(s.seen[0]?.body)).not.toContain('record')
  })

  test('answer, bridge, the screening prompt and the greeting are commands on a leg, each carrying meet’s client state', async () => {
    const { s, t } = client(() => ({ body: {} }))
    await t.answer('in-1', 'cw==')
    await t.bridge('in-1', 'ring-1', 'cw==')
    await t.screen('cell-1', 'Call for Northfield Works. Press 1 to answer.', 'cw==')
    await t.speak('in-1', 'You have reached Northfield Works.', 'cw==')
    expect(s.seen.map((r) => [r.method, r.path])).toEqual([
      ['POST', '/calls/in-1/actions/answer'],
      ['POST', '/calls/in-1/actions/bridge'],
      ['POST', '/calls/cell-1/actions/gather_using_speak'],
      ['POST', '/calls/in-1/actions/speak'],
    ])
    expect(s.seen[0]?.body).toEqual({ client_state: 'cw==' })
    expect(s.seen[1]?.body).toEqual({ call_control_id: 'ring-1', client_state: 'cw==' })
    // One key, and only 1: anything else (a cell’s own voicemail says nothing) is not an answer.
    expect(s.seen[2]?.body).toMatchObject({ payload: 'Call for Northfield Works. Press 1 to answer.', minimum_digits: 1, maximum_digits: 1, valid_digits: '1', maximum_tries: 1, client_state: 'cw==' })
    expect(s.seen[3]?.body).toMatchObject({ payload: 'You have reached Northfield Works.', client_state: 'cw==' })
  })

  test('the only recording is the voicemail’s: an mp3, one channel, a beep first, at most the length given', async () => {
    const { s, t } = client(() => ({ body: {} }))
    await t.record('in-1', 180, 'cw==')
    expect(s.seen[0]).toMatchObject({ method: 'POST', path: '/calls/in-1/actions/record_start', body: { format: 'mp3', channels: 'single', play_beep: true, max_length: 180, client_state: 'cw==' } })
  })

  test('a voicemail’s sound is fetched from the link Telnyx gives, WITHOUT meet’s key, and the link goes no further than this call', async () => {
    const seen: Array<{ url: string; headers: Headers }> = []
    const fetchImpl = async (url: string, init: RequestInit) => {
      seen.push({ url, headers: new Headers(init.headers) })
      if (url.startsWith('https://api.telnyx.com/v2/recordings/rec-1')) return new Response(JSON.stringify({ data: { download_urls: { mp3: 'https://storage.example/rec-1.mp3?sig=abc' } } }))
      return new Response('SOUND', { status: 206, headers: { 'content-type': 'audio/mpeg' } })
    }
    const t = telnyxClient(telnyxHttp(KEY, fetchImpl), { connectionId: 'c' })
    const res = await t.recordingAudio('rec-1', 'bytes=0-3')
    expect(res.status).toBe(206)
    expect(await res.text()).toBe('SOUND')
    expect(seen[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(seen[1]?.url).toBe('https://storage.example/rec-1.mp3?sig=abc')
    expect(seen[1]?.headers.get('authorization')).toBeNull()
    expect(seen[1]?.headers.get('range')).toBe('bytes=0-3')
  })

  test('a link that is not https, or none at all, is an error; a storage that cannot be reached is an error that names no link', async () => {
    for (const body of [{ data: { download_urls: { mp3: 'http://storage.example/x' } } }, { data: { download_urls: {} } }, { data: {} }]) {
      const t = telnyxClient(telnyxHttp(KEY, stubFetch(() => ({ body })).fetchImpl), { connectionId: 'c' })
      expect(await t.recordingAudio('rec-1', null).catch((e) => e.status)).toBe(502)
    }
    const fetchImpl = async (url: string) => {
      if (url.includes('/recordings/')) return new Response(JSON.stringify({ data: { download_urls: { mp3: 'https://storage.example/secret-link?sig=abc' } } }))
      throw new Error('could not reach https://storage.example/secret-link?sig=abc')
    }
    const err = (await telnyxClient(telnyxHttp(KEY, fetchImpl), { connectionId: 'c' }).recordingAudio('rec-1', null).catch((e) => e)) as TelnyxError
    expect(err).toBeInstanceOf(TelnyxError)
    expect(err.message).not.toContain('secret-link')
  })

  test('deleting a recording that is already gone is what was wanted; any other refusal is an error', async () => {
    for (const [status, throws] of [[200, false], [404, false], [500, true]] as const) {
      const { s, t } = client(() => ({ status, body: {} }))
      expect(await t.deleteRecording('rec-1').then(() => false, () => true)).toBe(throws)
      expect(s.seen[0]).toMatchObject({ method: 'DELETE', path: '/recordings/rec-1' })
    }
  })
})

describe('Telnyx’s signature on a webhook', () => {
  const b64 = (b: ArrayBuffer) => Buffer.from(b).toString('base64')
  async function keys() {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
    return { pair, pub: b64(await crypto.subtle.exportKey('raw', pair.publicKey)) }
  }
  const NOW = Date.UTC(2026, 10, 1, 12, 0, 0)
  const ts = String(NOW / 1000)

  test('the timestamp and the body, joined by a bar, signed with Ed25519, are accepted; any change is not', async () => {
    const { pair, pub } = await keys()
    const body = '{"data":{"id":"1"}}'
    const sig = b64(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(`${ts}|${body}`)))
    const ok = { publicKey: pub, signature: sig, timestamp: ts, body, now: NOW }
    expect(await verifyWebhook(ok)).toBe(true)
    expect(await verifyWebhook({ ...ok, body: `${body} ` })).toBe(false)
    expect(await verifyWebhook({ ...ok, timestamp: String(NOW / 1000 + 1) })).toBe(false)
    expect(await verifyWebhook({ ...ok, signature: undefined })).toBe(false)
    expect(await verifyWebhook({ ...ok, publicKey: (await keys()).pub })).toBe(false)
    expect(await verifyWebhook({ ...ok, publicKey: 'not base64 at all!' })).toBe(false)
    expect(await verifyWebhook({ ...ok, now: NOW + 5 * 60_000 + 1000 })).toBe(false)
    expect(await verifyWebhook({ ...ok, now: NOW + 4 * 60_000 })).toBe(true)
  })
})

describe('reading a Telnyx event', () => {
  const wrap = (payload: Record<string, unknown>, type = 'call.initiated') => ({ data: { id: 'e1', event_type: type, occurred_at: '2026-11-01T12:00:00Z', payload } })

  test('the page’s approval is read from client state, and from custom headers in either of Telnyx’s spellings', () => {
    const state = btoa(JSON.stringify({ t: 'ticket-1', w: 'who-1' }))
    expect(parseEvent(wrap({ call_control_id: 'l', to: '+1', direction: 'outgoing', client_state: state }))).toMatchObject({ ticket: 'ticket-1', who: 'who-1', ours: null, leg: 'l', at: Date.parse('2026-11-01T12:00:00Z') })
    expect(parseEvent(wrap({ call_control_id: 'l', custom_headers: [{ header_name: 'x-meet-ticket', header_value: 'T2' }, { header_name: 'X-Meet-Who', header_value: 'W2' }] }))).toMatchObject({ ticket: 'T2', who: 'W2' })
    expect(parseEvent(wrap({ call_control_id: 'l', custom_headers: [{ name: 'X-Meet-Ticket', value: 'T3' }] }))).toMatchObject({ ticket: 'T3' })
  })

  test('a call in: who called, the key pressed at the screening, the recording and its times, and the leg meet made (by its row)', () => {
    expect(parseEvent(wrap({ call_control_id: 'l', from: '+12135550199', to: '+16265550100', direction: 'incoming', state: 'parked' }))).toMatchObject({ from: '+12135550199', direction: 'incoming', state: 'parked' })
    expect(parseEvent(wrap({ call_control_id: 'l' }))).toMatchObject({ from: '', digits: null, gather: null, recordingId: null, recordingStart: null, recordingEnd: null })
    expect(parseEvent(wrap({ call_control_id: 'l', digits: '1', status: 'valid' }, 'call.gather.ended'))).toMatchObject({ digits: '1', gather: 'valid' })
    expect(parseEvent(wrap({ call_control_id: 'l', recording_id: 'rec-9', recording_started_at: '2026-11-01T12:00:00Z', recording_ended_at: '2026-11-01T12:00:42Z' }, 'call.recording.saved'))).toMatchObject({
      recordingId: 'rec-9',
      recordingStart: Date.parse('2026-11-01T12:00:00Z'),
      recordingEnd: Date.parse('2026-11-01T12:00:42Z'),
    })
    expect(parseEvent(wrap({ call_control_id: 'l', client_state: btoa('meet:12:0123456789abcdef:7') }))).toMatchObject({ ours: { id: 12, nonce: '0123456789abcdef', leg: 7 } })
    // A call out’s state has no leg part, and a malformed one is nobody’s.
    expect(parseEvent(wrap({ call_control_id: 'l', client_state: btoa('meet:12:0123456789abcdef') }))).toMatchObject({ ours: { id: 12, leg: null } })
    expect(parseEvent(wrap({ call_control_id: 'l', client_state: btoa('meet:12:0123456789abcdef:x') }))?.ours).toBeNull()
  })

  test('the connection and the call’s state are read, for telling meet’s calls from others', () => {
    expect(parseEvent(wrap({ call_control_id: 'l', connection_id: 'conn-9', state: 'parked', direction: 'outgoing' }))).toMatchObject({ connection: 'conn-9', state: 'parked', direction: 'outgoing' })
    expect(parseEvent(wrap({ call_control_id: 'l' }))).toMatchObject({ connection: null, state: null })
  })

  test('meet’s own client state marks the leg it dialed and carries no ticket', () => {
    expect(parseEvent(wrap({ call_control_id: 'l', client_state: btoa('meet:42:0123456789abcdef') }))).toMatchObject({ ours: { id: 42, nonce: '0123456789abcdef' }, ticket: null, who: null })
    // The old sequential form, and a nonce that is not 64 bits of hex, are not the form meet makes.
    for (const bad of ['meet:42', 'meet:42:abc', 'meet:42:0123456789ABCDEFG']) expect(parseEvent(wrap({ call_control_id: 'l', client_state: btoa(bad) }))?.ours).toBeNull()
  })

  test('hang-up times and cause are read, and anything that is not a call event is null', () => {
    expect(parseEvent(wrap({ call_control_id: 'l', start_time: '2026-11-01T12:00:00Z', end_time: '2026-11-01T12:03:00Z', hangup_cause: 'normal_clearing' }, 'call.hangup'))).toMatchObject({ end: Date.parse('2026-11-01T12:03:00Z'), cause: 'normal_clearing' })
    for (const bad of [null, {}, { data: {} }, { data: { id: 'x', event_type: 'call.hangup', payload: {} } }, 'text']) expect(parseEvent(bad)).toBeNull()
  })

  test('client state that is not base64 JSON is ignored, not thrown on', () => {
    expect(parseEvent(wrap({ call_control_id: 'l', client_state: '%%%' }))).toMatchObject({ ticket: null, who: null, ours: null })
    expect(parseEvent(wrap({ call_control_id: 'l', client_state: btoa('not json') }))).toMatchObject({ ticket: null })
  })
})

describe('whether this Worker has a phone at all', () => {
  const key = Buffer.from(new Uint8Array(32).fill(7)).toString('base64')
  const all = { TELNYX_API_KEY: 'k', TELNYX_PUBLIC_KEY: key, TELNYX_CONNECTION_ID: 'c', TELNYX_NUMBER: '+16265550100' }
  const logs: string[] = []
  const rt = (env: Parameters<typeof phoneRuntime>[0], local = false) => phoneRuntime(env, local, (m) => logs.push(m))

  test('with no secrets there is no phone, and nothing is logged as wrong', () => {
    expect(rt({})).toBeNull()
    expect(logs).toEqual([])
  })
  test('with any one of the four missing there is no phone, and the log says how many are set', () => {
    for (const missing of Object.keys(all) as Array<keyof typeof all>) {
      const { [missing]: _gone, ...rest } = all
      expect(rt(rest)).toBeNull()
    }
    expect(logs).toHaveLength(4)
    expect(logs[0]).toContain('only 3 of its 4 secrets')
  })
  test('with all four there is the real phone, with the stand-in off', () => {
    const r = rt(all)
    expect(r).toMatchObject({ sdk: 'telnyx', number: '+16265550100', publicKey: key, dev: false })
    expect(rt({ ...all, FAKE_TELNYX: '1' })).toMatchObject({ sdk: 'telnyx' })
  })
  test('a number that is not a US E.164 number, or a key that is not 32 bytes of base64, hides the phone', () => {
    for (const bad of [{ TELNYX_NUMBER: '6265550100' }, { TELNYX_NUMBER: '+4420794600958' }, { TELNYX_PUBLIC_KEY: 'short' }, { TELNYX_PUBLIC_KEY: `${key}AAAA` }]) expect(rt({ ...all, ...bad })).toBeNull()
  })
  test('the stand-in is for a localhost run alone', () => {
    expect(rt({ FAKE_TELNYX: '1' }, true)).toMatchObject({ sdk: 'fake', dev: true })
    expect(rt({ FAKE_TELNYX: '1' }, false)).toBeNull()
  })
})

describe('the phone secrets the deploy pushes', () => {
  test('none in sops means none pushed, so the phone stays hidden and the deploy goes on', () => {
    expect(phoneSecretsToPush(['MEET_REALTIME_APP_SECRET', 'MEET_TURN_KEY_TOKEN'])).toEqual([])
  })
  test('all four in sops means all four pushed', () => {
    expect(phoneSecretsToPush(['A', ...PHONE_SECRETS])).toEqual([...PHONE_SECRETS])
  })
  test('some of them fail loudly and name what is missing, before anything is deployed', () => {
    expect(() => phoneSecretsToPush(['TELNYX_API_KEY', 'TELNYX_NUMBER'])).toThrow(/TELNYX_PUBLIC_KEY, TELNYX_CONNECTION_ID/)
  })
  test('the four are the ones the Worker reads, the key is among them, and the profile id is not (only the setup script uses it)', () => {
    expect([...PHONE_SECRETS]).toEqual(['TELNYX_API_KEY', 'TELNYX_PUBLIC_KEY', 'TELNYX_CONNECTION_ID', 'TELNYX_NUMBER'])
  })
})

describe('numbers and addresses as typed', () => {
  test('a number is shown as it is typed, up to ten digits', () => {
    expect(formatUs('')).toBe('')
    expect(formatUs('62')).toBe('62')
    expect(formatUs('626555')).toBe('(626) 555')
    expect(formatUs('62655501')).toBe('(626) 555-01')
    expect(formatUs('626555012399')).toBe('(626) 555-0123')
  })
  test('the Northfield Works line itself reads as a US number', () => {
    expect(parseDestination('+16265550100')).toMatchObject({ ok: true, dest: { e164: '+16265550100', display: '(626) 555-0100' } })
  })
  test('an address is cleaned: one line each, the state upper case', () => {
    expect(cleanAddress({ street: ' 1  Main\nSt ', extended: '', city: 'Springfield', state: 'ca', zip: '91101-1234' })).toEqual({
      ok: true,
      address: { street: '1 Main St', extended: '', city: 'Springfield', state: 'CA', zip: '91101-1234' },
    })
  })
})

// --- The setup script, against a fake account -------------------------------------

type Rec = Record<string, any>
function fakeAccount(opts: { numbers?: Rec[]; forSale?: string[]; slowOrders?: boolean; orders?: Rec[] } = {}) {
  const st = {
    profiles: [] as Rec[],
    connections: [] as Rec[],
    numbers: [...(opts.numbers ?? [])] as Rec[],
    voice: new Map<string, Rec>(),
    orders: [...(opts.orders ?? [])] as Rec[],
    writes: [] as string[],
    n: 0,
  }
  const http: Http = {
    async text() {
      return ''
    },
    async file() {
      return new Response('', { status: 404 })
    },
    async request<T>(method: string, path: string, body?: any): Promise<T> {
      const [route] = path.split('?')
      const page = (rows: Rec[]) => ({ data: rows, meta: { total_pages: 1 } })
      if (method !== 'GET') st.writes.push(`${method} ${route}`)
      if (method === 'GET' && route === '/outbound_voice_profiles') return page(st.profiles) as T
      if (method === 'POST' && route === '/outbound_voice_profiles') {
        const row = { id: `ovp-${++st.n}`, ...body }
        st.profiles.push(row)
        return { data: row } as T
      }
      if (method === 'PATCH' && route?.startsWith('/outbound_voice_profiles/')) {
        Object.assign(st.profiles.find((p) => route.endsWith(p.id)) as Rec, body)
        return {} as T
      }
      if (method === 'GET' && route === '/credential_connections') return page(st.connections) as T
      if (method === 'POST' && route === '/credential_connections') {
        const row = { id: `conn-${++st.n}`, ...body }
        expect(body.password.length).toBeGreaterThan(8)
        st.connections.push(row)
        return { data: row } as T
      }
      if (method === 'PATCH' && route?.startsWith('/credential_connections/')) {
        Object.assign(st.connections.find((c) => route.endsWith(c.id)) as Rec, body)
        return {} as T
      }
      if (method === 'GET' && route === '/phone_numbers') return page(st.numbers) as T
      if (method === 'GET' && route === '/available_phone_numbers') return { data: (opts.forSale ?? []).map((phone_number) => ({ phone_number })) } as T
      if (method === 'GET' && route === '/number_orders') return page(st.orders) as T
      if (method === 'POST' && route === '/number_orders') {
        const phone_number = body.phone_numbers[0].phone_number
        // A slow order is pending and its number is not on the account yet, as a real one can be for a while.
        st.orders.push({ id: `order-${++st.n}`, status: opts.slowOrders ? 'pending' : 'success', created_at: new Date().toISOString(), phone_numbers: [{ phone_number }] })
        if (!opts.slowOrders) st.numbers.push({ id: `num-${++st.n}`, phone_number, connection_id: null })
        return { data: {} } as T
      }
      if (method === 'PATCH' && route?.match(/^\/phone_numbers\/[^/]+$/)) {
        Object.assign(st.numbers.find((n) => route.endsWith(n.id)) as Rec, body)
        return {} as T
      }
      const voice = route?.match(/^\/phone_numbers\/([^/]+)\/voice$/)
      if (voice && method === 'GET') return { data: st.voice.get(voice[1] as string) ?? {} } as T
      if (voice && method === 'PATCH') {
        st.voice.set(voice[1] as string, { ...st.voice.get(voice[1] as string), ...body })
        return {} as T
      }
      if (method === 'POST' && route === '/addresses') return { data: { id: `addr-${++st.n}` } } as T
      const en = route?.match(/^\/phone_numbers\/([^/]+)\/actions\/enable_emergency$/)
      if (en && method === 'POST') {
        st.voice.set(en[1] as string, { ...st.voice.get(en[1] as string), emergency: { emergency_enabled: true, emergency_address_id: body.emergency_address_id } })
        return {} as T
      }
      if (method === 'GET' && route === '/balance') return { data: { available_credit: '20.00' } } as T
      if (method === 'GET' && route === '/phone_numbers') return page([]) as T
      throw new Error(`the fake account has no ${method} ${path}`)
    },
  }
  return { http, st }
}

const ADDRESS = { street: '1 Main St', extended: '', city: 'Springfield', state: 'CA', zip: '91101' }
const run = (a: ReturnType<typeof fakeAccount>, o: Partial<Parameters<typeof runSetup>[1]> = {}) => {
  const lines: string[] = []
  return runSetup(a.http, { apply: false, buy: false, addresses: [], install: BUNDLED_INSTALL, site: 'https://space.northfield.example', log: (l) => lines.push(l), ...o }).then((result) => ({ result, lines: lines.join('\n') }))
}

describe('the setup script', () => {
  test('a dry run reads and reports and writes nothing, including when it would buy a number', async () => {
    const a = fakeAccount({ forSale: ['+16265550100'] })
    const { result, lines } = await run(a, { apply: false })
    expect(a.st.writes).toEqual([])
    expect(result.changes).toBeGreaterThan(0)
    expect(lines).toContain('Dry run: nothing will be changed')
    expect(lines).toContain('WOULD create the profile "meet outbound"')
    expect(lines).toContain('WOULD buy +16265550100')
  })

  test('--apply alone never buys a number', async () => {
    const a = fakeAccount({ forSale: ['+16265550100'] })
    await run(a, { apply: true, buy: false })
    expect(a.st.writes).not.toContain('POST /number_orders')
    expect(a.st.numbers).toEqual([])
  })

  test('applied with --buy it makes the profile with Tessa’s limits, the connection parked and pointed at the webhook, the number named Northfield Works and 911 on', async () => {
    const a = fakeAccount({ forSale: ['+16265550100'] })
    const { result, lines } = await run(a, { apply: true, buy: true, addresses: [{ email: 'tessa@northfield.example', address: ADDRESS }] })
    expect(a.st.profiles[0]).toMatchObject({
      name: 'meet outbound',
      whitelisted_destinations: ['US'],
      max_destination_rate: 0.05,
      daily_spend_limit: '5.00',
      daily_spend_limit_enabled: true,
      concurrent_call_limit: 3,
      enabled: true,
    })
    expect(a.st.connections[0]).toMatchObject({
      connection_name: 'meet',
      active: true,
      webhook_event_url: 'https://space.northfield.example/r/api/phone/webhook',
      webhook_api_version: '2',
      outbound: { call_parking_enabled: true, outbound_voice_profile_id: a.st.profiles[0]?.id },
    })
    expect(a.st.numbers[0]).toMatchObject({ phone_number: '+16265550100', connection_id: a.st.connections[0]?.id })
    expect(a.st.voice.get(a.st.numbers[0]?.id)).toMatchObject({ cnam_listing: { cnam_listing_enabled: true, cnam_listing_details: 'Northfield Work' }, emergency: { emergency_enabled: true } })
    expect(result).toMatchObject({ connectionId: a.st.connections[0]?.id, number: '+16265550100', profileId: a.st.profiles[0]?.id })
    expect(lines).toContain(`TELNYX_CONNECTION_ID  ${a.st.connections[0]?.id}`)
    expect(lines).toContain('TELNYX_NUMBER         +16265550100')
    // No key is ever printed, and the manual steps are listed.
    expect(lines).not.toMatch(/KEY0123|Bearer/)
    expect(result.todo.join('\n')).toMatch(/automatic top-up OFF/)
    expect(result.todo.join('\n')).toContain('TELNYX_PUBLIC_KEY')
    // Calls in need nothing else on the account, and the script says where to look instead of pretending to have set them up.
    expect(result.todo.join('\n')).toContain('ADR 0005')
  })

  test('run again with nothing left to do, it changes nothing', async () => {
    const a = fakeAccount({ forSale: ['+16265550100'] })
    const first = { apply: true, buy: true, addresses: [{ email: 'tessa@northfield.example', address: ADDRESS }] }
    await run(a, first)
    const writes = a.st.writes.length
    const again = await run(a, first)
    expect(a.st.writes).toHaveLength(writes)
    expect(again.result.changes).toBe(0)
    expect(again.lines).toContain('OK    the profile "meet outbound" already has the limits')
    expect(again.lines).toContain('OK    caller name "Northfield Work" is listed')
    expect(again.lines).toContain('911 is on for +16265550100')
  })

  test('a profile that has drifted is put back, and says what had drifted', async () => {
    const a = fakeAccount({ forSale: ['+16265550100'] })
    await run(a, { apply: true, buy: true })
    Object.assign(a.st.profiles[0] as Rec, { whitelisted_destinations: ['US', 'CA'], daily_spend_limit: '500.00', max_destination_rate: 1 })
    const { lines } = await run(a, { apply: true })
    expect(lines).toContain('set the profile\'s destinations (US,CA), price ceiling (1), daily limit (500.00')
    expect(a.st.profiles[0]).toMatchObject({ whitelisted_destinations: ['US'], daily_spend_limit: '5.00', max_destination_rate: 0.05 })
  })

  test('a connection that has lost parking or its webhook is put back', async () => {
    const a = fakeAccount({ forSale: ['+16265550100'] })
    await run(a, { apply: true, buy: true })
    Object.assign(a.st.connections[0] as Rec, { outbound: { call_parking_enabled: false, outbound_voice_profile_id: 'other' }, webhook_event_url: 'https://elsewhere.example/hook' })
    await run(a, { apply: true })
    expect(a.st.connections[0]).toMatchObject({ webhook_event_url: 'https://space.northfield.example/r/api/phone/webhook', outbound: { call_parking_enabled: true, outbound_voice_profile_id: a.st.profiles[0]?.id } })
  })

  test('an existing 626 number is used and not bought again; two of them stop it and ask which', async () => {
    const one = fakeAccount({ numbers: [{ id: 'n1', phone_number: '+16265550111', connection_id: null }], forSale: ['+16265550100'] })
    const r = await run(one, { apply: true, buy: true })
    expect(r.result.number).toBe('+16265550111')
    expect(one.st.writes).not.toContain('POST /number_orders')
    const two = fakeAccount({ numbers: [{ id: 'n1', phone_number: '+16265550111' }, { id: 'n2', phone_number: '+16265550122' }] })
    expect(await run(two, { apply: true }).catch((e) => e.message)).toContain('say which with --number')
    expect((await run(two, { apply: true, number: '+16265550122' })).result.number).toBe('+16265550122')
    expect(await run(two, { apply: true, number: '+16265550199' }).catch((e) => e.message)).toContain('is not on this Telnyx account')
  })

  test('a rerun after an order that has not landed does not buy a second number, and only an explicit flag does', async () => {
    const a = fakeAccount({ forSale: ['+16265550100', '+16265550101'], slowOrders: true })
    const first = await run(a, { apply: true, buy: true })
    expect(a.st.writes.filter((w) => w === 'POST /number_orders')).toHaveLength(1)
    expect(first.result.number).toBeNull()
    expect(first.result.todo.join('\n')).toContain('The order for +16265550100')
    for (let again = 0; again < 3; again++) {
      const r = await run(a, { apply: true, buy: true })
      expect(a.st.writes.filter((w) => w === 'POST /number_orders')).toHaveLength(1)
      expect(r.lines).toContain('WAIT  an order for a 626 number is still on the account (order-')
      expect(r.result.todo.join('\n')).toContain('has not landed')
    }
    // A dry run says the same and writes nothing.
    expect((await run(a, { apply: false })).lines).toContain('WAIT  an order for a 626 number is still on the account')
    // Once the earlier order is refused for good, the explicit flag buys again.
    a.st.orders[0]!.status = 'failure'
    await run(a, { apply: true, buy: true, buyAnother: true })
    expect(a.st.writes.filter((w) => w === 'POST /number_orders')).toHaveLength(2)
    expect((a.st.orders[1]!.phone_numbers as Rec[])[0]?.phone_number).toBe('+16265550100') // the refused order's number is on offer again
  })

  test('an order that finished a moment ago for a number the account does not list yet also stops a second buy', async () => {
    const a = fakeAccount({ forSale: ['+16265550100'], orders: [{ id: 'order-x', status: 'success', created_at: new Date().toISOString(), phone_numbers: [{ phone_number: '+16265550133' }] }] })
    const r = await run(a, { apply: true, buy: true })
    expect(a.st.writes).not.toContain('POST /number_orders')
    expect(r.result.todo.join('\n')).toContain('has not landed')
    // An old finished order, or a pending one for another area code, does not.
    const old = fakeAccount({ forSale: ['+16265550100'], orders: [{ id: 'o1', status: 'success', created_at: '2026-01-01T00:00:00Z', phone_numbers: [{ phone_number: '+16265550133' }] }, { id: 'o2', status: 'pending', phone_numbers: [{ phone_number: '+12135550133' }] }] })
    await run(old, { apply: true, buy: true })
    expect(old.st.writes).toContain('POST /number_orders')
  })

  test('with no address given, 911 is left for the person to give in the app, and the script says so', async () => {
    const a = fakeAccount({ forSale: ['+16265550100'] })
    const { result, lines } = await run(a, { apply: true, buy: true })
    expect(lines).toContain('TODO  911 is off for +16265550100')
    expect(result.todo.join('\n')).toContain('tessa@northfield.example')
    expect(a.st.writes).not.toContain('POST /addresses')
  })

  test('the words that name the company are made from its name, and the caller name is cut to what a listing allows', () => {
    expect(lineWords('Brightwater Builders')).toEqual({
      callerName: 'Brightwater Bui',
      greeting: 'You have reached Brightwater Builders. Nobody can take your call right now. Please leave a message after the tone, and hang up when you are done.',
      screening: 'Call for Brightwater Builders. Press 1 to answer.',
    })
    expect(lineWords('Acme').callerName).toBe('Acme')
  })

  test('the numbers it asks for are exactly Tessa’s answers', () => {
    expect(LINE).toMatchObject({ areaCode: '626', monthlyMinutes: 1000, telnyx: { allowedCountries: ['US'], maxRatePerMinute: 0.05, dailySpendLimit: '5.00', concurrentCalls: 3 } })
  })
})
