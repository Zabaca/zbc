// Connect Gmail in the space (src/gmail.ts), driven with real requests through the real router. The inbox behind the binding is
// the stand-in, and Google is a stand-in too (`google` below): it takes the address the inbox gave, as a browser would follow it, and returns a code to the return address
// named in it, once. What is asserted is what Tessa's browser is sent to and what is kept: the cookie on this host, the refusals of a forged or replayed return, that only
// Tessa can start it, and that no sign-in is refused on both paths. The inbox's half (the owner rule, the exchange with this return address) is
// packages/inbox/test/space-gmail-connect.test.ts; Google accepting the address, and a real browser's round trip, are the runbook's live check.
import { describe, expect, test } from 'bun:test'
import { GMAIL_ACCOUNT_PARAM, GMAIL_RETURN_PATH, GMAIL_START_PATH, createInstall, failed, refused } from '@space/workspace'
import { T0, NORTHFIELD_FILE, readJson, northfield } from '../../workspace/test/helpers'
import { standInInbox, standInMeet } from '../src/stand-ins'
import { fixtureViews } from '../src/fixture-views'
import { NORTHFIELD_TEAM, world } from './world'

const COOKIE = 'space_gmail_state'

async function setup(install = northfield()) {
  const inbox = standInInbox([], [], { views: fixtureViews(T0), now: () => T0 })
  inbox.views.state.gmailAccounts = []
  const w = await world(install, NORTHFIELD_TEAM, { inbox: inbox, meet: standInMeet({ direct: [], channels: [] }) }, undefined, { answerWithinMs: 100, writeWithinMs: 300, now: () => T0 })
  const jwt = await w.signIn('tessa@northfield.example')
  const connectCalls = () => inbox.views.calls.filter((c) => c.method === 'gmailConnect')
  return { w, inbox, jwt, connectCalls }
}

/** What a browser does with a Set-Cookie: the name=value pair, and whether it was an instruction to delete. */
const jar = (res: Response) => {
  const raw = res.headers.get('set-cookie') ?? ''
  return { raw, pair: raw.split(';')[0] ?? '', spent: /Max-Age=0/i.test(raw) }
}

/** Google, as a browser follows the address it was sent to: the code goes to the return address in it, with the check it was given. */
const google = {
  returnFor(location: string, code: string, extra: Record<string, string> = {}) {
    const at = new URL(location)
    expect(at.origin + at.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    const back = new URL(at.searchParams.get('redirect_uri') ?? '')
    back.searchParams.set('code', code)
    back.searchParams.set('state', at.searchParams.get('state') ?? '')
    for (const [k, v] of Object.entries(extra)) back.searchParams.set(k, v)
    return back
  },
}

type S = Awaited<ReturnType<typeof setup>>
const start = (s: S) => s.w.call(GMAIL_START_PATH, { jwt: s.jwt })
const finish = (s: S, url: URL, cookie: string | null, jwt = s.jwt) => s.w.call(url.pathname + url.search, { jwt, headers: cookie ? { cookie } : {} })

describe('connecting Gmail through the space', () => {
  test('the round trip: start sends Tessa to Google with a check, Google returns to the space’s own address, the code goes to the inbox, and he lands on Settings, Mailboxes', async () => {
    const s = await setup()
    const first = await start(s)
    expect(first.status).toBe(302)
    const location = first.headers.get('location') ?? ''
    const sent = new URL(location)
    expect(sent.searchParams.get('redirect_uri')).toBe('https://space.northfield.example/api/inbox/gmail/callback')
    const state = sent.searchParams.get('state') ?? ''
    expect(state).toMatch(/^[0-9a-f]{48}$/)
    const cookie = jar(first)
    expect(cookie.pair).toBe(`${COOKIE}=${state}`)
    expect(first.headers.get('cache-control')).toBe('private, no-store')

    const back = google.returnFor(location, 'good-code-1')
    expect(back.origin).toBe('https://space.northfield.example')
    expect(back.pathname).toBe(GMAIL_RETURN_PATH)
    const done = await finish(s, back, cookie.pair)
    expect(done.status).toBe(302)
    expect(done.headers.get('location')).toBe('/settings/mailboxes')
    expect(done.headers.get('referrer-policy')).toBe('no-referrer')
    expect(jar(done).spent).toBe(true)
    expect(s.connectCalls().map((c) => c.args)).toEqual([['good-code-1']])
    expect(s.inbox.views.state.gmailAccounts).toMatchObject([{ address: 'tessa@northfield.example', connected: true }])
    const shown = await (await s.w.call('/api/inbox/mailboxes', { jwt: s.jwt })).json()
    expect(shown).toMatchObject({ result: 'ok', value: { gmailAccounts: [{ connected: true }] } })
  })

  test('the check travels in a cookie that only this path carries: HttpOnly, Secure, SameSite=Lax, ten minutes', async () => {
    const s = await setup()
    const raw = jar(await start(s)).raw
    expect(raw).toContain('Path=/api/inbox/gmail')
    expect(raw).toMatch(/HttpOnly/i)
    expect(raw).toMatch(/Secure/i)
    expect(raw).toMatch(/SameSite=Lax/i)
    expect(raw).toContain('Max-Age=600')
    expect(raw).not.toMatch(/Domain=/i)
  })

  test('two sign-ins get two different checks', async () => {
    const s = await setup()
    const state = async () => new URL((await start(s)).headers.get('location') ?? '').searchParams.get('state')
    expect(await state()).not.toBe(await state())
  })

  test('the inbox is asked with the person this request named, and the check it will put in Google’s address', async () => {
    const s = await setup()
    const res = await start(s)
    const call = s.inbox.views.calls.find((c) => c.method === 'gmailSignIn')
    expect(call?.asker?.person.address).toBe('tessa@northfield.example')
    expect(call?.args).toEqual([new URL(res.headers.get('location') ?? '').searchParams.get('state'), undefined])
  })
})

describe('several accounts', () => {
  let n = 0
  const connectAs = async (s: S, address: string, query = '') => {
    const first = await s.w.call(`${GMAIL_START_PATH}${query}`, { jwt: s.jwt })
    expect(first.status).toBe(302)
    const back = google.returnFor(first.headers.get('location') ?? '', `good-code-${++n}:${address}`)
    const done = await finish(s, back, jar(first).pair)
    expect(done.status, await done.clone().text()).toBe(302)
    return first
  }

  test('any address is connected, one after another, each its own account listed in Settings; a second sign-in to one already held replaces it, it does not add one', async () => {
    const s = await setup()
    await connectAs(s, 'tessa@northfield.example')
    await connectAs(s, 'tessa@ashgrove.example')
    await connectAs(s, 'tessa_marlow@gmail.com')
    expect(s.inbox.views.state.gmailAccounts.map((g) => [g.address, g.name, g.connected])).toEqual([
      ['tessa@northfield.example', 'northfield', true],
      ['tessa@ashgrove.example', 'ashgrove', true],
      ['tessa_marlow@gmail.com', 'tessa_marlow', true],
    ])
    await connectAs(s, 'tessa@ashgrove.example')
    expect(s.inbox.views.state.gmailAccounts).toHaveLength(3)
    const shown = (await (await s.w.call('/api/inbox/mailboxes', { jwt: s.jwt })).json()) as { value: { gmailAccounts: { address: string }[] } }
    expect(shown.value.gmailAccounts.map((g) => g.address)).toEqual(['tessa@northfield.example', 'tessa@ashgrove.example', 'tessa_marlow@gmail.com'])
  })

  test('connecting an account again names it: the inbox is asked with its id (it becomes Google’s hint), and a lapsed account is connected again on the same row', async () => {
    const s = await setup()
    await connectAs(s, 'tessa@ashgrove.example')
    const account = s.inbox.views.state.gmailAccounts[0]
    expect(account).toBeDefined()
    const id = (account as { id: string }).id
    s.inbox.views.state.gmailAccounts = s.inbox.views.state.gmailAccounts.map((g) => ({ ...g, state: 'lapsed', lapsedAt: T0, reasons: ['Google no longer accepts the saved sign-in for tessa@ashgrove.example. Connect it again.'] }))
    const again = await connectAs(s, 'tessa@ashgrove.example', `?${GMAIL_ACCOUNT_PARAM}=${encodeURIComponent(id)}`)
    expect(new URL(again.headers.get('location') ?? '').searchParams.get('login_hint')).toBe('tessa@ashgrove.example')
    const calls = s.inbox.views.calls.filter((c) => c.method === 'gmailSignIn')
    expect(calls.at(-1)?.args[1]).toBe(id)
    expect(s.inbox.views.state.gmailAccounts).toMatchObject([{ id, state: 'filling', lapsedAt: null, reasons: [] }])
  })

  test('an account the inbox does not hold, or a name that is not an id, sends the browser nowhere and sets no cookie', async () => {
    const s = await setup()
    const unknown = await s.w.call(`${GMAIL_START_PATH}?${GMAIL_ACCOUNT_PARAM}=no-such-account`, { jwt: s.jwt })
    expect(unknown.status).toBe(400)
    expect(unknown.headers.get('location')).toBeNull()
    expect(unknown.headers.get('set-cookie')).toBeNull()
    for (const bad of ['a/b', 'x'.repeat(300)]) {
      const res = await s.w.call(`${GMAIL_START_PATH}?${GMAIL_ACCOUNT_PARAM}=${encodeURIComponent(bad)}`, { jwt: s.jwt })
      expect([bad, res.status, res.headers.get('set-cookie')]).toEqual([bad, 400, null])
    }
    expect(s.inbox.views.calls.filter((c) => c.method === 'gmailSignIn').every((c) => c.args[1] === 'no-such-account')).toBe(true)
  })
})

describe('a forged or replayed return is refused', () => {
  const sample = async () => {
    const s = await setup()
    const first = await start(s)
    const location = first.headers.get('location') ?? ''
    return { s, location, state: new URL(location).searchParams.get('state') ?? '', cookie: jar(first).pair }
  }

  test('no cookie, another check in the cookie, no check at all, a cancelled sign-in and no code each connect nothing and ask the inbox nothing; each spends the cookie', async () => {
    const { s, location, cookie } = await sample()
    const good = google.returnFor(location, 'good-code-1')
    const noState = new URL(good)
    noState.searchParams.delete('state')
    const noCode = new URL(good)
    noCode.searchParams.delete('code')
    const tries: [string, Response | Promise<Response>][] = [
      ['no cookie', finish(s, good, null)],
      ['another check in the cookie', finish(s, good, `${COOKIE}=${'0'.repeat(48)}`)],
      ['a prefix of the check', finish(s, good, `${COOKIE}=${cookie.split('=')[1]?.slice(0, 47)}`)],
      ['no check in the address', finish(s, noState, cookie)],
      ['the cookie of another name', finish(s, good, `other_state=${cookie.split('=')[1]}`)],
      ['cancelled at Google', finish(s, google.returnFor(location, 'x', { error: 'access_denied' }), cookie)],
      ['no code', finish(s, noCode, cookie)],
    ]
    for (const [why, pending] of tries) {
      const res = await pending
      expect([why, res.status]).toEqual([why, 400])
      expect([why, jar(res).spent]).toEqual([why, true])
      expect(res.headers.get('content-type')).toContain('text/html')
    }
    expect(s.connectCalls()).toEqual([])
    expect(s.inbox.views.state.gmailAccounts).toEqual([])
  })

  test('a return that is replayed finds the cookie gone (the first spent it) and is refused; if the cookie were kept, Google has spent the code and the inbox refuses, and nothing is connected twice', async () => {
    const { s, location, cookie } = await sample()
    const back = google.returnFor(location, 'good-code-1')
    expect((await finish(s, back, cookie)).status).toBe(302)
    expect(s.connectCalls()).toHaveLength(1)

    const replay = await finish(s, back, null)
    expect(replay.status).toBe(400)
    expect(s.connectCalls()).toHaveLength(1)

    const kept = await finish(s, back, cookie)
    expect(kept.status).toBe(502)
    expect(await kept.text()).toContain('invalid_grant')
    expect(jar(kept).spent).toBe(true)
  })

  test('a return that belongs to a sign-in somebody else started (their check, not the one in Tessa’s cookie) is refused', async () => {
    const mine = await sample()
    const theirs = await start(mine.s)
    const theirBack = google.returnFor(theirs.headers.get('location') ?? '', 'good-code-2')
    const res = await finish(mine.s, theirBack, mine.cookie)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('was not started here')
    expect(mine.s.connectCalls()).toEqual([])
  })

  test('what the inbox says in refusing (a grant without the permission) is shown in its words, as text and never as markup, with the way back', async () => {
    const { s, location, cookie } = await sample()
    s.inbox.gmailConnect = async () => refused('not-admitted', 'The sign-in did not grant permission to read and organize Gmail, so nothing was connected.')
    const res = await finish(s, google.returnFor(location, 'good-code-1'), cookie)
    expect(res.status).toBe(403)
    const page = await res.text()
    expect(page).toContain('did not grant permission')
    expect(page).toContain('href="/settings/mailboxes"')
    expect(s.inbox.views.state.gmailAccounts).toEqual([])

    const again = await sample()
    again.s.inbox.gmailConnect = async () => failed('<script>alert(1)</script>')
    const hostile = await (await finish(again.s, google.returnFor(again.location, 'good-code-9'), again.cookie)).text()
    expect(hostile).not.toContain('<script>')
    expect(hostile).toContain('&lt;script&gt;')
  })

  test('the inbox lost, or answering something that is not its contract, connects nothing and says so', async () => {
    const { s, location, cookie } = await sample()
    s.inbox.views.script.push('throw')
    const down = await finish(s, google.returnFor(location, 'good-code-1'), cookie)
    expect(down.status).toBe(502)
    expect(await down.text()).toContain('did not say whether')
    expect(s.inbox.views.state.gmailAccounts).toEqual([])
  })
})

describe('starting it', () => {
  test('a person who is not Tessa (a teammate) is refused by the inbox: no cookie is set and the browser is sent nowhere', async () => {
    const raw = readJson(NORTHFIELD_FILE) as { people: unknown[] }
    raw.people.push({ address: 'eve@northfield.example', name: 'Eve', role: 'member' })
    const s = await setup(createInstall(raw))
    const eve = await s.w.signIn('eve@northfield.example')
    const res = await s.w.call(GMAIL_START_PATH, { jwt: eve })
    expect(res.status).toBe(403)
    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(s.inbox.views.calls.filter((c) => c.method === 'gmailSignIn')).toHaveLength(1)

    // A return with a perfectly good cookie and code is refused the same way, and the inbox is the one that says it.
    const tessa = await start(s)
    const back = google.returnFor(tessa.headers.get('location') ?? '', 'good-code-1')
    const stolen = await finish(s, back, jar(tessa).pair, eve)
    expect(stolen.status).toBe(403)
    expect(s.inbox.views.state.gmailAccounts).toEqual([])
  })

  test('another company’s person is refused before the inbox is asked anything', async () => {
    const s = await setup()
    const stranger = await s.w.signIn('lane@pinecrest.test')
    for (const path of [GMAIL_START_PATH, `${GMAIL_RETURN_PATH}?code=good-code-1&state=${'a'.repeat(48)}`]) {
      const res = await s.w.call(path, { jwt: stranger, headers: { cookie: `${COOKIE}=${'a'.repeat(48)}` } })
      expect([path, res.status]).toEqual([path, 403])
    }
    expect(s.inbox.views.calls).toEqual([])
  })

  test('an address that is not Google’s, from an inbox that has gone wrong, is never gone to and sets no cookie', async () => {
    const s = await setup()
    for (const url of ['https://evil.example/o/oauth2/v2/auth', 'http://accounts.google.com/o', 'not a url', 'https://accounts.google.com.evil.example/']) {
      s.inbox.gmailSignIn = async () => ({ ok: true, value: { url } }) as never
      const res = await start(s)
      expect([url, res.status]).toEqual([url, 502])
      expect(res.headers.get('location')).toBeNull()
      expect(res.headers.get('set-cookie')).toBeNull()
    }
  })

  test('an inbox that does not answer in time, or at all, is said to be unreachable, with no cookie', async () => {
    const s = await setup()
    s.inbox.views.script.push('hang')
    const hung = await start(s)
    expect(hung.status).toBe(503)
    expect(hung.headers.get('set-cookie')).toBeNull()
    s.inbox.views.script.push('throw')
    expect((await start(s)).status).toBe(503)
    const none = await world(northfield(), NORTHFIELD_TEAM, {}, undefined, { now: () => T0 })
    const res = await none.call(GMAIL_START_PATH, { jwt: await none.signIn('tessa@northfield.example') })
    expect(res.status).toBe(503)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  test('only a GET starts or finishes it: any other method is refused, and a HEAD never runs a sign-in', async () => {
    const s = await setup()
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      for (const path of [GMAIL_START_PATH, GMAIL_RETURN_PATH]) {
        const res = await s.w.call(path, { method, jwt: s.jwt, headers: { origin: 'https://space.northfield.example', 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}' })
        expect([method, path, res.status]).toEqual([method, path, 405])
      }
    }
    for (const path of [GMAIL_START_PATH, `${GMAIL_RETURN_PATH}?code=good-code-1&state=${'a'.repeat(48)}`]) {
      const res = await s.w.call(path, { method: 'HEAD', jwt: s.jwt, headers: { cookie: `${COOKIE}=${'a'.repeat(48)}` } })
      expect([path, res.status]).toEqual([path, 405])
    }
    expect(s.inbox.views.calls).toEqual([])
  })
})

describe('no sign-in is refused on every new path', () => {
  const PATHS = [GMAIL_START_PATH, GMAIL_RETURN_PATH, `${GMAIL_RETURN_PATH}?code=good-code-1&state=${'a'.repeat(48)}`, '/settings/mailboxes']

  test('with none, a forged one, the cookie alone, Forms’ or the agent’s assertion, whatever the method: 401, and nothing is asked of the inbox', async () => {
    const s = await setup()
    const cookieOnly = await s.w.signIn('tessa@northfield.example')
    const forms = await s.w.signInForms('tessa@northfield.example')
    const agent = await s.w.signInAgent()
    const checked = { cookie: `${COOKIE}=${'a'.repeat(48)}` }
    for (const path of PATHS) {
      for (const method of ['GET', 'HEAD', 'POST']) {
        for (const [why, init] of [
          ['none', {}],
          ['forged', { jwt: 'not-a-jwt' }],
          ['cookie only', { cookieJwt: cookieOnly }],
          ['forms', { jwt: forms }],
          ['agent', { jwt: agent }],
        ] as const) {
          const res = await s.w.call(path, { method, ...init, headers: { ...checked, origin: 'https://space.northfield.example', 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined })
          expect([path, method, why, res.status, res.headers.get('location'), res.headers.get('set-cookie')]).toEqual([path, method, why, 401, null, null])
        }
      }
    }
    expect(s.inbox.views.calls).toEqual([])
    expect(s.inbox.asked.askers).toEqual([])
  })

  test('Claude’s token, signed for the space’s own audience, is a service token and is refused on both (403): no service token comes through the space but on its one path', async () => {
    const s = await setup()
    const token = await s.w.access.sign({ common_name: 'abc123.access' })
    for (const path of [GMAIL_START_PATH, GMAIL_RETURN_PATH]) expect([path, (await s.w.call(path, { jwt: token })).status]).toEqual([path, 403])
    expect(s.inbox.views.calls).toEqual([])
  })
})

describe('the calendar’s own Connect (Settings, Calendars) is a second sign-in: mail is never held behind a calendar consent', () => {
  const FOR = 'space_gmail_for'
  const cookies = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0] as string)
  const startFor = (s: S, query: string) => s.w.call(`${GMAIL_START_PATH}${query}`, { jwt: s.jwt })

  test('the mailboxes’ start asks the inbox for mail and sets one cookie; the calendar’s start asks for the calendar and sets a second, saying so', async () => {
    const s = await setup()
    const mail = await startFor(s, '')
    expect(cookies(mail)).toHaveLength(1)
    expect(new URL(mail.headers.get('location') ?? '').searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.modify openid email')
    const calendar = await startFor(s, '?for=calendar')
    expect(calendar.status).toBe(302)
    expect(cookies(calendar)).toHaveLength(2)
    // Its value is the check of the sign-in it belongs to, so it can speak for no other.
    const calendarCheck = new URL(calendar.headers.get('location') ?? '').searchParams.get('state')
    expect(cookies(calendar)[0]).toBe(`${COOKIE}=${calendarCheck}`)
    expect(cookies(calendar)[1]).toBe(`${FOR}=${calendarCheck}.calendar`)
    expect(calendar.headers.getSetCookie()[1]).toMatch(/Path=\/api\/inbox\/gmail; HttpOnly; Secure; SameSite=Lax/)
    expect(new URL(calendar.headers.get('location') ?? '').searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events')
    const asked = s.inbox.views.calls.filter((c) => c.method === 'gmailSignIn')
    expect(asked.map((c) => c.args[2])).toEqual([undefined, 'calendar'])
  })

  test('the return of a calendar sign-in hands the code to the inbox as one, lands on Settings, Calendars and spends both cookies; the mailboxes’ return lands where it did', async () => {
    const s = await setup()
    const first = await startFor(s, '?for=calendar')
    const back = google.returnFor(first.headers.get('location') ?? '', 'good-code-1')
    const done = await finish(s, back, cookies(first).join('; '))
    expect(done.status).toBe(302)
    expect(done.headers.get('location')).toBe('/settings/calendars')
    expect(done.headers.getSetCookie().filter((c) => /Max-Age=0/i.test(c))).toHaveLength(2)
    expect(s.connectCalls().map((c) => c.args)).toEqual([['good-code-1', 'calendar']])
    const mail = await start(s)
    const backMail = google.returnFor(mail.headers.get('location') ?? '', 'good-code-2')
    const doneMail = await finish(s, backMail, cookies(mail).join('; '))
    expect(doneMail.headers.get('location')).toBe('/settings/mailboxes')
    expect(s.connectCalls().at(-1)?.args[1]).toBeUndefined()
  })

  test('a calendar sign-in left unfinished does not turn the next mailboxes’ Connect into a calendar one: the cookie speaks for its own check only, the mailboxes’ start clears it, and the return reaches mail’s path', async () => {
    const s = await setup()
    // The calendar's Connect is started and abandoned (Google's "access blocked" page, a closed tab): its two cookies stay in the browser.
    const abandoned = await startFor(s, '?for=calendar')
    const stale = cookies(abandoned)
    expect(stale[1]).toMatch(/^space_gmail_for=[0-9a-f]{48}\.calendar$/)
    // A mailboxes' Connect is started with the stale cookies still in the jar.
    const mail = await s.w.call(GMAIL_START_PATH, { jwt: s.jwt, headers: { cookie: stale.join('; ') } })
    expect(mail.status).toBe(302)
    expect(new URL(mail.headers.get('location') ?? '').searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.modify openid email')
    const set = mail.headers.getSetCookie()
    expect(set[0]).toMatch(/^space_gmail_state=[0-9a-f]{48};/)
    expect(set.some((c) => c.startsWith(`${FOR}=;`) && /Max-Age=0/i.test(c))).toBe(true)
    // Even if a browser kept the stale cookie (one that ignored the instruction), the return does not take it for this sign-in.
    const jar2 = [cookies(mail)[0] as string, stale[1] as string].join('; ')
    const back = google.returnFor(mail.headers.get('location') ?? '', 'good-code-1')
    const done = await finish(s, back, jar2)
    expect(done.status).toBe(302)
    expect(done.headers.get('location')).toBe('/settings/mailboxes')
    expect(s.connectCalls().map((c) => c.args)).toEqual([['good-code-1']])
    expect(s.connectCalls()[0]?.args[1]).toBeUndefined()
    // Both cookies are spent, the stale one with them.
    expect(done.headers.getSetCookie().filter((c) => /Max-Age=0/i.test(c))).toHaveLength(2)
    // And the account is connected for mail: nothing was refused.
    expect(s.inbox.views.state.gmailAccounts).toMatchObject([{ address: 'tessa@northfield.example', connected: true }])
  })

  test('a mailboxes’ start with no stale cookie sets just its one cookie, as it always did', async () => {
    const s = await setup()
    expect(cookies(await startFor(s, ''))).toHaveLength(1)
  })

  test('a purpose that is none sends the browser nowhere and sets no cookie; a calendar cookie without the check is not a sign-in', async () => {
    const s = await setup()
    const odd = await startFor(s, '?for=everything')
    expect(odd.status).toBe(400)
    expect(odd.headers.getSetCookie()).toEqual([])
    expect(s.inbox.views.calls.filter((c) => c.method === 'gmailSignIn')).toEqual([])
    const first = await startFor(s, '?for=calendar')
    const back = google.returnFor(first.headers.get('location') ?? '', 'good-code-1')
    const bare = await finish(s, back, `${FOR}=calendar`)
    expect(bare.status).toBe(400)
    expect(s.connectCalls()).toEqual([])
  })

  test('what the inbox says in refusing a calendar grant is shown in its words, with the way back to Settings, Calendars', async () => {
    const s = await setup()
    const first = await startFor(s, '?for=calendar')
    s.inbox.gmailConnect = async () => refused('conflict', 'Google did not keep this account’s mail permission with the calendar’s, so nothing was changed.')
    const res = await finish(s, google.returnFor(first.headers.get('location') ?? '', 'good-code-1'), cookies(first).join('; '))
    expect(res.status).toBe(400)
    const page = await res.text()
    expect(page).toContain('nothing was changed')
    expect(page).toContain('href="/settings/calendars"')
  })
})
