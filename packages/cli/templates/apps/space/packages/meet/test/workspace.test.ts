// Seam 1 for the workspace: the Worker's HTTP API at both doors, with the real core over in-memory SQLite and fakes
// for the mailer and the socket adapter. The doors first (who may call what, with which credential), then what a
// person may see and do inside. Nothing here checks how the workspace stores things.
import { beforeEach, describe, expect, test } from 'bun:test'
import { ANA, type Harness, OWNER, T0, harness } from './helpers'
import { type Actors, DAY, G, HOUR, W, actors } from './workspace.helpers'

type H = Awaited<ReturnType<typeof harness>>
let h: H
let a: Actors

beforeEach(async () => {
  h = await harness({ devBypass: false })
  a = actors(h)
})

/** Tessa makes a channel; the usual start of every scene. */
async function channel(as: string, name: string, privacy: 'open' | 'private' = 'private'): Promise<number> {
  const r = await a.tm(as, 'POST', '/channels', { name, privacy })
  expect(r.status).toBe(201)
  return r.json.conversation.id
}

/** `by` invites a guest into a channel and the guest signs in: their session token and id. */
async function guest(by: string, conv: number, email: string, name: string): Promise<{ token: string; id: string }> {
  const r = await a.tm(by, 'POST', `/channels/${conv}/invite`, { email, name })
  expect(r.status).toBe(201)
  const token = await a.signIn(email)
  return { token, id: r.json.person.id }
}

const say = (as: string, conv: number, text: string) => a.tm(as, 'POST', `/conversations/${conv}/messages`, { text })

describe('the guests’ door: /w/api', () => {
  const routes: Array<[string, string, unknown?]> = [
    ['GET', '/bootstrap'],
    ['POST', '/ticket'],
    ['POST', '/channels', { name: 'x', privacy: 'open' }],
    ['POST', '/dms', { person: 'p' }],
    ['GET', '/conversations/1/messages'],
    ['POST', '/conversations/1/messages', { text: 'hi' }],
    ['POST', '/conversations/1/read', { upTo: 1 }],
    ['PATCH', '/messages/1', { text: 'x' }],
    ['DELETE', '/messages/1'],
    ['PATCH', '/me', { name: 'x' }],
    ['POST', '/privacy-ack'],
    ['GET', '/sessions'],
    ['DELETE', '/sessions/s'],
    ['POST', '/signout'],
  ]

  test('every route is refused with no cookie, and with only an assertion header', async () => {
    for (const [method, path, body] of routes) {
      const bare = await h.call(method, `${G}${path}`, body)
      expect([method, path, bare.status]).toEqual([method, path, 401])
      const asserted = await h.call(method, `${G}${path}`, body, { headers: { 'cf-access-jwt-assertion': await a.assertion(OWNER) } })
      expect([method, path, asserted.status]).toEqual([method, path, 401])
    }
  })

  test('a session that is signed out, expired or of a removed guest is refused', async () => {
    const conv = await channel(OWNER, 'Acme')
    const g1 = await guest(OWNER, conv, 'one@client.test', 'One')
    const g2 = await guest(OWNER, conv, 'two@client.test', 'Two')
    const g3 = await guest(OWNER, conv, 'three@client.test', 'Three')
    expect((await a.gu(g1.token, 'GET', '/bootstrap')).status).toBe(200)
    // Signed out.
    expect((await a.gu(g1.token, 'POST', '/signout')).status).toBe(200)
    expect((await a.gu(g1.token, 'GET', '/bootstrap')).status).toBe(401)
    // Removed.
    expect((await a.tm(OWNER, 'POST', `/people/${g2.id}/remove`)).status).toBe(200)
    expect((await a.gu(g2.token, 'GET', '/bootstrap')).status).toBe(401)
    // Expired: 30 days from its last use.
    h.clock.now += 31 * DAY
    expect((await a.gu(g3.token, 'GET', '/bootstrap')).status).toBe(401)
  })

  test('a session lasts 30 days from its last use, and the cookie is HttpOnly, Secure, SameSite=Lax and scoped to the guests’ API', async () => {
    const conv = await channel(OWNER, 'Acme')
    await a.tm(OWNER, 'POST', `/channels/${conv}/invite`, { email: 'gus@client.test', name: 'Gus' })
    await h.call('POST', 'https://meet.northfield.example/w/api/auth/request', { email: 'gus@client.test' })
    const code = /(\d{6})/.exec(h.mail.at(-1)?.subject ?? '')?.[1]
    const r = await h.call('POST', 'https://meet.northfield.example/w/api/auth/verify', { email: 'gus@client.test', code })
    const cookie = r.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/^meet_guest=/)
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/Secure/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    expect(cookie).toMatch(/Path=\/w\/api(;|$)/)
    expect(cookie).toMatch(/Max-Age=2592000/)
    const token = /meet_guest=([^;]+)/.exec(cookie)?.[1] as string
    h.clock.now += 20 * DAY
    expect((await a.gu(token, 'GET', '/bootstrap')).status).toBe(200) // used on day 20: renewed
    h.clock.now += 20 * DAY
    expect((await a.gu(token, 'GET', '/bootstrap')).status).toBe(200) // day 40 is 20 days from its last use
  })

  test('the cookie is set again as the session is used, so it lasts as long as the session does; a refusal sets none', async () => {
    const conv = await channel(OWNER, 'Acme')
    const g = await guest(OWNER, conv, 'gus@client.test', 'Gus')
    const used = await a.gu(g.token, 'GET', '/bootstrap')
    expect(used.headers.get('set-cookie')).toMatch(/^meet_guest=.*Max-Age=2592000/)
    expect(used.headers.get('set-cookie')).toMatch(/HttpOnly/i)
    const refused = await h.call('GET', `${G}/bootstrap`)
    expect(refused.headers.get('set-cookie')).toBeNull()
    const out = await a.gu(g.token, 'POST', '/signout')
    expect(out.headers.get('set-cookie') ?? '').not.toMatch(/Max-Age=2592000/)
    // A browser that is idle for the 30 days has lost the cookie, though one request a day later would have kept it.
    const idle = await guest(OWNER, conv, 'idle@client.test', 'Idle')
    const busy = await guest(OWNER, conv, 'busy@client.test', 'Busy')
    for (let day = 0; day < 40; day++) {
      h.clock.now += DAY
      expect((await a.gu(busy.token, 'GET', '/bootstrap')).status).toBe(200)
    }
    expect((await a.gu(idle.token, 'GET', '/bootstrap')).status).toBe(401)
    expect((await a.gu(busy.token, 'GET', '/bootstrap')).status).toBe(200)
  })

  test('a teammate has no guest devices to manage', async () => {
    expect((await a.tm(OWNER, 'GET', '/sessions')).status).toBe(403)
  })
})

describe('the socket', () => {
  const upgrade = { upgrade: 'websocket' }
  const open = (ticket: string, origin: string | null = 'http://localhost', headers: Record<string, string> = upgrade) =>
    h.call('GET', `/w/api/socket?ticket=${ticket}`, undefined, { headers, ...(origin ? { origin } : {}) })

  test('a ticket comes only from a valid door, works once, and says who it is for', async () => {
    expect((await h.callTeammate('POST', `${W}/ticket`)).status).toBe(401)
    expect((await h.call('POST', `${G}/ticket`)).status).toBe(401)
    const conv = await channel(OWNER, 'Acme')
    const g = await guest(OWNER, conv, 'gus@client.test', 'Gus')
    const t1 = (await a.tm(OWNER, 'POST', '/ticket')).json.ticket
    const t2 = (await a.gu(g.token, 'POST', '/ticket')).json.ticket
    expect((await open(t1)).status).toBe(200)
    expect((await open(t1)).status).toBe(401) // spent
    expect((await open(t2)).status).toBe(200)
    expect(h.sockets).toHaveLength(2)
    expect(h.sockets[0]).toMatchObject({ session: null })
    expect(h.sockets[1]?.session).toBeTruthy()
    const me = (await a.tm(OWNER, 'GET', '/bootstrap')).json.me.id
    expect(h.sockets[0]?.person).toBe(me)
    expect(h.sockets[1]?.person).toBe(g.id)
  })

  test('a ticket is dead after 60 seconds', async () => {
    const t = (await a.tm(OWNER, 'POST', '/ticket')).json.ticket
    h.clock.now += 61_000
    expect((await open(t)).status).toBe(401)
    expect(h.sockets).toHaveLength(0)
  })

  test('an upgrade with no ticket, a made-up one, a foreign Origin, no Origin or no upgrade is refused', async () => {
    const t = (await a.tm(OWNER, 'POST', '/ticket')).json.ticket
    expect((await open('')).status).toBe(401)
    expect((await open('x'.repeat(30))).status).toBe(401)
    expect((await open(t, 'https://evil.test')).status).toBe(403)
    expect((await open(t, null)).status).toBe(403)
    expect((await open(t, 'http://localhost', {})).status).toBe(426)
    expect(h.sockets).toHaveLength(0)
    // None of those spent it.
    expect((await open(t)).status).toBe(200)
  })

  test('a teammate’s socket ends with the assertion that made its ticket; a guest’s with the session', async () => {
    const exp = Math.floor((T0 + 2 * HOUR) / 1000)
    const jwt = await a.assertion(OWNER, exp)
    const t = (await h.callTeammate('POST', `${W}/ticket`, undefined, { headers: { 'cf-access-jwt-assertion': jwt } })).json
    expect(t.endsAt).toBe(exp * 1000)
    const conv = await channel(OWNER, 'Acme')
    const g = await guest(OWNER, conv, 'gus@client.test', 'Gus')
    const gt = (await a.gu(g.token, 'POST', '/ticket')).json
    expect(gt.endsAt).toBe(T0 + 30 * DAY)
  })

  test('a socket is closed on sign-out, on removal and when the person leaves the list', async () => {
    const conv = await channel(OWNER, 'Acme')
    const g = await guest(OWNER, conv, 'gus@client.test', 'Gus')
    const g2 = await guest(OWNER, conv, 'gwen@client.test', 'Gwen')
    // Sign out one device: only that session's sockets.
    const sessions = (await a.gu(g.token, 'GET', '/sessions')).json.sessions
    expect(sessions).toHaveLength(1)
    expect(sessions[0].current).toBe(true)
    await a.gu(g.token, 'POST', '/signout')
    expect(h.closed.at(-1)).toMatchObject({ person: g.id, code: 4401, session: sessions[0].id })
    // Removal.
    await a.tm(OWNER, 'POST', `/people/${g2.id}/remove`)
    expect(h.closed.at(-1)).toMatchObject({ person: g2.id, code: 4403 })
    // A teammate taken off the list: the cron closes their sockets and keeps the person.
    const open = await channel(OWNER, 'Everyone', 'open')
    await a.tm(ANA, 'POST', `/channels/${open}/join`)
    await say(ANA, open, 'before I left')
    h.teammates.splice(h.teammates.indexOf(ANA), 1)
    h.workspaceCore.maintain(h.clock.now)
    const ana = (await a.tm(OWNER, 'GET', '/bootstrap')).json.people.find((p: any) => p.email === ANA)
    expect(ana).toMatchObject({ status: 'former' })
    expect(h.closed.at(-1)).toMatchObject({ person: ana.id, code: 4403 })
    expect((await a.tm(ANA, 'GET', '/bootstrap')).status).toBe(403)
    // Their messages stay under their name.
    const history = await a.tm(OWNER, 'GET', `/conversations/${open}/messages`)
    expect(history.json.messages.map((m: any) => [m.name, m.text])).toEqual([['Ana', 'before I left']])
  })
})

describe('writes from other sites', () => {
  test('are refused at both doors, and reading is not', async () => {
    const conv = await channel(OWNER, 'Acme')
    const g = await guest(OWNER, conv, 'gus@client.test', 'Gus')
    for (const extra of [{ origin: 'https://evil.test' }, { headers: { 'sec-fetch-site': 'cross-site' } }]) {
      const t = await a.tm(OWNER, 'POST', `/conversations/${conv}/messages`, { text: 'x' }, extra)
      expect(t.status).toBe(403)
      const gu = await a.gu(g.token, 'POST', `/conversations/${conv}/messages`, { text: 'x' }, extra)
      expect(gu.status).toBe(403)
      expect((await h.call('POST', `${G}/auth/request`, { email: 'gus@client.test' }, { origin: 'https://evil.test' })).status).toBe(403)
      expect((await a.tm(OWNER, 'DELETE', '/messages/1', undefined, extra)).status).toBe(403)
    }
    expect((await a.tm(OWNER, 'GET', '/bootstrap', undefined, { origin: 'https://evil.test' })).status).toBe(200)
    expect((await a.tm(OWNER, 'POST', `/conversations/${conv}/messages`, { text: 'x' }, { origin: 'http://localhost' })).status).toBe(201)
  })
})

describe('guest codes', () => {
  test('an invitation sends one email naming who invited and the channel, and no message text', async () => {
    const conv = await channel(OWNER, 'Acme launch')
    await say(OWNER, conv, 'the secret plan')
    const before = h.mail.length
    const r = await a.tm(OWNER, 'POST', `/channels/${conv}/invite`, { email: 'Gus@Client.test ', name: 'Gus' })
    expect(r.status).toBe(201)
    expect(r.json).toMatchObject({ mailed: true, person: { name: 'Gus', kind: 'guest', invited: true } })
    expect(h.mail).toHaveLength(before + 1)
    const m = h.mail.at(-1)!
    expect(m.to).toBe('gus@client.test')
    expect(m.from.email).toBe('meet@northfield.example')
    expect(m.subject).toBe('You were added to a channel on meet')
    expect(m.text).toContain('Tessa added you to the channel "Acme launch"')
    expect(m.text).toContain('https://space.northfield.example/w/') // straight to the guests' sign-in
    expect(m.text).not.toContain('secret plan')
  })

  test('a code sent to an invited guest signs them in; the email has the code and no link that signs anyone in', async () => {
    const conv = await channel(OWNER, 'Acme')
    await a.tm(OWNER, 'POST', `/channels/${conv}/invite`, { email: 'gus@client.test', name: 'Gus' })
    const token = await a.signIn('gus@client.test')
    const mail = a.mailTo('gus@client.test')!
    expect(mail.text).not.toMatch(/https?:\/\//)
    const me = await a.gu(token, 'GET', '/bootstrap')
    expect(me.json.me).toMatchObject({ email: 'gus@client.test', name: 'Gus', kind: 'guest', privacyAcked: false })
    expect(me.json.conversations.map((c: any) => c.name)).toEqual(['Acme'])
  })

  test('an address nobody invited, a teammate’s and a removed guest’s get the same reply, and no email', async () => {
    const conv = await channel(OWNER, 'Acme')
    const g = await guest(OWNER, conv, 'gone@client.test', 'Gone')
    await a.tm(OWNER, 'POST', `/people/${g.id}/remove`)
    await a.tm(ANA, 'GET', '/bootstrap')
    const before = h.mail.length
    const replies = []
    for (const email of ['nobody@client.test', ANA, OWNER, 'gone@client.test']) {
      const r = await h.call('POST', `${G}/auth/request`, { email })
      replies.push([r.status, JSON.stringify(r.json)])
    }
    expect(new Set(replies.map((r) => r.join())).size).toBe(1)
    expect(h.mail).toHaveLength(before)
    // And entering a code for them gets the one refusal every wrong code gets.
    const v = await h.call('POST', `${G}/auth/verify`, { email: 'nobody@client.test', code: '123456' })
    expect(v.status).toBe(401)
  })

  test('a code expires after 10 minutes, works once, and dies after 5 wrong tries', async () => {
    const conv = await channel(OWNER, 'Acme')
    await a.tm(OWNER, 'POST', `/channels/${conv}/invite`, { email: 'gus@client.test', name: 'Gus' })
    const ask = async () => {
      await h.call('POST', `${G}/auth/request`, { email: 'gus@client.test' })
      return /(\d{6})/.exec(h.mail.at(-1)?.subject ?? '')?.[1] as string
    }
    const verify = (code: string) => h.call('POST', `${G}/auth/verify`, { email: 'gus@client.test', code })
    const wrong = (code: string) => (code === '000000' ? '000001' : '000000')
    // Expired.
    let code = await ask()
    h.clock.now += 10 * 60_000 + 1
    expect((await verify(code)).status).toBe(401)
    // Once.
    code = await ask()
    expect((await verify(code)).status).toBe(200)
    expect((await verify(code)).status).toBe(401)
    // Five wrong tries: the fifth kills it, and then even the right one fails.
    code = await ask()
    for (let i = 0; i < 4; i++) expect((await verify(wrong(code))).status).toBe(401)
    expect((await verify(code)).status).toBe(200) // four wrong tries leave it alive
    code = await ask()
    for (let i = 0; i < 5; i++) expect((await verify(wrong(code))).status).toBe(401)
    expect((await verify(code)).status).toBe(401)
    // A new code replaces the old one.
    const first = await ask()
    const second = await ask()
    if (first !== second) expect((await verify(first)).status).toBe(401)
    expect((await verify(second)).status).toBe(200)
  })

  /** What the object holds that a flood could grow: the rows its limits read. */
  const logRows = () => h.workspaceCore['sql'].all<{ n: number }>('SELECT COUNT(*) AS n FROM mail_log')[0]?.n
  const ask = (email: string, ip?: string) => h.call('POST', `${G}/auth/request`, { email }, ip ? { headers: { 'cf-connecting-ip': ip } } : {})

  test('a request for a code from an address nobody invited writes nothing and costs the object one read, however many arrive', async () => {
    for (let i = 0; i < 200; i++) expect((await ask(`random${i}@nowhere.test`)).status).toBe(200)
    expect(logRows()).toBe(0)
    expect(h.mail).toHaveLength(0)
    // Nor does a wrong code against no code at all.
    for (let i = 0; i < 50; i++) expect((await h.call('POST', `${G}/auth/verify`, { email: `random${i}@nowhere.test`, code: '123456' })).status).toBe(401)
    expect(logRows()).toBe(0)
  })

  test('the log the limits read is indexed by time and by address, kind and time', () => {
    const idx = h.workspaceCore['sql'].all<{ name: string; sql: string }>(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'mail_log'`)
    expect(idx.map((i) => i.sql.replace(/\s+/g, ' '))).toEqual(
      expect.arrayContaining([expect.stringContaining('(at)'), expect.stringContaining('(email, kind, at)')]),
    )
  })

  test('the guests’ sign-in is limited per caller before the workspace is asked anything', async () => {
    h.authLimit.max = 3
    const conv = await channel(OWNER, 'Acme')
    await a.tm(OWNER, 'POST', `/channels/${conv}/invite`, { email: 'gus@client.test', name: 'Gus' })
    const before = h.workspaceCalls.n
    for (let i = 0; i < 3; i++) expect((await ask('gus@client.test', '203.0.113.7')).status).toBe(200)
    const calls = h.workspaceCalls.n
    expect(calls).toBeGreaterThan(before)
    // The fourth, from the same caller, on either route, is refused at the edge of the Worker: no workspace call at all.
    expect((await ask('gus@client.test', '203.0.113.7')).status).toBe(429)
    expect((await h.call('POST', `${G}/auth/verify`, { email: 'gus@client.test', code: '123456' }, { headers: { 'cf-connecting-ip': '203.0.113.7' } })).status).toBe(429)
    expect(h.workspaceCalls.n).toBe(calls)
    expect(h.authLimit.keys.at(-1)).toBe('203.0.113.7')
    // Another caller is not held up by it.
    expect((await ask('gus@client.test', '203.0.113.8')).status).toBe(200)
  })

  test('a real guest gets at most 5 codes an address an hour and 10 a day; past that the reply is the same and nothing is sent', async () => {
    const conv = await channel(OWNER, 'Acme')
    await a.tm(OWNER, 'POST', `/channels/${conv}/invite`, { email: 'gus@client.test', name: 'Gus' })
    const codes = () => h.mail.filter((m) => m.to === 'gus@client.test' && /sign-in code/.test(m.subject)).length
    for (let i = 0; i < 5; i++) expect((await ask('gus@client.test')).status).toBe(200)
    expect(codes()).toBe(5)
    const sixth = await ask('gus@client.test')
    expect(sixth.status).toBe(200)
    expect(sixth.json).toEqual((await ask('nobody@client.test')).json) // the page cannot tell
    expect(codes()).toBe(5)
    // A code every hour and a bit: the day's tenth is the last, whatever the hour.
    for (let i = 0; i < 5; i++) {
      h.clock.now += HOUR + 60_000
      await ask('gus@client.test')
    }
    expect(codes()).toBe(10)
    h.clock.now += HOUR + 60_000
    await ask('gus@client.test')
    expect(codes()).toBe(10)
    h.clock.now += 24 * HOUR
    await ask('gus@client.test')
    expect(codes()).toBe(11)
  })

  test('50 emails an hour in all, codes and invitations together; the invitation says so out loud, the sign-in does not', async () => {
    const conv = await channel(OWNER, 'Acme')
    // 10 guests, 4 codes each, and 10 invitations: 50 emails.
    for (let i = 0; i < 10; i++) await a.tm(OWNER, 'POST', `/channels/${conv}/invite`, { email: `g${i}@client.test`, name: `G${i}` })
    for (let i = 0; i < 10; i++) for (let k = 0; k < 4; k++) expect((await ask(`g${i}@client.test`)).status).toBe(200)
    const sent = h.mail.length
    expect(sent).toBe(50)
    expect((await ask('g0@client.test')).status).toBe(200)
    expect((await a.tm(OWNER, 'POST', `/channels/${conv}/invite`, { email: 'late@client.test', name: 'Late' })).status).toBe(429)
    expect(h.mail).toHaveLength(sent)
    h.clock.now += HOUR + 1
    await ask('g0@client.test')
    expect(h.mail).toHaveLength(sent + 1)
  })

  test('wrong codes across codes lock the address for the hour: a new code does not reset them, and the right one is refused', async () => {
    const conv = await channel(OWNER, 'Acme')
    await a.tm(OWNER, 'POST', `/channels/${conv}/invite`, { email: 'gus@client.test', name: 'Gus' })
    const codeOf = () => /(\d{6})/.exec(h.mail.at(-1)?.subject ?? '')?.[1] as string
    const verify = (code: string) => h.call('POST', `${G}/auth/verify`, { email: 'gus@client.test', code })
    const other = (code: string) => (code === '000000' ? '000001' : '000000')
    await ask('gus@client.test')
    for (let i = 0; i < 5; i++) await verify(other(codeOf()))
    await ask('gus@client.test') // a fresh code, with fresh tries, as before
    for (let i = 0; i < 5; i++) await verify(other(codeOf()))
    // Ten wrong ones in the hour: no new code is sent, and the one that was sent is dead.
    const before = h.mail.length
    expect((await ask('gus@client.test')).status).toBe(200)
    expect(h.mail).toHaveLength(before)
    expect((await verify(codeOf())).status).toBe(401)
    // An hour on it is open again.
    h.clock.now += HOUR + 1
    await ask('gus@client.test')
    expect(h.mail).toHaveLength(before + 1)
    expect((await verify(codeOf())).status).toBe(200)
  })

  test('an invitation whose email could not be sent still adds the guest and says so', async () => {
    const conv = await channel(OWNER, 'Acme')
    h.mailFails.on = true
    const r = await a.tm(OWNER, 'POST', `/channels/${conv}/invite`, { email: 'gus@client.test', name: 'Gus' })
    expect(r.status).toBe(201)
    expect(r.json.mailed).toBe(false)
  })
})

describe('one address, one person', () => {
  test('inviting a teammate’s address as a guest is refused, and nothing is sent', async () => {
    const conv = await channel(OWNER, 'Acme')
    const before = h.mail.length
    const r = await a.tm(OWNER, 'POST', `/channels/${conv}/invite`, { email: ANA, name: 'Ana' })
    expect(r.status).toBe(409)
    expect(r.json.error).toContain('Add them to the channel instead')
    expect(h.mail).toHaveLength(before)
    // Even before Ana has ever signed in, and in a different case.
    expect((await a.tm(OWNER, 'POST', `/channels/${conv}/invite`, { email: 'ANA@Northfield.example', name: 'Ana' })).status).toBe(409)
  })

  test('a guest whose address joins the teammate list becomes a teammate at their first Access sign-in, with channels and history kept', async () => {
    const conv = await channel(OWNER, 'Acme')
    const sam = await guest(OWNER, conv, 'sam@later.test', 'Sam')
    await a.gu(sam.token, 'POST', `/conversations/${conv}/messages`, { text: 'from Sam the guest' })
    // The address joins the list: the guest door stops serving it at once.
    h.teammates.push('sam@later.test')
    expect((await a.gu(sam.token, 'GET', '/bootstrap')).status).toBe(401)
    const before = h.mail.length
    expect((await h.call('POST', `${G}/auth/request`, { email: 'sam@later.test' })).status).toBe(200)
    expect(h.mail).toHaveLength(before)
    // Their first Access sign-in.
    const first = await a.tm('sam@later.test', 'GET', '/bootstrap')
    expect(first.status).toBe(200)
    expect(first.json.me).toMatchObject({ id: sam.id, kind: 'teammate', name: 'Sam' })
    expect(first.json.conversations.map((c: any) => c.name)).toEqual(['Phone', 'Acme'])
    const history = await a.tm('sam@later.test', 'GET', `/conversations/${conv}/messages`)
    expect(history.json.messages.map((m: any) => [m.text, m.person])).toEqual([['from Sam the guest', sam.id]])
    // The old cookie is worth nothing, and the person is still one.
    expect((await a.gu(sam.token, 'GET', '/bootstrap')).status).toBe(401)
    expect(h.closed.some((c) => c.person === sam.id)).toBe(true)
    const people = (await a.tm(OWNER, 'GET', '/bootstrap')).json.people.filter((p: any) => p.email === 'sam@later.test')
    expect(people).toHaveLength(1)
  })

  test('a member and a guest never share an address: each door yields exactly one person, and a credential from one is worth nothing at the other', async () => {
    const conv = await channel(OWNER, 'Acme')
    const g = await guest(OWNER, conv, 'gus@client.test', 'Gus')
    const asGuest = (await a.gu(g.token, 'GET', '/bootstrap')).json.me
    const asOwner = (await a.tm(OWNER, 'GET', '/bootstrap')).json.me
    expect(asGuest.id).not.toBe(asOwner.id)
    expect(asGuest.kind).toBe('guest')
    expect(asOwner.kind).toBe('teammate')
    // A guest cookie is no key to a teammate route, and Tessa's assertion no key to a guest route.
    expect((await h.callTeammate('POST', `${W}/conversations/${conv}/messages`, { text: 'x' }, { headers: { cookie: `meet_guest=${g.token}` } })).status).toBe(401)
    expect((await h.call('POST', `${G}/conversations/${conv}/messages`, { text: 'x' }, { headers: { 'cf-access-jwt-assertion': await a.assertion(OWNER) } })).status).toBe(401)
  })
})

describe('the Owner’s and the guest’s own settings', () => {
  test('a person can set their name and turn the emails off; the privacy note is acknowledged once', async () => {
    const conv = await channel(OWNER, 'Acme')
    const g = await guest(OWNER, conv, 'gus@client.test', 'Gus')
    expect((await a.gu(g.token, 'PATCH', '/me', { name: ' Gus  Gray ', nudgesOff: true })).json.me).toMatchObject({ name: 'Gus Gray', nudgesOff: true })
    expect((await a.gu(g.token, 'PATCH', '/me', { name: '  ' })).status).toBe(400)
    await a.gu(g.token, 'POST', '/privacy-ack')
    expect((await a.gu(g.token, 'GET', '/bootstrap')).json.me.privacyAcked).toBe(true)
  })
})

export type { Harness }
