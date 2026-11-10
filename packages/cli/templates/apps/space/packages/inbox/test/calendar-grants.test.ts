import { describe, expect, test } from 'bun:test'
import { CALENDAR_EVENTS_SCOPE, CALENDAR_READONLY_SCOPE } from '@space/workspace'
import { buildAuthUrl, GMAIL_SCOPE, OAUTH_SCOPES } from '../src/gmail/google'
import { lapsedReason } from '../src/gmail/health'
import { asker, harness, OWNER, T0 } from '../test-support/harness'

/**
 * The calendar's door into the inbox's Google grant (the calendar reuses this Google client and project, and each account is connected again once to add
 * the calendar permissions; the same day: Connect calendar asks for reading AND the permission to change events, so booking needs no second consent). What is proved, over the real store and Mailroom and a Google that can fail:
 *  - the mailboxes' consent request never names a calendar scope, and the calendar's own Connect (Settings, Calendars) asks for the calendar alone, incrementally, so mail is never held behind a calendar consent and a calendar
 *    grant keeps mail's;
 *  - a grant that carries the calendar permission leaves mail working exactly as before, and one without it still connects (Google's consent lets a person untick a permission) and is
 *    told apart by `calendarGrants`;
 *  - the calendar is handed an access token limited to the calendar permission and never a refresh token, in an answer or in an error;
 *  - a grant Google ends is lapsed for mail and calendar together, in the one sentence both use.
 * What this cannot show is Google honouring a narrowed refresh (the runbook's hand test reads the token's scope from Google).
 */

const MAIL = [GMAIL_SCOPE, 'openid', 'email']
const READ_ONLY = [...MAIL, CALENDAR_READONLY_SCOPE]
const WITH_CALENDAR = [...MAIL, CALENDAR_READONLY_SCOPE, CALENDAR_EVENTS_SCOPE]
const unwrap = <T>(r: { ok: boolean; value?: T }): T => {
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return (r as { value: T }).value
}

const RETURN = 'https://space.northfield.example/api/inbox/gmail/callback'
const STATE = 'ab12'.repeat(12)

describe('the mailboxes’ consent request never names a calendar scope, so mail is never held behind a calendar consent', () => {
  test('the constant, the address and the address the space hands the browser (Connect, and Connect again) are mail’s three and nothing else', async () => {
    const constant: string[] = [...OAUTH_SCOPES]
    expect(constant).toEqual(MAIL)
    const url = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: RETURN, state: 'abc' }))
    expect(url.searchParams.get('scope')).toBe(MAIL.join(' '))
    const h = harness()
    for (const purpose of [undefined, 'mail'] as const) {
      const { url: sent } = unwrap(await h.space().gmailSignIn(await asker(OWNER), STATE, undefined, purpose))
      const asked = new URL(sent).searchParams.get('scope') ?? ''
      expect(asked.split(' ')).toEqual(MAIL)
      expect(asked).not.toContain('calendar')
      expect(new URL(sent).searchParams.get('prompt')).toBe('consent')
    }
    // A reconnect of an account that has a calendar grant still asks for mail alone: Google adds what was granted, it is not asked for.
    expect(
      new URL(buildAuthUrl({ clientId: 'cid', redirectUri: RETURN, state: 'abc' })).searchParams.get(
        'include_granted_scopes',
      ),
    ).toBe('true')
  })

  test('the grant a mail-only Connect returns is kept as it is, and mail works: a calendar permission neither narrows nor breaks it', async () => {
    const h = harness()
    h.google.mailbox.add({ id: 'm1', threadId: 't1', subject: 'Quote', at: T0 })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    expect(h.inbox.gmailMailboxes()[0]?.scopes).toEqual(MAIL)
    expect(h.inbox.mailboxStatuses()[0]?.state).toBe('live')
  })
})

describe('the calendar’s own Connect (Settings, Calendars) adds the calendar permission incrementally and keeps mail’s grant', () => {
  test('its address asks for the calendar permissions alone, keeps what was granted, and hints the account; a purpose that is none is refused', async () => {
    const h = harness()
    expect((await h.connect()).ok).toBe(true)
    const id = h.inbox.gmailMailboxes()[0]?.id as string
    const { url } = unwrap(await h.space().gmailSignIn(await asker(OWNER), STATE, id, 'calendar'))
    const at = new URL(url)
    expect(at.searchParams.get('scope')).toBe(`${CALENDAR_READONLY_SCOPE} ${CALENDAR_EVENTS_SCOPE}`)
    expect(at.searchParams.get('include_granted_scopes')).toBe('true')
    expect(at.searchParams.get('login_hint')).toBe('tessa@northfield.example')
    expect(at.searchParams.get('redirect_uri')).toBe(RETURN)
    expect(await h.space().gmailSignIn(await asker(OWNER), STATE, undefined, 'both' as never)).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    expect(await h.space().gmailConnect(await asker(OWNER), 'good-code', 'both' as never)).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    // Only the first Connect (the setup's) spent a code: the refused purposes asked Google for nothing.
    expect(h.google.exchanged.length).toBe(1)
  })

  test('a grant that comes back with mail’s permissions and the calendar’s replaces the old grant on the same account: nothing is revoked, mail still syncs, and the calendar is told', async () => {
    const h = harness()
    h.google.mailbox.add({ id: 'm1', threadId: 't1', subject: 'Quote', at: T0 })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    expect(await h.mailroom.calendarGrants()).toMatchObject([{ calendar: false }])
    h.google.reissue('refresh-token-1', 'refresh-token-2', 'cal-code', WITH_CALENDAR)
    const done = await h.mailroom.connectMailbox('cal-code', 'tessa@northfield.example', RETURN, 'calendar')
    expect(done.ok, JSON.stringify(done)).toBe(true)
    expect(h.inbox.gmailMailboxes().length).toBe(1)
    expect(h.inbox.gmailMailboxes()[0]).toMatchObject({ refreshToken: 'refresh-token-2', scopes: WITH_CALENDAR })
    expect(h.google.revoked).toEqual([])
    expect(await h.mailroom.calendarGrants()).toMatchObject([
      { address: 'tessa@northfield.example', connected: true, lapsed: false, calendar: true, events: true },
    ])
    // Mail did not notice: a new message arrives and is stored.
    h.google.mailbox.add({ id: 'm2', threadId: 't2', subject: 'After the calendar', at: T0 + 1000 })
    await h.mailroom.receivePush('tessa@northfield.example')
    await h.drain()
    expect((h.db.query(`SELECT count(*) AS n FROM message`).get() as { n: number }).n).toBe(2)
    expect(h.inbox.mailboxStatuses()[0]?.state).toBe('live')
  })

  test('a grant that has the reading permission but not the permission to change events is kept and counts as connected for reading: nothing is refused, nothing revoked, and the grant list says it cannot edit', async () => {
    const h = harness()
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    h.google.reissue('refresh-token-1', 'refresh-token-2', 'cal-code', READ_ONLY)
    const done = await h.mailroom.connectMailbox('cal-code', 'tessa@northfield.example', RETURN, 'calendar')
    expect(done.ok, JSON.stringify(done)).toBe(true)
    expect(h.google.revoked).toEqual([])
    expect(h.inbox.gmailMailboxes()[0]).toMatchObject({ refreshToken: 'refresh-token-2', scopes: READ_ONLY })
    expect(await h.mailroom.calendarGrants()).toMatchObject([{ calendar: true, events: false }])
    expect(await h.mailroom.calendarAccess('tessa@northfield.example')).toMatchObject({ ok: true })
    // A grant that has the permission to change events but not the reading one is still not a connected calendar.
    h.google.reissue('refresh-token-2', 'refresh-token-3', 'cal-code-2', [...MAIL, CALENDAR_EVENTS_SCOPE])
    expect(await h.mailroom.connectMailbox('cal-code-2', 'tessa@northfield.example', RETURN, 'calendar')).toMatchObject(
      {
        ok: false,
        status: 422,
      },
    )
    expect(h.inbox.gmailMailboxes()[0]).toMatchObject({ refreshToken: 'refresh-token-2', scopes: READ_ONLY })
  })

  test('a grant that comes back WITHOUT mail’s permission keeps nothing and revokes nothing: the grant held is still good, and the answer says to connect mail first', async () => {
    const h = harness()
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    h.google.reissue('refresh-token-1', 'refresh-token-2', 'cal-code', ['openid', 'email', CALENDAR_READONLY_SCOPE])
    const done = await h.mailroom.connectMailbox('cal-code', 'tessa@northfield.example', RETURN, 'calendar')
    expect(done).toMatchObject({ ok: false, status: 409 })
    expect(JSON.stringify(done)).toContain('Connect the account in Mailboxes first')
    expect(h.google.revoked).toEqual([])
    expect(h.inbox.gmailMailboxes()[0]).toMatchObject({ refreshToken: 'refresh-token-1', scopes: MAIL })
    expect(h.inbox.mailboxStatuses()[0]?.state).toBe('live')
  })

  test('a grant that comes back without the calendar permission (it was unticked) keeps nothing and revokes nothing, and the account stays as it was', async () => {
    const h = harness()
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    h.google.reissue('refresh-token-1', 'refresh-token-2', 'cal-code', MAIL)
    const done = await h.mailroom.connectMailbox('cal-code', 'tessa@northfield.example', RETURN, 'calendar')
    expect(done).toMatchObject({ ok: false, status: 422 })
    expect(h.google.revoked).toEqual([])
    expect(h.inbox.gmailMailboxes()[0]).toMatchObject({ refreshToken: 'refresh-token-1', scopes: MAIL })
    expect(await h.mailroom.calendarGrants()).toMatchObject([{ calendar: false }])
  })

  test('on an account that was never connected it connects nothing (the mail permission is not in the grant) and revokes nothing', async () => {
    const h = harness()
    h.google.grant = { refreshToken: 'refresh-token-1', scopes: [CALENDAR_READONLY_SCOPE] }
    expect(await h.mailroom.connectMailbox('good-code', 'tessa@northfield.example', RETURN, 'calendar')).toMatchObject({
      ok: false,
      status: 409,
    })
    expect(h.google.revoked).toEqual([])
    expect(h.inbox.gmailMailboxes()).toEqual([])
  })

  test('only the owner connects the calendar, as only the owner connects mail', async () => {
    const h = harness()
    h.google.grant = { refreshToken: 'refresh-token-1', scopes: WITH_CALENDAR }
    expect(await h.mailroom.connectMailbox('good-code', 'someone@example.com', RETURN, 'calendar')).toMatchObject({
      ok: false,
      status: 403,
    })
    expect(h.google.exchanged).toEqual([])
  })

  test('the mailboxes’ Connect is as it was: a grant without gmail.modify is refused and revoked, calendar permission or not', async () => {
    const h = harness()
    h.google.grant = { refreshToken: 'refresh-token-1', scopes: ['openid', 'email', CALENDAR_READONLY_SCOPE] }
    expect(await h.connect()).toMatchObject({ ok: false, status: 403 })
    expect(h.google.revoked).toEqual(['refresh-token-1'])
    expect(h.inbox.gmailMailboxes()).toEqual([])
  })
})

describe('mail after a calendar grant', () => {
  test('an account connected with the calendar permission syncs mail as ever, and is told to the calendar', async () => {
    const h = harness()
    h.google.grant = { refreshToken: 'refresh-token-1', scopes: WITH_CALENDAR }
    h.google.mailbox.add({ id: 'm1', threadId: 't1', subject: 'Quote', at: T0 })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    expect(h.inbox.mailboxStatuses().map((a) => [a.address, a.state])).toEqual([['tessa@northfield.example', 'live']])
    expect((h.db.query(`SELECT count(*) AS n FROM message`).get() as { n: number }).n).toBe(1)
    expect(h.inbox.gmailMailboxes()[0]?.scopes).toEqual(WITH_CALENDAR)
    expect(await h.mailroom.calendarGrants()).toEqual([
      {
        address: 'tessa@northfield.example',
        label: 'northfield',
        connected: true,
        lapsed: false,
        calendar: true,
        events: true,
      },
    ])
  })

  test('a grant without the calendar permission still connects, mail works, and the calendar is told it is missing', async () => {
    const h = harness()
    h.google.mailbox.add({ id: 'm1', threadId: 't1', subject: 'Quote', at: T0 })
    expect((await h.connect()).ok).toBe(true) // the fake's default grant is mail only
    await h.drain()
    expect(h.inbox.mailboxStatuses()[0]?.state).toBe('live')
    expect(await h.mailroom.calendarGrants()).toMatchObject([
      { address: 'tessa@northfield.example', connected: true, calendar: false, events: false },
    ])
    const access = await h.mailroom.calendarAccess('tessa@northfield.example')
    expect(access).toMatchObject({ ok: false, why: 'no-calendar' })
    expect(h.google.accessAsked).toEqual([])
  })
})

describe('the calendar’s access token', () => {
  async function connected() {
    const h = harness()
    h.google.grant = { refreshToken: 'refresh-token-1', scopes: WITH_CALENDAR }
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    return h
  }

  test('is asked of Google for the calendar permission alone, so it cannot read or change mail', async () => {
    const h = await connected()
    const access = await h.mailroom.calendarAccess('TESSA@northfield.example')
    expect(access).toMatchObject({ ok: true })
    expect(h.google.accessAsked).toEqual([
      { refreshToken: 'refresh-token-1', scope: CALENDAR_READONLY_SCOPE, fresh: false },
    ])
    await h.mailroom.calendarAccess('tessa@northfield.example', true)
    expect(h.google.accessAsked.at(-1)).toMatchObject({ scope: CALENDAR_READONLY_SCOPE, fresh: true })
  })

  test('the sync’s level is the default and reading: a token for the events permission is asked for only by name, is refused for a grant that lacks it, and anything else is a reading token', async () => {
    const h = await connected()
    expect(await h.mailroom.calendarAccess('tessa@northfield.example', false, 'events')).toMatchObject({ ok: true })
    expect(h.google.accessAsked).toEqual([
      { refreshToken: 'refresh-token-1', scope: CALENDAR_EVENTS_SCOPE, fresh: false },
    ])
    await h.mailroom.calendarAccess('tessa@northfield.example', false, 'write' as never)
    expect(h.google.accessAsked.at(-1)).toMatchObject({ scope: CALENDAR_READONLY_SCOPE })
    // A grant that reads and cannot edit is refused an events token, without asking Google, and still reads.
    const r = harness()
    r.google.grant = { refreshToken: 'refresh-token-1', scopes: READ_ONLY }
    expect((await r.connect()).ok).toBe(true)
    expect(await r.mailroom.calendarAccess('tessa@northfield.example', false, 'events')).toMatchObject({
      ok: false,
      why: 'no-events',
    })
    expect(r.google.accessAsked).toEqual([])
    expect(await r.mailroom.calendarAccess('tessa@northfield.example')).toMatchObject({ ok: true })
  })

  test('never carries the refresh token, in a grant list or an access answer', async () => {
    const h = await connected()
    const everything = JSON.stringify([
      await h.mailroom.calendarGrants(),
      await h.mailroom.calendarAccess('tessa@northfield.example'),
    ])
    expect(everything).not.toContain('refresh-token-1')
    h.google.lapsed.add('refresh-token-1')
    expect(JSON.stringify(await h.mailroom.calendarAccess('tessa@northfield.example', true))).not.toContain(
      'refresh-token-1',
    )
  })

  test('is refused for an address that is not connected, and for one that was disconnected', async () => {
    const h = await connected()
    expect(await h.mailroom.calendarAccess('nobody@example.com')).toMatchObject({ ok: false, why: 'disconnected' })
    const id = h.inbox.gmailMailboxes()[0]?.id as string
    unwrap(await h.mailroom.disconnectMailbox(id, 'tessa@northfield.example'))
    expect(await h.mailroom.calendarAccess('tessa@northfield.example')).toMatchObject({
      ok: false,
      why: 'disconnected',
    })
    expect(await h.mailroom.calendarGrants()).toMatchObject([{ connected: false }])
  })

  test('a grant Google ended lapses the account for mail and calendar together, once, and the calendar is not given another try', async () => {
    const h = await connected()
    h.google.lapsed.add('refresh-token-1')
    const first = await h.mailroom.calendarAccess('tessa@northfield.example', true)
    expect(first).toEqual({ ok: false, why: 'lapsed', message: lapsedReason('tessa@northfield.example') })
    expect(h.inbox.mailboxStatuses()[0]?.state).toBe('lapsed')
    expect(await h.mailroom.calendarGrants()).toMatchObject([{ lapsed: true }])
    const asked = h.google.accessAsked.length
    expect(await h.mailroom.calendarAccess('tessa@northfield.example')).toMatchObject({ ok: false, why: 'lapsed' })
    expect(h.google.accessAsked.length).toBe(asked)
  })

  test('a failure that is not the grant’s ending is a plain failure and does not lapse the account', async () => {
    const h = await connected()
    h.google.failNext('accessToken', new Error('socket closed'))
    expect(await h.mailroom.calendarAccess('tessa@northfield.example', true)).toMatchObject({
      ok: false,
      why: 'failed',
    })
    expect(h.inbox.mailboxStatuses()[0]?.state).toBe('live')
  })
})
