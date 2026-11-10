import { describe, expect, test } from 'bun:test'
import { SignJWT } from 'jose'
import { GMAIL_SCOPE, GmailError } from '../src/gmail/google'
import { backoffMs, FETCH_BUDGET } from '../src/gmail/mailroom'
import {
  AGENT,
  asHttp,
  count,
  firstGmail,
  forger,
  GMAIL_RETURN,
  harness,
  mintPush,
  PUSH_ACCOUNT,
  PUSH_ENDPOINT,
  pushBody,
  T0,
} from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'

/**
 * The inbox's Worker driven as a function, with a Google that can fail and a fake
 * clock: the highest seam these tests have, for everything step 2
 * builds. Connecting (the Mailroom's own connection, which the space calls as Tessa with its
 * return address: the sign-in and the return are test/space-gmail-connect.test.ts in the
 * space's R2, and Claude's door has neither), the first fill, push authentication, a push
 * becoming stored mail, a stale cursor, the daily pass and what the header says.
 *
 * What this cannot show is Google. The fake behaves as the documented API says
 * and was written by the same hand as the code under test, so a green here is
 * "the inbox does the right thing given that Gmail behaves as documented".
 * Whether Gmail does (label events arriving through the watch, `after:` taking
 * epoch seconds, push latency) is the hand test.
 */

const DAY = 24 * 60 * 60 * 1000
type H = ReturnType<typeof harness>

const status = async (h: H) => (await h.request(AGENT, 'GET', '/api/mailbox')).json.accounts[0]
/** Tessa disconnects Gmail, as the space does for him: the Mailroom called with his address. */
const disconnect = async (h: H) =>
  asHttp(await h.store.call('disconnectMailbox', firstGmail(h.inbox)?.id as string, OWNER_EMAIL))
const stored = (h: H) =>
  h.db.query(`SELECT gmail_id, labels FROM message ORDER BY rowid`).all() as { gmail_id: string; labels: string }[]

/** Connect, let the first fill and the first sync finish, and answer. Anything in the mailbox first is what gets filled. */
async function live(h: H, setup?: () => void) {
  setup?.()
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
  expect((await status(h)).state).toBe('live')
}

describe('connecting Gmail', () => {
  test('Claude’s door has no way to start, finish or undo a connection, and Google is not asked', async () => {
    const h = harness()
    expect((await h.request(AGENT, 'GET', '/api/gmail/connect')).status).toBe(404)
    expect((await h.request(AGENT, 'GET', '/api/gmail/callback?code=x&state=y')).status).toBe(404)
    expect((await h.request(AGENT, 'POST', '/api/gmail/disconnect', {})).status).toBe(404)
    expect(h.google.calls).toEqual([])
    expect(firstGmail(h.inbox)).toBeNull()
  })

  test('finishing it stores the mailbox, starts the watch on the topic, asks for the fill, and exchanges the code with the return address it was started with', async () => {
    const h = harness()
    const res = await h.connect()
    expect(res.ok).toBe(true)
    expect(h.google.exchanged).toEqual([{ code: 'good-code', redirectUri: GMAIL_RETURN }])
    expect(h.google.calls).toContain(`watch:${h.env.GMAIL_TOPIC_NAME}`)
    expect(h.alarms.at(-1)?.getTime()).toBe(T0)
    const s = await status(h)
    expect(s).toMatchObject({
      connected: true,
      state: 'filling',
      address: 'tessa@northfield.example',
      watchExpiry: '2026-10-27T12:00:00.000Z',
    })
    expect(firstGmail(h.inbox)).toMatchObject({ connectedAt: '2026-10-20T12:00:00.000Z' })
  })

  test('any address is connected, and labelled for its pill; nothing is revoked', async () => {
    const h = harness()
    h.google.mailbox.address = 'tessa.marlow@fernway.example'
    const res = asHttp(await h.connect())
    expect(res.status).toBe(200)
    expect(h.google.revoked).toEqual([])
    expect(firstGmail(h.inbox)).toMatchObject({ address: 'tessa.marlow@fernway.example', name: 'fernway' })
  })

  test('only the owner connects: another actor is refused before the code is spent, and nothing is kept', async () => {
    const h = harness()
    const res = asHttp(await h.mailroom.connectMailbox('good-code', 'claude@northfield.example', GMAIL_RETURN))
    expect(res.status).toBe(403)
    expect(h.google.exchanged).toEqual([])
    expect(firstGmail(h.inbox)).toBeNull()
    expect(count(h, 'audit')).toBe(0)
  })

  test('a grant without gmail.modify is refused and revoked', async () => {
    const h = harness()
    h.google.grant = { refreshToken: 'refresh-token-1', scopes: ['openid', 'email'] }
    expect(asHttp(await h.connect()).status).toBe(403)
    expect(h.google.revoked).toHaveLength(1)
    expect(firstGmail(h.inbox)).toBeNull()
    expect(h.google.calls).not.toContain('getProfile')
  })

  test('a grant that is gmail.modify plus other scopes is accepted', async () => {
    const h = harness()
    h.google.grant = {
      refreshToken: 'refresh-token-1',
      scopes: [GMAIL_SCOPE, 'openid', 'https://www.googleapis.com/auth/userinfo.email'],
    }
    expect((await h.connect()).ok).toBe(true)
  })

  test('a grant with no refresh token is refused', async () => {
    const h = harness()
    h.google.grant = { refreshToken: null, scopes: [GMAIL_SCOPE] }
    expect(asHttp(await h.connect()).status).toBe(422)
    expect(firstGmail(h.inbox)).toBeNull()
  })

  test('a code Google will not accept is a 502 with Google’s reason, and nothing is kept', async () => {
    const h = harness()
    const res = asHttp(await h.connect('used-code'))
    expect(res.status).toBe(502)
    expect(res.json.error).toContain('invalid_grant')
    expect(firstGmail(h.inbox)).toBeNull()
  })

  test('Gmail failing right after sign-in revokes the grant instead of keeping it half-checked', async () => {
    const h = harness()
    h.google.failNext('getProfile', new GmailError('Backend Error', 500))
    expect(asHttp(await h.connect()).status).toBe(502)
    expect(h.google.revoked).toHaveLength(1)
    expect(firstGmail(h.inbox)).toBeNull()
  })

  test('without the Google client configured, finishing says so and does nothing', async () => {
    const h = harness({}, { googleConfigured: false })
    const res = asHttp(await h.connect())
    expect(res.status).toBe(503)
    expect(firstGmail(h.inbox)).toBeNull()
  })

  test('a watch that fails at connect does not undo the connection: it is amber until it works', async () => {
    const h = harness()
    h.google.failNext('watch', new GmailError('Cloud Pub/Sub topic not found', 400))
    expect((await h.connect()).ok).toBe(true)
    const s = await status(h)
    expect(s.connected).toBe(true)
    expect(s.watchExpiry).toBeNull()
    expect(s.health.amber).toBe(true)
    expect(s.lastError).toContain('Cloud Pub/Sub topic not found')
  })

  test('a mailbox with no topic configured connects, says why it is not live, and still fills', async () => {
    const h = harness({}, { topic: '' })
    h.google.mailbox.add({ id: 'x' })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    const s = await status(h)
    expect(s.state).toBe('live')
    expect(s.watchExpiry).toBeNull()
    expect(s.health.amber).toBe(true)
    expect(s.lastError).toBeNull()
    expect(h.google.count('watch')).toBe(0)
    expect(stored(h)).toHaveLength(1)
  })
})

describe('the status', () => {
  test('is null before anything is connected, and readable by the agent', async () => {
    const h = harness()
    expect((await h.request(AGENT, 'GET', '/api/mailbox')).json).toEqual({ accounts: [] })
  })

  test('nothing the inbox returns, to the agent or as the owner’s status, ever contains the refresh token', async () => {
    const h = harness()
    await live(h, () => {
      h.google.mailbox.add()
    })
    const secret = h.google.grant.refreshToken ?? ''
    expect(secret).not.toBe('')
    for (const path of ['/api/mailbox', '/api/queue', '/api/contacts', '/api/drafts', '/api/audit']) {
      expect((await h.request(AGENT, 'GET', path)).text).not.toContain(secret)
    }
    // What the space is given (the owner’s side) holds no token either.
    expect(JSON.stringify(asHttp(await h.store.call('mailboxStatuses')))).not.toContain(secret)
    expect(JSON.stringify(h.inbox.listAudit(1000))).not.toContain(secret)
  })

  test('counts what is stored, to be compared with Gmail’s own', async () => {
    const h = harness()
    await live(h, () => {
      h.google.mailbox.add({ threadId: 'a' })
      h.google.mailbox.add({ threadId: 'a' })
      h.google.mailbox.add({ threadId: 'b' })
    })
    expect(await status(h)).toMatchObject({ messages: 3, conversations: 2 })
  })
})

describe('the first fill', () => {
  test('reads thirty days of Inbox and Sent, with each message’s labels as Gmail has them', async () => {
    const h = harness()
    const m = h.google.mailbox
    await live(h, () => {
      m.add({ id: 'unread', labels: ['INBOX', 'UNREAD'] })
      m.add({ id: 'read', labels: ['INBOX'] })
      m.add({
        id: 'sent',
        labels: ['SENT'],
        from: 'Tessa Marlow <tessa@northfield.example>',
        to: 'Dana <dana@example.com>',
      })
      m.add({ id: 'archived', labels: ['CATEGORY_PERSONAL'] })
      m.add({ id: 'old', labels: ['INBOX'], at: T0 - 40 * DAY })
      m.add({ id: 'spam', labels: ['SPAM'] })
      m.add({ id: 'trash', labels: ['TRASH', 'INBOX'] })
      m.add({ id: 'draft', labels: ['DRAFT', 'INBOX'] })
    })
    const rows = stored(h)
    expect(rows.map((r) => r.gmail_id).sort()).toEqual(['read', 'sent', 'unread'])
    for (const r of rows) {
      expect(JSON.parse(r.labels)).toEqual([...(m.messages.get(r.gmail_id)?.labelIds ?? [])].sort())
    }
    // The comparison the hand test makes: unread and in the Inbox, in the store and in Gmail.
    const unreadHere = rows.filter((r) => JSON.parse(r.labels).includes('UNREAD')).length
    const unreadThere = [...m.messages.values()].filter((x) => {
      const labels = x.labelIds ?? []
      const excluded = ['SPAM', 'TRASH', 'DRAFT'].some((l) => labels.includes(l))
      return labels.includes('UNREAD') && labels.includes('INBOX') && !excluded
    }).length
    expect(unreadHere).toBe(unreadThere)
  })

  test('the cursor is the history id read BEFORE listing, and a message arriving during the fill is stored once', async () => {
    const h = harness()
    const m = h.google.mailbox
    m.add({ id: 'before' })
    const cursorAtConnect = String(m.historyId)
    await h.connect()
    m.add({ id: 'during' })
    expect(firstGmail(h.inbox)?.job?.cursorAfter).toBe(cursorAtConnect)
    await h.drain()
    expect(firstGmail(h.inbox)?.historyId).toBe(String(m.historyId))
    expect(
      stored(h)
        .map((r) => r.gmail_id)
        .sort(),
    ).toEqual(['before', 'during'])
    expect(h.google.count('getMessage:during')).toBe(1)
    expect(h.google.count('getMessage:before')).toBe(1)
  })

  test('a long fill is many short runs, each message fetched once, and nothing syncs until it is done', async () => {
    const h = harness()
    const m = h.google.mailbox
    for (let i = 0; i < 320; i += 1) m.add({ id: `bulk-${i}`, at: T0 - i * 1000, threadId: `bulk-t-${i % 40}` })
    await h.connect()
    await h.mailroom.runAlarm()
    // One run stopped at its budget, with its pages stored and the job saved.
    expect(stored(h)).toHaveLength(200)
    expect((await status(h)).state).toBe('filling')
    expect(firstGmail(h.inbox)?.historyId).toBeNull()
    expect(h.google.count('listHistory')).toBe(0)

    expect(await h.drain()).toBeGreaterThanOrEqual(2)
    expect(stored(h)).toHaveLength(320)
    for (let i = 0; i < 320; i += 1) expect(h.google.count(`getMessage:bulk-${i}`)).toBe(1)
    expect((await status(h)).state).toBe('live')
    expect(FETCH_BUDGET).toBeLessThan(320)
  })

  test('a run that fails halfway keeps the pages it stored and resumes at the one it was on', async () => {
    const h = harness()
    const m = h.google.mailbox
    m.pageSize = 2
    for (let i = 0; i < 6; i += 1) m.add({ id: `f${i}`, at: T0 - i * 1000 })
    await h.connect()
    h.google.onCall = (call) => {
      if (call !== 'getMessage:f2') return
      h.google.onCall = null
      h.google.failNext('getMessage', new GmailError('Backend Error', 503), 1)
    }
    await h.mailroom.runAlarm()
    expect(stored(h).map((r) => r.gmail_id)).toEqual(['f0', 'f1'])
    expect(firstGmail(h.inbox)?.job?.pageToken).toBe('2')
    expect((await status(h)).lastError).toContain('Backend Error')
    h.tick(30_000)
    await h.drain()
    expect(stored(h)).toHaveLength(6)
    for (let i = 0; i < 6; i += 1) expect(h.google.count(`getMessage:f${i}`)).toBe(i === 2 ? 2 : 1)
    expect((await status(h)).lastError).toBeNull()
  })

  test('one message with a body that cannot be decoded does not stop the fill: it is stored with a marker', async () => {
    const h = harness()
    const m = h.google.mailbox
    m.add({ id: 'fine-1' })
    m.add({ id: 'broken' })
    m.add({ id: 'fine-2' })
    const body = m.messages.get('broken')?.payload?.body
    if (body) body.data = '!!! not base64 !!!'
    await live(h)
    expect(
      stored(h)
        .map((r) => r.gmail_id)
        .sort(),
    ).toEqual(['broken', 'fine-1', 'fine-2'])
    expect((await status(h)).lastError).toBeNull()
    const queue = (await h.request(AGENT, 'GET', '/api/queue')).json
    expect(queue.rows).toHaveLength(3)
  })

  test('a fill that finds nothing still completes, and the cursor is set', async () => {
    const h = harness()
    await live(h)
    expect(firstGmail(h.inbox)?.historyId).toBe(String(h.google.mailbox.historyId))
    expect(stored(h)).toEqual([])
  })
})

describe('the push entrance: who is let in', () => {
  const refused = async (h: H, options: Parameters<H['push']>[0]) => {
    const before = firstGmail(h.inbox)?.pushSeq
    const calls = h.google.calls.length
    const res = await h.push(options)
    expect(res.status).toBe(401)
    expect(firstGmail(h.inbox)?.pushSeq).toBe(before)
    expect(h.google.calls).toHaveLength(calls)
  }

  test('a good token is accepted with 204, and answered before any Gmail call', async () => {
    const h = harness()
    await live(h)
    const calls = h.google.calls.length
    h.alarms.length = 0
    const res = await h.push()
    expect(res.status).toBe(204)
    expect(res.text).toBe('')
    expect(h.google.calls).toHaveLength(calls)
    expect(h.alarms.at(-1)?.getTime()).toBe(h.now())
    const row = firstGmail(h.inbox)
    expect(row?.lastPushAt).toBe('2026-10-20T12:00:00.000Z')
    expect((row?.pushSeq ?? 0) > (row?.syncedSeq ?? 0)).toBe(true)
  })

  test('refused: no token, a wrong audience, a wrong issuer, another account, an unverified email, an expired token', async () => {
    const h = harness()
    await live(h)
    await refused(h, { token: null })
    await refused(h, { token: await mintPush({ audience: 'https://inbox-push.northfield.example/other' }) })
    await refused(h, { token: await mintPush({ audience: 'https://inbox.northfield.example/api/gmail/push' }) })
    await refused(h, { token: await mintPush({ issuer: 'https://accounts.example.com' }) })
    await refused(h, { token: await mintPush({ issuer: 'https://evil.example/accounts.google.com' }) })
    await refused(h, {
      token: await mintPush({ claims: { email: 'someone-else@northfield-mail-000000.iam.gserviceaccount.com' } }),
    })
    await refused(h, { token: await mintPush({ claims: { email: 'tessa@northfield.example' } }) })
    await refused(h, { token: await mintPush({ claims: { email_verified: false } }) })
    await refused(h, { token: await mintPush({ claims: { email_verified: 'true' } }) })
    await refused(h, { token: await mintPush({ claims: { email: undefined } }) })
    await refused(h, { token: await mintPush({ expiresIn: -10 }) })
  })

  test('refused: signed by a key that is not Google’s, an HS256 token, an unsigned token, and junk', async () => {
    const h = harness()
    await live(h)
    await refused(h, { token: await mintPush({ key: forger.privateKey }) })
    const hs = await new SignJWT({ email: PUSH_ACCOUNT, email_verified: true })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('https://accounts.google.com')
      .setAudience(PUSH_ENDPOINT)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('a-shared-secret-of-some-length-0123456789'))
    await refused(h, { token: hs })
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const none = `${enc({ alg: 'none' })}.${enc({ iss: 'https://accounts.google.com', aud: PUSH_ENDPOINT, email: PUSH_ACCOUNT, email_verified: true, exp: 9999999999 })}.`
    await refused(h, { token: none })
    await refused(h, { token: 'not.a.jwt' })
    await refused(h, { token: 'x' })
  })

  test('refused: a token that is not a bearer token', async () => {
    const h = harness()
    const res = await h.pushApp.request(
      'https://inbox-push.northfield.example/api/gmail/push',
      { method: 'POST', headers: { authorization: `Basic ${await mintPush()}` }, body: '{}' },
      h.env,
    )
    expect(res.status).toBe(401)
  })

  test('with the settings unset, everything is refused, a genuine push included', async () => {
    for (const unset of ['GMAIL_PUSH_ENDPOINT', 'GMAIL_PUSH_SERVICE_ACCOUNT'] as const) {
      const h = harness()
      await live(h)
      h.env[unset] = ''
      await refused(h, { token: await mintPush() })
      h.env[unset] = undefined
      await refused(h, { token: await mintPush() })
    }
  })

  test('the push hostname answers the push path and nothing else', async () => {
    const h = harness()
    await live(h)
    for (const options of [
      { method: 'GET' },
      { method: 'PUT' },
      { path: '/' },
      { path: '/api/me' },
      { path: '/api/queue', method: 'GET' },
      { path: '/api/gmail/push/' },
      { path: '/api/gmail/callback', method: 'GET' },
      { path: '/assets/index.js', method: 'GET' },
    ]) {
      const res = await h.push(options)
      expect(res.status).toBe(404)
    }
  })

  test('with the settings unset the push hostname still answers nothing but the push path', async () => {
    const h = harness()
    await live(h)
    h.env.GMAIL_PUSH_ENDPOINT = undefined
    h.env.GMAIL_PUSH_SERVICE_ACCOUNT = undefined
    for (const options of [
      { method: 'GET' },
      { path: '/' },
      { path: '/api/me' },
      { path: '/assets/index.js', method: 'GET' },
    ]) {
      expect((await h.push(options)).status).toBe(404)
    }
    // The push path itself is refused as unconfigured, never accepted.
    expect((await h.push()).status).toBe(401)
    // And Claude's door is unchanged.
    expect((await h.request(AGENT, 'GET', '/api/mailbox')).status).toBe(200)
  })

  test('the push path means nothing on Claude’s door, with or without a token, and nothing answers on inbox.northfield.example at all', async () => {
    const h = harness()
    await live(h)
    const before = firstGmail(h.inbox)?.pushSeq
    expect((await h.request(AGENT, 'POST', '/api/gmail/push', pushBody())).status).toBe(404)
    expect((await h.request(null, 'POST', '/api/gmail/push', pushBody())).status).toBe(401)
    // The old address of the inbox's page is not a host the Worker answers on: not the push, not a queue read with a valid push token's headers, not the page.
    for (const path of ['/api/gmail/push', '/api/queue', '/', '/api/mailbox']) {
      expect((await h.push({ host: 'inbox.northfield.example', path })).status, path).toBe(404)
    }
    expect(firstGmail(h.inbox)?.pushSeq).toBe(before)
  })

  test('Claude’s door is behind Access, push configured or not', async () => {
    const h = harness()
    expect((await h.request(null, 'GET', '/')).status).toBe(401)
    expect((await h.request(null, 'GET', '/api/mailbox')).status).toBe(401)
  })

  test('a genuine push with a body that is junk is still acknowledged, and still owes a sync', async () => {
    const h = harness()
    await live(h)
    const before = firstGmail(h.inbox)?.pushSeq ?? 0
    const token = await mintPush()
    const res = await h.pushApp.request(
      'https://inbox-push.northfield.example/api/gmail/push',
      { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: 'not json at all' },
      h.env,
    )
    expect(res.status).toBe(204)
    expect(firstGmail(h.inbox)?.pushSeq).toBe(before + 1)
  })

  test('a push for another mailbox, or before any is connected, is acknowledged and dropped', async () => {
    const h = harness()
    expect((await h.push()).status).toBe(204)
    expect(firstGmail(h.inbox)).toBeNull()
    expect(h.alarms).toEqual([])
    await live(h)
    const before = firstGmail(h.inbox)?.pushSeq
    expect((await h.push({ body: pushBody('someone-else@example.com') })).status).toBe(204)
    expect(firstGmail(h.inbox)?.pushSeq).toBe(before)
  })
})

describe('a push becoming stored mail', () => {
  test('a message that arrives is stored within the push, once, with its labels', async () => {
    const h = harness()
    await live(h)
    h.google.mailbox.add({ id: 'new-1', subject: 'Hello', from: 'Bob <bob@example.org>' })
    expect(stored(h)).toHaveLength(0)
    expect((await h.push()).status).toBe(204)
    expect(await h.drain()).toBe(1)
    expect(stored(h).map((r) => r.gmail_id)).toEqual(['new-1'])
    const queue = (await h.request(AGENT, 'GET', '/api/queue')).json
    expect(queue.rows).toHaveLength(1)
    expect(queue.rows[0]).toMatchObject({ title: 'Bob', subject: 'Hello', kind: 'email' })
    const s = await status(h)
    expect(s.lastPushAt).toBe('2026-10-20T12:00:00.000Z')
    expect(s.lastSyncAt).toBe('2026-10-20T12:00:00.000Z')
    expect(s.health.amber).toBe(false)
  })

  test('the same push delivered twice, or three times, shows the message once', async () => {
    const h = harness()
    await live(h)
    h.google.mailbox.add({ id: 'once' })
    await h.push()
    await h.push()
    await h.push()
    await h.drain()
    await h.push()
    await h.drain()
    expect(stored(h)).toHaveLength(1)
    expect(h.google.count('getMessage:once')).toBe(1)
    expect(count(h, 'conversation')).toBe(1)
  })

  test('a push when nothing has changed fetches nothing and stores nothing', async () => {
    const h = harness()
    await live(h, () => {
      h.google.mailbox.add()
    })
    const fetched = h.google.count('getMessage')
    await h.push()
    await h.drain()
    expect(h.google.count('getMessage')).toBe(fetched)
    expect(stored(h)).toHaveLength(1)
  })

  test('nothing polls: with nothing owed, an alarm that fires anyway asks Gmail nothing', async () => {
    const h = harness()
    await live(h)
    expect(h.alarms).toEqual([])
    const calls = h.google.calls.length
    await h.mailroom.runAlarm()
    expect(h.google.calls).toHaveLength(calls)
  })

  test('a reply that Gmail files out of the Inbox is stored because its conversation is held; spam is not', async () => {
    const h = harness()
    await live(h, () => {
      h.google.mailbox.add({ id: 'first', threadId: 'thread-1' })
    })
    h.google.mailbox.add({ id: 'reply', threadId: 'thread-1', labels: ['CATEGORY_UPDATES'] })
    h.google.mailbox.add({ id: 'elsewhere', threadId: 'thread-2', labels: ['CATEGORY_UPDATES'] })
    h.google.mailbox.add({ id: 'junk', threadId: 'thread-3', labels: ['SPAM'] })
    await h.push()
    await h.drain()
    expect(stored(h).map((r) => r.gmail_id)).toEqual(['first', 'reply'])
  })

  test('a push that lands while a sync is running is not lost', async () => {
    const h = harness()
    await live(h)
    h.google.mailbox.add({ id: 'late-1' })
    h.google.onCall = (call) => {
      if (call !== 'getMessage:late-1') return
      h.google.onCall = null
      h.google.mailbox.add({ id: 'late-2' })
      void h.mailroom.receivePush(null)
    }
    await h.push()
    expect(await h.drain()).toBe(2)
    expect(stored(h).map((r) => r.gmail_id)).toEqual(['late-1', 'late-2'])
    const row = firstGmail(h.inbox)
    expect(row?.syncedSeq).toBe(row?.pushSeq ?? -1)
  })

  test('a long gap is read in pages, and the cursor moves only past a page that was stored', async () => {
    const h = harness()
    const m = h.google.mailbox
    await live(h)
    m.pageSize = 2
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) m.add({ id })
    const afterSecondRecord = m.history[m.history.length - 4]?.id
    h.google.onCall = (call) => {
      if (call !== 'getMessage:p3') return
      h.google.onCall = null
      h.google.failNext('getMessage', new GmailError('Backend Error', 503), 1)
    }
    await h.push()
    await h.drain()
    expect(stored(h).map((r) => r.gmail_id)).toEqual(['p1', 'p2'])
    expect(firstGmail(h.inbox)?.historyId).toBe(afterSecondRecord ?? '')
    expect((await status(h)).lastError).toContain('Backend Error')

    h.tick(30_000)
    await h.drain()
    expect(stored(h).map((r) => r.gmail_id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
    expect(firstGmail(h.inbox)?.historyId).toBe(String(m.historyId))
    expect(h.google.count('getMessage:p1')).toBe(1)
  })
})

describe('a failure, and the retry after it', () => {
  test('the cursor stays, the error shows in the header, the retry backs off and doubles, and a success clears it', async () => {
    const h = harness()
    await live(h)
    const cursor = firstGmail(h.inbox)?.historyId
    h.google.mailbox.add({ id: 'x' })
    h.google.failNext('getMessage', new GmailError('Backend Error', 500), 2)
    await h.push()
    await h.drain()
    expect(firstGmail(h.inbox)?.historyId).toBe(cursor ?? '')
    let s = await status(h)
    expect(s.lastError).toContain('Backend Error')
    expect(s.health).toMatchObject({ amber: true })
    expect(h.alarms.at(-1)?.getTime()).toBe(h.now() + backoffMs(1))
    expect(await h.drain()).toBe(0)

    h.tick(backoffMs(1))
    await h.drain()
    expect(h.alarms.at(-1)?.getTime()).toBe(h.now() + backoffMs(2))
    expect(backoffMs(2)).toBe(2 * backoffMs(1))
    expect((await status(h)).lastError).toContain('Backend Error')

    h.tick(backoffMs(2))
    await h.drain()
    s = await status(h)
    expect(s.lastError).toBeNull()
    expect(s.health.amber).toBe(false)
    expect(stored(h).map((r) => r.gmail_id)).toEqual(['x'])
  })

  test('the delay is 30 seconds, doubling, capped at an hour', () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000])
    expect(backoffMs(30)).toBe(3_600_000)
    expect(backoffMs(0)).toBe(30_000)
  })

  test('a push during a backoff retries at once', async () => {
    const h = harness()
    await live(h)
    h.google.mailbox.add({ id: 'x' })
    h.google.failNext('listHistory', new GmailError('Backend Error', 500), 1)
    await h.push()
    await h.drain()
    expect(stored(h)).toHaveLength(0)
    await h.push()
    await h.drain()
    expect(stored(h)).toHaveLength(1)
  })

  test('a grant Google no longer honours stops the retries and says to reconnect', async () => {
    const h = harness()
    await live(h)
    h.google.grantRevoked = true
    h.google.mailbox.add({ id: 'x' })
    await h.push()
    h.alarms.length = 0
    await h.mailroom.runAlarm()
    expect(h.alarms).toEqual([])
    const s = await status(h)
    expect(s.lastError).toContain('Connect Gmail again')
    expect(s.health.amber).toBe(true)
    expect(stored(h)).toHaveLength(0)
  })
})

describe('a stale cursor and the recovery from it', () => {
  async function gap() {
    const h = harness()
    const m = h.google.mailbox
    await live(h, () => {
      m.add({ id: 'old-1', threadId: 'thread-1', labels: ['INBOX', 'UNREAD'] })
      m.add({ id: 'old-2', threadId: 'thread-2', labels: ['INBOX', 'UNREAD'] })
      m.add({
        id: 'sent-1',
        threadId: 'thread-3',
        labels: ['SENT'],
        from: 'Tessa Marlow <tessa@northfield.example>',
        to: 'Bob <bob@example.org>',
      })
    })
    // The gap: mail arrives, one conversation is archived and one read, and Gmail forgets the history.
    h.tick(DAY)
    m.clock += DAY
    m.add({ id: 'gap-1', threadId: 'thread-2' })
    m.add({ id: 'gap-2', threadId: 'thread-4' })
    m.quietly('old-1', { remove: ['INBOX'] })
    m.quietly('old-2', { remove: ['UNREAD'] })
    m.forgetHistory()
    return { h, m }
  }

  test('Gmail saying "not found" starts a resync, which fills the gap and corrects the labels, and stamps when', async () => {
    const { h, m } = await gap()
    expect((await status(h)).lastResyncAt).toBeNull()
    await h.mailroom.requestSync()
    await h.drain()

    expect(
      stored(h)
        .map((r) => r.gmail_id)
        .sort(),
    ).toEqual(['gap-1', 'gap-2', 'old-1', 'old-2', 'sent-1'])
    const labels = (id: string) => JSON.parse(stored(h).find((r) => r.gmail_id === id)?.labels ?? '[]')
    expect(labels('old-1')).not.toContain('INBOX')
    expect(labels('old-2')).not.toContain('UNREAD')
    expect(labels('old-2')).toContain('INBOX')
    expect(firstGmail(h.inbox)?.historyId).toBe(String(m.historyId))
    const s = await status(h)
    expect(s).toMatchObject({ state: 'live', lastResyncAt: '2026-10-21T12:00:00.000Z', lastError: null })
    expect(h.inbox.listAudit(50).map((a) => a.action)).toEqual(
      expect.arrayContaining(['mailbox.resync-start', 'mailbox.resync-complete']),
    )
  })

  test('it re-reads the labels of the OPEN conversations, and of every held thread the window names', async () => {
    const { h } = await gap()
    await h.mailroom.requestSync()
    await h.drain()
    const reread = h.google.calls.filter((c) => c.startsWith('getThreadLabels:')).sort()
    // The listing names held threads 2 and 3 (read once each, closed or open), and the label stage then
    // reads every open one: 1 (archived in Gmail, so no longer listed), 2 and 4 (new). Never a thread twice in one stage.
    expect(reread).toEqual([
      'getThreadLabels:thread-1',
      'getThreadLabels:thread-2',
      'getThreadLabels:thread-2',
      'getThreadLabels:thread-3',
      'getThreadLabels:thread-4',
    ])
  })

  test('a CLOSED conversation whose labels changed during the gap is refreshed too, not only the open ones', async () => {
    const { h, m } = await gap()
    // thread-3 holds only a message Tessa sent, so it is closed here. In the gap it was starred and read.
    m.quietly('sent-1', { add: ['STARRED'] })
    await h.mailroom.requestSync()
    await h.drain()
    const labels = JSON.parse(stored(h).find((r) => r.gmail_id === 'sent-1')?.labels ?? '[]')
    expect(labels).toEqual(['SENT', 'STARRED'])
  })

  test('it lists from a day before the newest message held, and leaves the cursor alone until it is done', async () => {
    const { h } = await gap()
    const newest = Date.parse(h.inbox.newestMessageAt(firstGmail(h.inbox)?.id ?? '') ?? '')
    const stale = firstGmail(h.inbox)?.historyId
    h.google.failNext('listMessageIds', new GmailError('Backend Error', 500), 1)
    await h.mailroom.requestSync()
    await h.mailroom.runAlarm()
    await h.mailroom.runAlarm()
    const job = firstGmail(h.inbox)?.job
    expect(job).toMatchObject({ kind: 'resync', stage: 'list' })
    expect(job?.query).toBe(`(in:inbox OR in:sent) after:${Math.floor((newest - DAY) / 1000)}`)
    expect(firstGmail(h.inbox)?.historyId).toBe(stale ?? '')
    expect((await status(h)).state).toBe('resyncing')
  })

  test('the new cursor is read BEFORE the window is listed, so mail arriving meanwhile is caught by the sync after', async () => {
    const { h, m } = await gap()
    h.google.onCall = (call) => {
      if (call !== 'listMessageIds:first') return
      h.google.onCall = null
      m.add({ id: 'during-resync', threadId: 'thread-9' })
    }
    await h.mailroom.requestSync()
    await h.drain()
    expect(stored(h).map((r) => r.gmail_id)).toContain('during-resync')
    expect(h.google.count('getMessage:during-resync')).toBe(1)
  })

  test('a message already held is not fetched again by the resync', async () => {
    const { h } = await gap()
    const before = h.google.count('getMessage:old-1')
    await h.mailroom.requestSync()
    await h.drain()
    expect(h.google.count('getMessage:old-1')).toBe(before)
  })

  test('after a resync, pushes work as before', async () => {
    const { h, m } = await gap()
    await h.mailroom.requestSync()
    await h.drain()
    m.add({ id: 'after' })
    await h.push()
    await h.drain()
    expect(stored(h).map((r) => r.gmail_id)).toContain('after')
    expect(h.google.calls.filter((c) => c.startsWith('listHistory')).length).toBeGreaterThan(1)
  })

  test('with nothing held at all, a stale cursor resyncs thirty days back', async () => {
    const h = harness()
    await live(h)
    h.google.mailbox.add({ id: 'only' })
    h.google.mailbox.forgetHistory()
    h.google.failNext('listMessageIds', new GmailError('x', 500), 1)
    await h.mailroom.requestSync()
    await h.mailroom.runAlarm()
    await h.mailroom.runAlarm()
    expect(firstGmail(h.inbox)?.job?.query).toBe(`(in:inbox OR in:sent) after:${Math.floor((T0 - 30 * DAY) / 1000)}`)
  })
})

describe('the daily pass', () => {
  test('renews the watch and runs one sync from the cursor even when nothing was pushed', async () => {
    const h = harness()
    await live(h)
    const watches = h.google.count('watch')
    const histories = h.google.count('listHistory')
    h.google.watchExpiration = Date.parse('2026-11-03T12:00:00.000Z')
    h.tick(DAY)
    await h.mailroom.runDaily()
    expect(h.google.count('watch')).toBe(watches + 1)
    expect(h.google.count('listHistory')).toBe(histories + 1)
    expect((await status(h)).watchExpiry).toBe('2026-11-03T12:00:00.000Z')
  })

  test('on a healthy day it finds nothing and stores nothing', async () => {
    const h = harness()
    await live(h, () => {
      h.google.mailbox.add()
    })
    const fetched = h.google.count('getMessage')
    await h.mailroom.runDaily()
    expect(h.google.count('getMessage')).toBe(fetched)
    expect((await status(h)).health.amber).toBe(false)
  })

  test('new mail it finds when no push has come for a day means pushes are broken, until one arrives', async () => {
    const h = harness()
    await live(h)
    h.tick(2 * DAY)
    h.google.mailbox.add({ id: 'missed' })
    await h.mailroom.runDaily()
    expect(stored(h).map((r) => r.gmail_id)).toEqual(['missed'])
    let s = await status(h)
    expect(s.health.amber).toBe(true)
    expect(s.health.reasons.join(' ')).toContain('pushed')
    h.tick(1000)
    await h.push()
    await h.drain()
    s = await status(h)
    expect(s.health.reasons.join(' ')).not.toContain('pushed')
  })

  test('new mail it finds shortly after a push is not a sign pushes are broken', async () => {
    const h = harness()
    await live(h)
    await h.push()
    await h.drain()
    h.tick(DAY - 60_000)
    h.google.mailbox.add({ id: 'late' })
    await h.mailroom.runDaily()
    expect(stored(h)).toHaveLength(1)
    expect(firstGmail(h.inbox)?.pushSuspectAt).toBeNull()
  })

  test('a gap bigger than one run is carried on by alarm, and pushes are called broken as soon as the pass stored mail', async () => {
    const h = harness()
    await live(h)
    h.tick(2 * DAY)
    for (let i = 0; i < 260; i += 1) h.google.mailbox.add({ id: `gap-${i}`, threadId: `gap-t-${i}` })
    h.alarms.length = 0
    await h.mailroom.runDaily()

    // The run stopped at its budget with 200 stored, and did not leave the rest to nobody.
    expect(stored(h)).toHaveLength(200)
    expect(h.alarms.at(-1)?.getTime()).toBe(h.now())
    expect(firstGmail(h.inbox)?.pushSuspectAt).not.toBeNull()
    expect((await status(h)).health.reasons.join(' ')).toContain('pushed')

    expect(await h.drain()).toBeGreaterThanOrEqual(1)
    expect(stored(h)).toHaveLength(260)
    for (let i = 0; i < 260; i += 1) expect(h.google.count(`getMessage:gap-${i}`)).toBe(1)
    const row = firstGmail(h.inbox)
    expect(row?.syncedSeq).toBe(row?.pushSeq ?? -1)
    expect(row?.historyId).toBe(String(h.google.mailbox.historyId))
  })

  test('a watch that cannot be renewed still syncs, and the error is not cleared by the sync that succeeded', async () => {
    const h = harness()
    await live(h)
    h.google.mailbox.add({ id: 'x' })
    h.google.failNext('watch', new GmailError('quota', 429), 1)
    await h.mailroom.runDaily()
    expect(stored(h)).toHaveLength(1)
    expect((await status(h)).lastError).toContain('Could not renew the live connection')
    await h.mailroom.runDaily()
    expect((await status(h)).lastError).toBeNull()
  })

  test('the header goes amber as the watch nears its end, and again if it lapses', async () => {
    const h = harness()
    await live(h)
    expect((await status(h)).health.amber).toBe(false)
    h.tick(6 * DAY + 60_000)
    expect((await status(h)).health.reasons).toEqual(['The live connection to Gmail runs out within a day.'])
    h.tick(2 * DAY)
    expect((await status(h)).health.reasons).toEqual(['The live connection to Gmail has lapsed.'])
  })

  test('with nothing connected, or after a disconnect, it does nothing', async () => {
    const h = harness()
    await h.mailroom.runDaily()
    expect(h.google.calls).toEqual([])
    await live(h)
    await disconnect(h)
    const calls = h.google.calls.length
    await h.mailroom.runDaily()
    expect(h.google.calls).toHaveLength(calls)
  })
})

describe('disconnecting and reconnecting', () => {
  test('stops the watch, revokes the grant, forgets the token, and later pushes are ignored', async () => {
    const h = harness()
    await live(h, () => {
      h.google.mailbox.add()
    })
    const res = await disconnect(h)
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ revoked: true })
    expect(h.google.calls).toContain('stop')
    expect(h.google.revoked).toEqual(['refresh-token-1'])
    expect(firstGmail(h.inbox)?.refreshToken).toBeNull()
    expect(await status(h)).toMatchObject({ connected: false, state: 'disconnected', messages: 1 })

    const seq = firstGmail(h.inbox)?.pushSeq
    h.alarms.length = 0
    expect((await h.push()).status).toBe(204)
    expect(h.alarms).toEqual([])
    expect(firstGmail(h.inbox)?.pushSeq).toBe(seq)
    expect((await disconnect(h)).status).toBe(409)
  })

  test('a revoke Google does not confirm is reported, and the token is gone anyway', async () => {
    const h = harness()
    await live(h)
    h.google.revoke = async () => false
    const res = await disconnect(h)
    expect(res.json).toEqual({ revoked: false })
    expect(firstGmail(h.inbox)?.refreshToken).toBeNull()
  })

  test('connecting again catches up from the cursor it kept, with no second fill', async () => {
    const h = harness()
    await live(h, () => {
      h.google.mailbox.add({ id: 'before' })
    })
    await disconnect(h)
    h.google.mailbox.add({ id: 'while-away' })
    const lists = h.google.count('listMessageIds')
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    expect(h.google.count('listMessageIds')).toBe(lists)
    expect(stored(h).map((r) => r.gmail_id)).toEqual(['before', 'while-away'])
    expect(count(h, 'mailbox')).toBe(1)
    expect((await status(h)).state).toBe('live')
  })
})

describe('asking for a sync', () => {
  test('the owner or the agent can ask, and it is counted as no push', async () => {
    for (const who of ['owner', 'agent']) {
      const h = harness()
      await live(h)
      h.google.mailbox.add({ id: 'x' })
      // Tessa asks through the space, which calls the Mailroom; Claude through its door.
      const res =
        who === 'agent'
          ? await h.request(AGENT, 'POST', '/api/mailbox/sync', {})
          : asHttp(await h.store.call('requestSync'))
      expect(res.status).toBe(200)
      await h.drain()
      expect(stored(h)).toHaveLength(1)
      expect((await status(h)).lastPushAt).toBeNull()
    }
  })

  test('with nothing connected there is nothing to sync', async () => {
    const h = harness()
    expect((await h.request(AGENT, 'POST', '/api/mailbox/sync', {})).status).toBe(409)
  })
})

describe('reading never touches Gmail', () => {
  test('the agent’s reads of the queue, a conversation and a contact make no Gmail call and change nothing', async () => {
    const h = harness()
    await live(h, () => {
      h.google.mailbox.add({ id: 'x' })
    })
    const calls = h.google.calls.length
    const before = JSON.stringify(stored(h))
    const queue = (await h.request(AGENT, 'GET', '/api/queue')).json
    const id = queue.rows[0].id as string
    const conversation = (await h.request(AGENT, 'GET', `/api/conversations/${id}`)).json
    expect(conversation.messages[0]).toMatchObject({ gmailId: 'x', labels: ['INBOX', 'UNREAD'] })
    await h.request(AGENT, 'GET', `/api/contacts/${conversation.contacts[0].id}`)
    await h.request(AGENT, 'GET', '/api/mailbox')
    expect(h.google.calls).toHaveLength(calls)
    expect(JSON.stringify(stored(h))).toBe(before)
  })
})
