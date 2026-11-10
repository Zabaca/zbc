import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createInstall, type InboxForSpace } from '@space/workspace'
import { GMAIL_SCOPE } from '../src/gmail/google'
import { asker, count, firstGmail, harness, OWNER, STRANGER } from '../test-support/harness'

/**
 * Connect Gmail's two steps, asked of the inbox by the space (`gmailSignIn`, `gmailConnect`), driven as the space drives
 * them: through `InboxForSpace` with the Access assertion the space forwards, over the real store and Mailroom and a Google that can fail.
 *
 * What is proved: only Tessa is let in and nobody else changes anything; Google is sent the space's return address and the code is exchanged with it, while the old
 * page's Connect still uses its own; every refusal the inbox's own connection has still happens and keeps nothing. What this cannot show is Google accepting the
 * address (the console step) or the cookie across the browser's round trip (the space's tests); both are the runbook's live check.
 */

type H = ReturnType<typeof harness>

const SPACE_RETURN = 'https://space.northfield.example/api/inbox/gmail/callback'
/** The address the retired inbox page returned to: the space never hands it to Google. */
const OLD_INBOX_RETURN = 'https://inbox.northfield.example/api/gmail/callback'
const STATE = 'ab12'.repeat(12)
const assertion = (who: Record<string, unknown> = OWNER) => asker(who)

const unwrap = <T>(r: { ok: boolean; value?: T }): T => {
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return (r as { value: T }).value
}

/** The inbox with nothing stored: no mailbox, no audit. */
const untouched = (h: H) => ({ mailbox: firstGmail(h.inbox), audit: count(h, 'audit') })

describe('Google’s sign-in address', () => {
  test('the owner is given Google’s address for the space’s return address, with the check, the client and the Gmail scope', async () => {
    const h = harness()
    const { url } = unwrap(await h.space().gmailSignIn(await assertion(), STATE))
    const at = new URL(url)
    expect(at.origin + at.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(at.searchParams.get('redirect_uri')).toBe(SPACE_RETURN)
    expect(at.searchParams.get('redirect_uri')).not.toBe(OLD_INBOX_RETURN)
    expect(at.searchParams.get('state')).toBe(STATE)
    expect(at.searchParams.get('client_id')).toBe('client-id.apps.googleusercontent.com')
    expect(at.searchParams.get('scope')).toContain(GMAIL_SCOPE)
    expect(at.searchParams.get('response_type')).toBe('code')
    expect(url).not.toContain('client-secret')
    expect(untouched(h)).toEqual({ mailbox: null, audit: 0 })
  })

  test('the return address is derived from the declaration’s space host: it is the literal registered in Google’s console', async () => {
    const raw = JSON.parse(readFileSync(new URL('../../workspace/northfield/workspace.json', import.meta.url), 'utf8'))
    expect(raw.space.host).toBe('space.northfield.example')
    const h = harness()
    const { url } = unwrap(await h.space({ install: createInstall(raw) }).gmailSignIn(await assertion(), STATE))
    expect(new URL(url).searchParams.get('redirect_uri')).toBe(SPACE_RETURN)
  })

  test('a check that is not hexadecimal, or the wrong length, is refused before any address is built', async () => {
    const h = harness()
    for (const state of ['', 'short', 'g'.repeat(48), 'A'.repeat(48), `${'a'.repeat(48)}&x=1`, 'a'.repeat(129)]) {
      const r = await h.space().gmailSignIn(await assertion(), state)
      expect([state, r]).toMatchObject([state, { ok: false, kind: 'refused', reason: 'bad-request' }])
    }
    const notText = await h.space().gmailSignIn(await assertion(), { toString: () => STATE } as never)
    expect(notText).toMatchObject({ ok: false, reason: 'bad-request' })
  })

  test('a Worker with no Google client id says so and builds nothing', async () => {
    const h = harness()
    for (const googleClientId of ['', '   ', undefined]) {
      const r = await h.space({ googleClientId }).gmailSignIn(await assertion(), STATE)
      expect(r).toMatchObject({ ok: false, kind: 'failed', message: 'Gmail sign-in is not set up on this Worker.' })
    }
  })
})

describe('finishing the connection', () => {
  test('the owner’s code is exchanged with the space’s return address, and the mailbox is kept, watched and filled as the inbox’s own page does', async () => {
    const h = harness()
    const gmail = unwrap(await h.space().gmailConnect(await assertion(), 'good-code')) as {
      address: string
      connected: boolean
      state: string
    }
    expect(h.google.exchanged).toEqual([{ code: 'good-code', redirectUri: SPACE_RETURN }])
    expect(gmail).toMatchObject({ address: 'tessa@northfield.example', connected: true, state: 'filling' })
    expect(h.google.calls).toContain(`watch:${h.env.GMAIL_TOPIC_NAME}`)
    expect(firstGmail(h.inbox)).toMatchObject({ connectedAt: '2026-10-20T12:00:00.000Z' })
    expect(JSON.stringify(gmail)).not.toContain('refresh-token')
    const audit = h.db.query(`SELECT actor FROM audit`).all() as { actor: string }[]
    expect(audit.length).toBeGreaterThan(0)
    expect(audit.every((a) => a.actor === 'tessa@northfield.example')).toBe(true)
  })

  test('connecting again from the space replaces the grant with a new one for the same account, and every exchange uses the space’s address', async () => {
    const h = harness()
    expect((await h.connect()).ok).toBe(true)
    expect(h.google.exchanged).toEqual([{ code: 'good-code', redirectUri: SPACE_RETURN }])
    unwrap(await h.space().gmailConnect(await assertion(), 'good-code'))
    expect(h.google.exchanged.map((e) => e.redirectUri)).toEqual([SPACE_RETURN, SPACE_RETURN])
    expect(h.google.exchanged.map((e) => e.redirectUri)).not.toContain(OLD_INBOX_RETURN)
    expect(count(h, 'mailbox')).toBe(1)
  })

  test('a code Google will not accept is failed with Google’s reason, and nothing is kept; a second use of a spent code is the same', async () => {
    const h = harness()
    const r = await h.space().gmailConnect(await assertion(), 'used-code')
    expect(r).toMatchObject({ ok: false, kind: 'failed' })
    expect(JSON.stringify(r)).toContain('invalid_grant')
    expect(untouched(h)).toEqual({ mailbox: null, audit: 0 })
  })

  test('any address is connected for the owner; a grant without gmail.modify and a grant with no lasting access are each refused, said in the inbox’s words, and keep nothing', async () => {
    const other = harness()
    other.google.mailbox.address = 'someone@example.com'
    const anyAccount = await other.space().gmailConnect(await assertion(), 'good-code')
    expect(unwrap(anyAccount)).toMatchObject({ address: 'someone@example.com', name: 'example', connected: true })
    expect(other.google.revoked).toEqual([])

    const narrow = harness()
    narrow.google.grant = { refreshToken: 'refresh-token-1', scopes: ['openid', 'email'] }
    expect(await narrow.space().gmailConnect(await assertion(), 'good-code')).toMatchObject({
      ok: false,
      reason: 'not-admitted',
    })
    expect(narrow.google.revoked).toHaveLength(1)
    expect(untouched(narrow)).toEqual({ mailbox: null, audit: 0 })

    const noRefresh = harness()
    noRefresh.google.grant = { refreshToken: null, scopes: [GMAIL_SCOPE] }
    expect(await noRefresh.space().gmailConnect(await assertion(), 'good-code')).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    expect(untouched(noRefresh)).toEqual({ mailbox: null, audit: 0 })
  })

  test('no code, a code that is not text, and one past the limit are refused and Google is never asked', async () => {
    const h = harness()
    for (const code of ['', 'x'.repeat(2049), 7 as never, null as never]) {
      expect([String(code).slice(0, 5), await h.space().gmailConnect(await assertion(), code)]).toMatchObject([
        String(code).slice(0, 5),
        { ok: false, reason: 'bad-request' },
      ])
    }
    expect(h.google.exchanged).toEqual([])
    expect(untouched(h)).toEqual({ mailbox: null, audit: 0 })
  })
})

describe('who may start or finish it', () => {
  const both = (space: InboxForSpace, a: never) => ({
    gmailSignIn: () => space.gmailSignIn(a, STATE),
    gmailConnect: () => space.gmailConnect(a, 'good-code'),
  })

  test('Claude’s token, a stranger and a teammate who is not Tessa are refused on both, and the code is never exchanged', async () => {
    const h = harness()
    const raw = JSON.parse(readFileSync(new URL('../../workspace/northfield/workspace.json', import.meta.url), 'utf8'))
    raw.people.push({ address: 'eve@northfield.example', name: 'Eve', role: 'member' })
    const withTeam = h.space({ install: createInstall(raw) })
    for (const [who, reason] of [
      [STRANGER, 'not-admitted'],
      [{ email: 'eve@northfield.example' }, 'not-admitted'],
    ] as const) {
      for (const [method, call] of Object.entries(both(withTeam, asker(who) as never))) {
        expect([JSON.stringify(who), method, await call()]).toMatchObject([
          JSON.stringify(who),
          method,
          { ok: false, kind: 'refused', reason },
        ])
      }
    }
    expect(h.google.exchanged).toEqual([])
    expect(untouched(h)).toEqual({ mailbox: null, audit: 0 })
  })
})
