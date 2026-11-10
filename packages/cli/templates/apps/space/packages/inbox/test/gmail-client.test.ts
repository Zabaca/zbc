import { describe, expect, test } from 'bun:test'
import { CALENDAR_EVENTS_SCOPE, CALENDAR_READONLY_SCOPE } from '@space/workspace'
import {
  buildAuthUrl,
  CALENDAR_OAUTH_SCOPES,
  createGoogle,
  GMAIL_API,
  GMAIL_SCOPE,
  GmailAuthError,
  GmailError,
  GmailHistoryGone,
  GmailPartialChange,
  GmailSendUnknown,
  narrowingNote,
  OAUTH_SCOPES,
  PAGE_SIZE,
  REVOKE_URL,
  THREAD_CHANGES,
  TOKEN_URL,
} from '../src/gmail/google'
import { pushedAddress, pushSettings } from '../src/gmail/push'
import { GMAIL_RETURN } from '../test-support/harness'
import historyPage from './fixtures/gmail/history-page.json'
import listMessages from './fixtures/gmail/list-messages.json'
import plain from './fixtures/gmail/message-plain.json'
import profile from './fixtures/gmail/profile.json'
import pubsubPush from './fixtures/gmail/pubsub-push.json'
import threadMinimal from './fixtures/gmail/thread-minimal.json'
import watch from './fixtures/gmail/watch.json'

/**
 * The real Google module against a fake `fetch`: which URLs it calls, what it
 * sends, how it turns Google's refusals into the three errors the Mailroom acts
 * on, and that it asks for nothing beyond reading. The response fixtures are
 * PLACEHOLDERS (see gmail-parse.test.ts), so what is proved here is that the
 * module reads the documented shape.
 */

interface Seen {
  method: string
  url: string
  headers: Headers
  body: string
}

/** Answers from a queue by order, recording every request. */
function fakeFetch(answers: (Response | Error)[]) {
  const seen: Seen[] = []
  const queue = [...answers]
  const fetch = async (url: string, init: RequestInit = {}) => {
    seen.push({
      method: init.method ?? 'GET',
      url,
      headers: new Headers(init.headers),
      body: init.body === undefined ? '' : String(init.body),
    })
    const next = queue.shift()
    if (!next) throw new Error(`unexpected request: ${init.method ?? 'GET'} ${url}`)
    if (next instanceof Error) throw next
    return next
  }
  return { fetch, seen }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const token = (extra: Record<string, unknown> = {}) => json({ access_token: 'access-1', expires_in: 3600, ...extra })

function google(answers: (Response | Error)[], now = () => 1_000_000) {
  const f = fakeFetch(answers)
  return {
    ...f,
    g: createGoogle({ fetch: f.fetch, clientId: 'cid', clientSecret: 'secret', now }),
  }
}

describe('the sign-in address', () => {
  test('asks for gmail.modify, offline, with consent, and carries the state; it hints no account unless it is given one to connect again', () => {
    const url = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: GMAIL_RETURN, state: 'abc' }))
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('redirect_uri')).toBe(GMAIL_RETURN)
    expect(url.searchParams.get('response_type')).toBe('code')
    // The mailboxes' Connect asks for mail's permissions and nothing else: no calendar scope is in it.
    expect(url.searchParams.get('scope')).toBe(`${GMAIL_SCOPE} openid email`)
    expect(url.searchParams.get('include_granted_scopes')).toBe('true')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('state')).toBe('abc')
    expect(url.searchParams.get('login_hint')).toBeNull()
    const again = new URL(
      buildAuthUrl({ clientId: 'cid', redirectUri: GMAIL_RETURN, state: 'abc', loginHint: 'tessa@ashgrove.example' }),
    )
    expect(again.searchParams.get('login_hint')).toBe('tessa@ashgrove.example')
  })

  test('the one Gmail permission is gmail.modify and nothing broader, and the mailboxes’ Connect never names a calendar scope; the calendar’s own Connect asks for the calendar’s reading and event permissions and nothing else', () => {
    expect(OAUTH_SCOPES).toEqual(['https://www.googleapis.com/auth/gmail.modify', 'openid', 'email'])
    expect(CALENDAR_OAUTH_SCOPES).toEqual([
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
    ])
    const calendar = new URL(
      buildAuthUrl({
        clientId: 'cid',
        redirectUri: GMAIL_RETURN,
        state: 'abc',
        purpose: 'calendar',
        loginHint: 'tessa@ashgrove.example',
      }),
    )
    expect(calendar.searchParams.get('scope')).toBe(`${CALENDAR_READONLY_SCOPE} ${CALENDAR_EVENTS_SCOPE}`)
    // Never the full calendar scope, and never mail's.
    expect(calendar.searchParams.get('scope')?.split(' ')).not.toContain('https://www.googleapis.com/auth/calendar')
    expect(calendar.searchParams.get('scope')).not.toContain('gmail')
    expect(calendar.searchParams.get('include_granted_scopes')).toBe('true')
    expect(calendar.searchParams.get('login_hint')).toBe('tessa@ashgrove.example')
    expect(calendar.searchParams.get('access_type')).toBe('offline')
    expect(calendar.searchParams.get('prompt')).toBe('consent')
  })
})

describe('exchanging the code', () => {
  test('posts the code with the client and the exact redirect, and reads the grant', async () => {
    const { g, seen } = google([
      token({
        refresh_token: 'refresh-1',
        scope: `${GMAIL_SCOPE} openid https://www.googleapis.com/auth/userinfo.email`,
      }),
    ])
    const granted = await g.exchangeCode('the-code', GMAIL_RETURN)
    expect(granted.refreshToken).toBe('refresh-1')
    expect(granted.scopes).toContain(GMAIL_SCOPE)
    expect(seen[0]?.url).toBe(TOKEN_URL)
    const form = new URLSearchParams(seen[0]?.body)
    expect(Object.fromEntries(form)).toEqual({
      client_id: 'cid',
      client_secret: 'secret',
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: GMAIL_RETURN,
    })
  })

  test('no refresh token in the answer is null, not an error', async () => {
    const { g } = google([token({ scope: GMAIL_SCOPE })])
    expect((await g.exchangeCode('c', GMAIL_RETURN)).refreshToken).toBeNull()
  })

  test('a used or bad code is an auth error; any other refusal is a plain one', async () => {
    const used = google([json({ error: 'invalid_grant', error_description: 'Bad Request' }, 400)])
    await expect(used.g.exchangeCode('c', GMAIL_RETURN)).rejects.toBeInstanceOf(GmailAuthError)
    const other = google([json({ error: 'invalid_client' }, 401)])
    await expect(other.g.exchangeCode('c', GMAIL_RETURN)).rejects.toBeInstanceOf(GmailError)
  })
})

describe('calling Gmail from a refresh token', () => {
  test('mints an access token once, keeps it, and sends it as a bearer', async () => {
    const { g, seen } = google([token(), json(profile), json(profile)])
    const gmail = g.gmail('refresh-1')
    expect(await gmail.getProfile()).toEqual({ emailAddress: 'tessa@northfield.example', historyId: '483011' })
    await gmail.getProfile()
    expect(seen.map((s) => s.url)).toEqual([TOKEN_URL, `${GMAIL_API}/profile`, `${GMAIL_API}/profile`])
    expect(new URLSearchParams(seen[0]?.body).get('grant_type')).toBe('refresh_token')
    expect(new URLSearchParams(seen[0]?.body).get('refresh_token')).toBe('refresh-1')
    expect(seen[1]?.headers.get('authorization')).toBe('Bearer access-1')
  })

  test('mints a new one after the old expires', async () => {
    let now = 0
    const f = fakeFetch([token(), json(profile), token({ access_token: 'access-2' }), json(profile)])
    const g = createGoogle({ fetch: f.fetch, clientId: 'c', clientSecret: 's', now: () => now })
    await g.gmail('r').getProfile()
    now = 3_600_000
    await g.gmail('r').getProfile()
    expect(f.seen[3]?.headers.get('authorization')).toBe('Bearer access-2')
  })

  test('a 401 is retried ONCE with a fresh token, and a second one is an auth error', async () => {
    const retried = google([
      token(),
      json({ error: { message: 'Invalid Credentials' } }, 401),
      token({ access_token: 'access-2' }),
      json(profile),
    ])
    expect((await retried.g.gmail('r').getProfile()).emailAddress).toBe('tessa@northfield.example')
    expect(retried.seen[3]?.headers.get('authorization')).toBe('Bearer access-2')

    const dead = google([
      token(),
      json({ error: { message: 'x' } }, 401),
      token(),
      json({ error: { message: 'x' } }, 401),
    ])
    await expect(dead.g.gmail('r').getProfile()).rejects.toBeInstanceOf(GmailAuthError)
  })

  test('a revoked grant on refresh is an auth error', async () => {
    const { g } = google([
      json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400),
    ])
    await expect(g.gmail('r').getProfile()).rejects.toBeInstanceOf(GmailAuthError)
  })

  test('a 500 or a rate limit is a plain error with Google’s own words, never the token', async () => {
    const { g } = google([token(), json({ error: { code: 429, message: 'Rate Limit Exceeded' } }, 429)])
    const error = await g
      .gmail('refresh-secret-value')
      .getProfile()
      .catch((e: Error) => e)
    expect(error).toBeInstanceOf(GmailError)
    expect((error as GmailError).status).toBe(429)
    expect((error as Error).message).toContain('Rate Limit Exceeded')
    expect((error as Error).message).not.toContain('refresh-secret-value')
  })
})

describe('an access token limited to one permission (the calendar’s)', () => {
  test('asks Google for that scope alone on the refresh, and keeps the token per scope, never lending one scope’s token to another', async () => {
    let clock = 1_000_000
    const { g, seen } = google(
      [
        token({ access_token: 'cal-1' }),
        token({ access_token: 'mail-1' }),
        json(profile),
        token({ access_token: 'cal-2' }),
      ],
      () => clock,
    )
    const first = await g.accessToken('refresh-1', CALENDAR_READONLY_SCOPE)
    expect(first).toEqual({ accessToken: 'cal-1', expiresAt: 1_000_000 + 3_600_000 })
    const form = Object.fromEntries(new URLSearchParams(seen[0]?.body))
    expect(form).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      scope: CALENDAR_READONLY_SCOPE,
    })
    // The same scope again is the cached token; mail's own call (no scope) is a different token and is asked for on its own.
    expect((await g.accessToken('refresh-1', CALENDAR_READONLY_SCOPE)).accessToken).toBe('cal-1')
    expect(seen.length).toBe(1)
    await g
      .gmail('refresh-1')
      .getProfile()
      .catch(() => undefined)
    expect(new URLSearchParams(seen[1]?.body).get('scope')).toBeNull()
    // A fresh one skips the cache.
    clock += 1000
    expect((await g.accessToken('refresh-1', CALENDAR_READONLY_SCOPE, true)).accessToken).toBe('cal-2')
  })

  test('whether Google honoured the narrowing is read from its answer and said once; a token that came back wider is a warning, and no line carries a token', async () => {
    expect(narrowingNote(CALENDAR_READONLY_SCOPE, CALENDAR_READONLY_SCOPE)).toMatchObject({ wider: false })
    expect(narrowingNote(CALENDAR_READONLY_SCOPE, `${CALENDAR_READONLY_SCOPE} ${GMAIL_SCOPE}`)).toMatchObject({
      wider: true,
    })
    expect(narrowingNote(CALENDAR_READONLY_SCOPE, undefined)).toBeNull()
    expect(narrowingNote(CALENDAR_READONLY_SCOPE, '')).toBeNull()
    const said: string[] = []
    const [log, warn] = [console.log, console.warn]
    console.log = (...a: unknown[]) => void said.push(`log ${a.join(' ')}`)
    console.warn = (...a: unknown[]) => void said.push(`warn ${a.join(' ')}`)
    try {
      const { g } = google([
        token({ access_token: 'secret-access', scope: CALENDAR_READONLY_SCOPE }),
        token({ access_token: 'secret-access-2', scope: CALENDAR_READONLY_SCOPE }),
        token({ access_token: 'secret-access-3', scope: `${CALENDAR_READONLY_SCOPE} ${GMAIL_SCOPE}` }),
      ])
      await g.accessToken('refresh-1', CALENDAR_READONLY_SCOPE)
      await g.accessToken('other-refresh', CALENDAR_READONLY_SCOPE)
      await g.accessToken('third-refresh', CALENDAR_READONLY_SCOPE)
    } finally {
      console.log = log
      console.warn = warn
    }
    expect(said.map((l) => l.split(' ')[0])).toEqual(['log', 'warn'])
    expect(said.join('\n')).not.toMatch(/secret-access|refresh-1|other-refresh|third-refresh/)
  })

  test('a grant Google ended is an auth error whose text is Google’s and never the refresh token', async () => {
    const { g } = google([
      json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400),
    ])
    const caught = await g.accessToken('refresh-secret-9', CALENDAR_READONLY_SCOPE).catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(GmailAuthError)
    expect(String((caught as Error).message)).not.toContain('refresh-secret-9')
  })
})

describe('what it asks Gmail', () => {
  test('lists with the query and page token, a page at a time, and reads the ids', async () => {
    const { g, seen } = google([token(), json(listMessages)])
    const page = await g.gmail('r').listMessageIds('(in:inbox OR in:sent) after:1760000000', 'tok')
    expect(page.ids).toEqual([
      { id: '19a1f2e6d0f1b623', threadId: '19a1f0c2b7d4e801' },
      { id: '19a1f1d4c9e0a512', threadId: '19a1f0c2b7d4e801' },
    ])
    expect(page.next).toBe('09876543210987654321')
    const url = new URL(seen[1]?.url ?? '')
    expect(url.pathname).toBe('/gmail/v1/users/me/messages')
    expect(url.searchParams.get('q')).toBe('(in:inbox OR in:sent) after:1760000000')
    expect(url.searchParams.get('maxResults')).toBe(String(PAGE_SIZE))
    expect(url.searchParams.get('pageToken')).toBe('tok')
    expect(url.searchParams.has('includeSpamTrash')).toBe(false)
  })

  test('an empty listing is no ids and no next page', async () => {
    const { g } = google([token(), json({ resultSizeEstimate: 0 })])
    expect(await g.gmail('r').listMessageIds('q', null)).toEqual({ ids: [], next: null })
  })

  test('gets a message in full, and a message that is gone is null', async () => {
    const { g, seen } = google([
      token(),
      json(plain),
      json({ error: { message: 'Requested entity was not found.' } }, 404),
    ])
    const gmail = g.gmail('r')
    expect((await gmail.getMessage('19a1f0c2b7d4e801'))?.id).toBe('19a1f0c2b7d4e801')
    expect(new URL(seen[1]?.url ?? '').searchParams.get('format')).toBe('full')
    expect(await gmail.getMessage('gone')).toBeNull()
  })

  // PLACEHOLDER, as every Gmail fixture is: shaped from Google's reference for messages.attachments.get ({ size, data }
  // with data base64url), not captured. The runbook lists capturing the real answer.
  test('gets one attachment with a GET to messages.attachments.get and decodes its base64url; one that is gone is null', async () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0xfb, 0xff]
    const data = Buffer.from(png).toString('base64url')
    const { g, seen } = google([
      token(),
      json({ size: png.length, data }),
      json({ error: { message: 'Invalid attachment token' } }, 404),
    ])
    const gmail = g.gmail('r')
    expect([...((await gmail.getAttachment('m 1', 'a/1')) ?? [])]).toEqual(png)
    expect(seen[1]).toMatchObject({
      method: 'GET',
      url: `${GMAIL_API}/messages/m%201/attachments/a%2F1`,
    })
    expect(seen[1]?.body).toBe('')
    expect(await gmail.getAttachment('m', 'gone')).toBeNull()
    // Reading a picture is two GETs and never a change.
    expect(seen.every((r) => r.method === 'GET' || r.url === TOKEN_URL)).toBe(true)
  })

  test('reads history from the cursor for added messages and label changes only', async () => {
    const { g, seen } = google([token(), json(historyPage)])
    const page = await g.gmail('r').listHistory('482913', null)
    expect(page.history).toHaveLength(4)
    expect(page.nextPageToken).toBe('17189355614123478021')
    expect(page.historyId).toBe('483011')
    const url = new URL(seen[1]?.url ?? '')
    expect(url.pathname).toBe('/gmail/v1/users/me/history')
    expect(url.searchParams.get('startHistoryId')).toBe('482913')
    expect(url.searchParams.getAll('historyTypes')).toEqual(['messageAdded', 'labelAdded', 'labelRemoved'])
  })

  test('a 404 on the history is the stale-cursor signal, and nothing else is', async () => {
    const stale = google([token(), json({ error: { code: 404, message: 'Requested entity was not found.' } }, 404)])
    await expect(stale.g.gmail('r').listHistory('1', null)).rejects.toBeInstanceOf(GmailHistoryGone)
    const other = google([token(), json({ error: { message: 'Backend Error' } }, 500)])
    const error = await other.g
      .gmail('r')
      .listHistory('1', null)
      .catch((e: Error) => e)
    expect(error).toBeInstanceOf(GmailError)
    expect(error).not.toBeInstanceOf(GmailHistoryGone)
  })

  test('reads a thread’s labels with the minimal format, and a thread that is gone is null', async () => {
    const { g, seen } = google([token(), json(threadMinimal), json({ error: { message: 'nf' } }, 404)])
    const gmail = g.gmail('r')
    expect(await gmail.getThreadLabels('19a1f0c2b7d4e801')).toEqual([
      { id: '19a1f0c2b7d4e801', labels: ['CATEGORY_PERSONAL', 'INBOX'] },
      { id: '19a1f2e6d0f1b623', labels: ['SENT'] },
    ])
    expect(new URL(seen[1]?.url ?? '').searchParams.get('format')).toBe('minimal')
    expect(await gmail.getThreadLabels('gone')).toBeNull()
  })

  test('watches everything: the topic and no label filter, and the expiry as ISO', async () => {
    const { g, seen } = google([token(), json(watch)])
    const result = await g.gmail('r').watch('projects/p/topics/t')
    expect(result).toEqual({ historyId: '483011', expiration: '2026-10-27T12:00:00.000Z' })
    expect(seen[1]?.method).toBe('POST')
    expect(seen[1]?.url).toBe(`${GMAIL_API}/watch`)
    expect(JSON.parse(seen[1]?.body ?? '')).toEqual({ topicName: 'projects/p/topics/t' })
  })

  test('a watch answer with no expiry is an error, not a silent never', async () => {
    const { g } = google([token(), json({ historyId: '1' })])
    await expect(g.gmail('r').watch('projects/p/topics/t')).rejects.toBeInstanceOf(GmailError)
  })

  test('stops the watch', async () => {
    const { g, seen } = google([token(), new Response(null, { status: 204 })])
    await g.gmail('r').stop()
    expect(seen[1]?.url).toBe(`${GMAIL_API}/stop`)
  })

  test('the three changes: read takes UNREAD off the thread, close takes INBOX off, reopen puts INBOX back', async () => {
    const { g, seen } = google([token(), json(threadMinimal), json(threadMinimal), json(threadMinimal), json({})])
    const gmail = g.gmail('r')
    await gmail.changeThread('thr-1', 'read')
    await gmail.changeThread('thr-1', 'close')
    expect(seen.slice(1).map((r) => [r.method, r.url, JSON.parse(r.body)])).toEqual([
      ['POST', `${GMAIL_API}/threads/thr-1/modify`, { removeLabelIds: ['UNREAD'] }],
      ['POST', `${GMAIL_API}/threads/thr-1/modify`, { removeLabelIds: ['INBOX'] }],
    ])
  })

  test('reopen reads the thread and puts INBOX on each message that is in play, one request each, never a batch', async () => {
    // thread-minimal: one message already in the Inbox, and one Tessa sent.
    const { g, seen } = google([token(), json(threadMinimal), json({})])
    await g.gmail('r').changeThread('thr-1', 'reopen')
    expect(seen.slice(1).map((r) => [r.method, r.url, r.body === '' ? null : JSON.parse(r.body)])).toEqual([
      ['GET', `${GMAIL_API}/threads/thr-1?format=minimal`, null],
      ['POST', `${GMAIL_API}/messages/19a1f2e6d0f1b623/modify`, { addLabelIds: ['INBOX'] }],
    ])
  })

  test('reopen leaves a message in the trash, spam or drafts out of the Inbox', async () => {
    const thread = {
      messages: [
        { id: 'in-trash', labelIds: ['TRASH'] },
        { id: 'in-spam', labelIds: ['SPAM', 'UNREAD'] },
        { id: 'a-draft', labelIds: ['DRAFT'] },
        { id: 'in-inbox', labelIds: ['INBOX'] },
        { id: 'archived', labelIds: [] },
      ],
    }
    const { g, seen } = google([token(), json(thread), json({})])
    await g.gmail('r').changeThread('thr-1', 'reopen')
    expect(seen.slice(2).map((r) => r.url)).toEqual([`${GMAIL_API}/messages/archived/modify`])
  })

  test('a reopen that stops part way says how far it got: partial after one message moved, plain if none did', async () => {
    const thread = {
      messages: [
        { id: 'm1', labelIds: [] },
        { id: 'm2', labelIds: [] },
        { id: 'm3', labelIds: [] },
      ],
    }
    const limited = json({ error: { message: 'Rate Limit Exceeded' } }, 429)

    const partway = google([token(), json(thread), json({}), limited])
    const error = await partway.g
      .gmail('r')
      .changeThread('t', 'reopen')
      .catch((e: Error) => e)
    expect(error).toBeInstanceOf(GmailPartialChange)
    expect(error).toMatchObject({ moved: 1, total: 3, status: 429 })
    expect((error as Error).message).toContain('Rate Limit Exceeded')

    const first = google([token(), json(thread), json({ error: { message: 'Rate Limit Exceeded' } }, 429)])
    const none = await first.g
      .gmail('r')
      .changeThread('t', 'reopen')
      .catch((e: Error) => e)
    expect(none).toBeInstanceOf(GmailError)
    expect(none).not.toBeInstanceOf(GmailPartialChange)

    const vanished = google([token(), json(thread), json({}), json({ error: { message: 'gone' } }, 404)])
    const gone = await vanished.g
      .gmail('r')
      .changeThread('t', 'reopen')
      .catch((e: Error) => e)
    expect(gone).toBeInstanceOf(GmailPartialChange)
  })

  test('an id is encoded into the path, never spliced into it', async () => {
    const closed = google([token(), json(threadMinimal)])
    await closed.g.gmail('r').changeThread('a/b?c=d', 'close')
    expect(closed.seen[1]?.url).toBe(`${GMAIL_API}/threads/a%2Fb%3Fc%3Dd/modify`)

    const reopened = google([token(), json({ messages: [{ id: 'm/1?x', labelIds: [] }] }), json({})])
    await reopened.g.gmail('r').changeThread('t', 'reopen')
    expect(reopened.seen[2]?.url).toBe(`${GMAIL_API}/messages/m%2F1%3Fx/modify`)
  })

  test('it is a name from the table or nothing: any other change is refused before a request is made', async () => {
    const { g, seen } = google([])
    for (const bad of ['trash', 'star', 'delete', 'send', '', '__proto__', 'toString']) {
      await expect(g.gmail('r').changeThread('thr-1', bad as never), bad).rejects.toBeInstanceOf(GmailError)
    }
    expect(seen).toEqual([])
  })

  test('a thread Gmail no longer has is a 404 error, and any other refusal carries Google’s words', async () => {
    const gone = google([token(), json({ error: { message: 'Requested entity was not found.' } }, 404)])
    const missing = await gone.g
      .gmail('r')
      .changeThread('thr-1', 'close')
      .catch((e: Error) => e)
    expect(missing).toBeInstanceOf(GmailError)
    expect((missing as GmailError).status).toBe(404)

    const goneToReopen = google([token(), json({ error: { message: 'Requested entity was not found.' } }, 404)])
    const reopen = await goneToReopen.g
      .gmail('r')
      .changeThread('thr-1', 'reopen')
      .catch((e: Error) => e)
    expect((reopen as GmailError).status).toBe(404)

    const refused = google([token(), json({ error: { message: 'Insufficient Permission' } }, 403)])
    const error = await refused.g
      .gmail('r')
      .changeThread('thr-1', 'read')
      .catch((e: Error) => e)
    expect(error).toBeInstanceOf(GmailError)
    expect((error as GmailError).status).toBe(403)
    expect((error as Error).message).toContain('Insufficient Permission')
  })

  test('a 401 on a change is retried once with a fresh token, like every other call', async () => {
    const { g, seen } = google([
      token(),
      json({ error: { message: 'Invalid Credentials' } }, 401),
      token({ access_token: 'access-2' }),
      json(threadMinimal),
    ])
    await g.gmail('r').changeThread('thr-1', 'read')
    expect(seen[3]?.headers.get('authorization')).toBe('Bearer access-2')
  })

  test('whatever the module is asked to do, the only thing it can write to Gmail is one of the three label changes', async () => {
    // Every method of the module, called for real against a fetch that records
    // what leaves it. A write is any request that is not a GET; the only writes
    // allowed are the watch and stop (the live connection), a modify whose body
    // is exactly one of THREAD_CHANGES, and, since step 4, the one send. Nothing
    // else: no trash, no delete, no batch change, no other label, no draft.
    const everything = [
      json(profile),
      json(listMessages),
      json(plain),
      json(historyPage),
      json(threadMinimal),
      json(watch),
      new Response(null, { status: 204 }),
      json(threadMinimal),
      json(threadMinimal),
      json(threadMinimal),
      json({}),
      json({ id: 'sent-1', threadId: 't', labelIds: ['SENT'] }),
    ]
    const { g, seen } = google([token(), ...everything])
    const gmail = g.gmail('r')
    await gmail.getProfile()
    await gmail.listMessageIds('q', null)
    await gmail.getMessage('m')
    await gmail.listHistory('1', null)
    await gmail.getThreadLabels('t')
    await gmail.watch('projects/p/topics/t')
    await gmail.stop()
    await gmail.changeThread('t', 'read')
    await gmail.changeThread('t', 'close')
    await gmail.changeThread('t', 'reopen')
    await gmail.sendMessage('cmF3', 't')

    const writes = seen.slice(1).filter((r) => r.method !== 'GET')
    expect(writes.map((r) => r.method)).toEqual(['POST', 'POST', 'POST', 'POST', 'POST', 'POST'])
    const allowed = Object.values(THREAD_CHANGES).map((c) => JSON.stringify(c))
    const modifies = writes.filter((r) => r.url.endsWith('/modify'))
    expect(modifies).toHaveLength(3)
    for (const r of modifies) expect(allowed).toContain(JSON.stringify(JSON.parse(r.body)))
    // The send is the only request whose address says so, and its body is a message and a thread: nothing else.
    const sends = seen.slice(1).filter((r) => /send/i.test(r.url))
    expect(sends.map((r) => r.url)).toEqual([`${GMAIL_API}/messages/send`])
    expect(JSON.parse(sends[0]?.body ?? '{}')).toEqual({ raw: 'cmF3', threadId: 't' })
    for (const r of seen.slice(1)) expect(r.url).not.toMatch(/trash|delete|batch|labels|drafts|settings/i)
  })

  test('the module has no way to trash, delete or draft anything, sends in one way, and changes labels only in the three ways above', () => {
    const gmail = createGoogle({ fetch: fetch, clientId: 'c', clientSecret: 's', now: () => 0 }).gmail('r')
    expect(Object.keys(gmail).sort()).toEqual([
      'changeThread',
      'getAttachment',
      'getMessage',
      'getProfile',
      'getThreadLabels',
      'listHistory',
      'listMessageIds',
      'sendMessage',
      'stop',
      'watch',
    ])
    expect(Object.keys(THREAD_CHANGES)).toEqual(['read', 'close', 'reopen'])
  })
})

describe('sending', () => {
  // PLACEHOLDER, as every Gmail fixture is: shaped from Google's reference for messages.send (an id, a
  // thread id and the labels), not captured. The runbook lists capturing the real answer.
  const made = { id: 'sent-1', threadId: 'thr-1', labelIds: ['SENT'] }
  const send = (g: ReturnType<typeof google>['g'], threadId: string | null = 'thr-1') =>
    g.gmail('r').sendMessage('cmF3bWVzc2FnZQ', threadId)

  test('posts the message and the thread to messages.send as a bearer and answers what Gmail made', async () => {
    const { g, seen } = google([token(), json(made)])
    expect(await send(g)).toEqual({ id: 'sent-1', threadId: 'thr-1', labels: ['SENT'] })
    expect(seen[1]).toMatchObject({ method: 'POST', url: `${GMAIL_API}/messages/send` })
    expect(seen[1]?.headers.get('authorization')).toBe('Bearer access-1')
    expect(JSON.parse(seen[1]?.body ?? '')).toEqual({ raw: 'cmF3bWVzc2FnZQ', threadId: 'thr-1' })
  })

  test('a new email carries no thread id', async () => {
    const { g, seen } = google([token(), json(made)])
    await send(g, null)
    expect(JSON.parse(seen[1]?.body ?? '')).toEqual({ raw: 'cmF3bWVzc2FnZQ' })
  })

  test('a refusal (any 4xx) is a GmailError that says nothing went out, with Gmail’s own words', async () => {
    for (const status of [400, 403, 404, 429]) {
      const { g, seen } = google([token(), json({ error: { message: `Reason ${status}` } }, status)])
      const error = await send(g).catch((e: unknown) => e)
      expect(error, String(status)).toBeInstanceOf(GmailError)
      expect(error).not.toBeInstanceOf(GmailSendUnknown)
      expect((error as GmailError).status).toBe(status)
      expect((error as GmailError).message).toContain(`Reason ${status}`)
      expect(seen.filter((r) => r.url.endsWith('/messages/send'))).toHaveLength(1)
    }
  })

  test('a 401 is retried ONCE with a new token (nothing was processed), and a second 401 is an auth error', async () => {
    const ok = google([
      token(),
      json({ error: { message: 'Invalid Credentials' } }, 401),
      token({ access_token: 'access-2' }),
      json(made),
    ])
    expect(await send(ok.g)).toMatchObject({ id: 'sent-1' })
    expect(ok.seen[3]?.headers.get('authorization')).toBe('Bearer access-2')
    expect(ok.seen.filter((r) => r.url.endsWith('/messages/send'))).toHaveLength(2)

    const twice = google([
      token(),
      json({ error: { message: 'Invalid Credentials' } }, 401),
      token({ access_token: 'access-2' }),
      json({ error: { message: 'Invalid Credentials' } }, 401),
    ])
    await expect(send(twice.g)).rejects.toBeInstanceOf(GmailAuthError)
    expect(twice.seen.filter((r) => r.url.endsWith('/messages/send'))).toHaveLength(2)
  })

  test('a 5xx may have been acted on, so it is GmailSendUnknown (not a refusal) and is NEVER retried', async () => {
    for (const status of [500, 502, 503]) {
      const { g, seen } = google([token(), json({ error: { message: 'Backend Error' } }, status)])
      const error = await send(g).catch((e: unknown) => e)
      expect(error, String(status)).toBeInstanceOf(GmailSendUnknown)
      expect(error).not.toBeInstanceOf(GmailError)
      expect(seen.filter((r) => r.url.endsWith('/messages/send'))).toHaveLength(1)
    }
  })

  test('a connection that fails once the request is on its way is GmailSendUnknown, and is never retried', async () => {
    const { g, seen } = google([token(), new Error('socket closed')])
    const error = await send(g).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GmailSendUnknown)
    expect((error as Error).message).toContain('socket closed')
    expect(seen.filter((r) => r.url.endsWith('/messages/send'))).toHaveLength(1)
  })

  test('an answer that does not say which message it made is unknown, even when it is a 200', async () => {
    for (const answer of [json({}), new Response('not json', { status: 200 }), json({ threadId: 'thr-1' })]) {
      const { g } = google([token(), answer])
      await expect(send(g)).rejects.toBeInstanceOf(GmailSendUnknown)
    }
  })

  test('a token that cannot be had means nothing was asked of Gmail: a refusal, never unknown', async () => {
    const revoked = google([json({ error: 'invalid_grant' }, 400)])
    await expect(send(revoked.g)).rejects.toBeInstanceOf(GmailAuthError)
    expect(revoked.seen).toHaveLength(1)

    const down = google([new Error('dns failure')])
    const error = await send(down.g).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GmailError)
    expect(error).not.toBeInstanceOf(GmailSendUnknown)
    expect(down.seen.every((r) => !r.url.endsWith('/messages/send'))).toBe(true)
  })
})

describe('revoking', () => {
  test('posts the token to Google and says whether Google confirmed', async () => {
    const ok = google([new Response('{}', { status: 200 })])
    expect(await ok.g.revoke('refresh-1')).toBe(true)
    expect(ok.seen[0]?.url).toBe(REVOKE_URL)
    expect(new URLSearchParams(ok.seen[0]?.body).get('token')).toBe('refresh-1')
    expect(await google([json({ error: 'invalid_token' }, 400)]).g.revoke('x')).toBe(false)
    expect(await google([new Error('network down')]).g.revoke('x')).toBe(false)
  })
})

describe('the push settings and what a push says', () => {
  test('both settings and an https URL with a path, or nothing at all', () => {
    const good = {
      GMAIL_PUSH_ENDPOINT: 'https://inbox-push.northfield.example/api/gmail/push',
      GMAIL_PUSH_SERVICE_ACCOUNT: 'Push@Proj.iam.gserviceaccount.com',
    }
    expect(pushSettings(good)).toEqual({
      ok: true,
      host: 'inbox-push.northfield.example',
      path: '/api/gmail/push',
      audience: 'https://inbox-push.northfield.example/api/gmail/push',
      account: 'push@proj.iam.gserviceaccount.com',
    })
    for (const bad of [
      {},
      { GMAIL_PUSH_ENDPOINT: good.GMAIL_PUSH_ENDPOINT },
      { GMAIL_PUSH_SERVICE_ACCOUNT: good.GMAIL_PUSH_SERVICE_ACCOUNT },
      { ...good, GMAIL_PUSH_ENDPOINT: 'http://inbox-push.northfield.example/api/gmail/push' },
      { ...good, GMAIL_PUSH_ENDPOINT: 'https://inbox-push.northfield.example/' },
      { ...good, GMAIL_PUSH_ENDPOINT: 'https://inbox-push.northfield.example/p?x=1' },
      { ...good, GMAIL_PUSH_ENDPOINT: 'not a url' },
    ]) {
      expect(pushSettings(bad)).toEqual({ ok: false })
    }
  })

  test('reads the mailbox out of the placeholder push, and nothing from anything malformed', () => {
    expect(pushedAddress(pubsubPush)).toBe('tessa@northfield.example')
    expect(pushedAddress(null)).toBeNull()
    expect(pushedAddress({})).toBeNull()
    expect(pushedAddress({ message: { data: '!!!not base64!!!' } })).toBeNull()
    expect(pushedAddress({ message: { data: btoa('not json') } })).toBeNull()
    expect(pushedAddress({ message: { data: btoa('{"emailAddress": 7}') } })).toBeNull()
  })
})
