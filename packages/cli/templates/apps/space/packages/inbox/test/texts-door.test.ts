import { describe, expect, test } from 'bun:test'
import {
  AGENT,
  AGENT_AUD,
  BRIDGE,
  harness,
  OWNER,
  STRANGER,
  TELEGRAM_AUD,
  TEXTS_AUD,
  TEXTS_BRIDGE,
} from '../test-support/harness'
import { account, message, person, push } from '../test-support/texts'

/**
 * The texts bridge's door (packages/workspace/docs/adr/0002, amended): the inbox's router for the bridge's token, which the SPACE verified once for the request (packages/space/test/texts.test.ts proves that check) and
 * handed over in-process. Driven through the real router behind the harness's copy of that one check. What is proved here is what the inbox adds: who the token becomes, the five calls it may make and no others, the refusal
 * of Claude's token and the Telegram bridge's on this door and of this token on theirs, and what a malformed call is told.
 */

const CALLS = ['/api/push', '/api/events', '/api/work', '/api/outcomes', '/api/status']
const bodyFor = (path: string): unknown =>
  path === '/api/push'
    ? push([person()], [])
    : path === '/api/events'
      ? { account, edits: [], deletions: [] }
      : path === '/api/work'
        ? { account }
        : path === '/api/outcomes'
          ? { account, outcomes: [] }
          : { account, state: 'live' }

describe('who gets through the texts door', () => {
  test('the texts bridge’s token, for the texts application’s audience, makes each of its five calls', async () => {
    const h = harness()
    for (const path of CALLS) {
      const res = await h.texts(TEXTS_BRIDGE, path, bodyFor(path))
      expect([path, res.status]).toEqual([path, 200])
    }
  })

  test('Claude’s token and the Telegram bridge’s are refused on this door, and this token is refused on theirs', async () => {
    const h = harness()
    for (const path of CALLS) {
      expect((await h.texts(AGENT, path, bodyFor(path))).status, path).toBe(403)
      expect((await h.texts(BRIDGE, path, bodyFor(path))).status, path).toBe(403)
    }
    // This token on Claude's door and on the Telegram bridge's: not Claude's by its id, not the Telegram bridge's by its id.
    expect((await h.request(TEXTS_BRIDGE, 'GET', '/api/queue')).status).toBe(403)
    expect((await h.request(TEXTS_BRIDGE, 'GET', '/api/texts')).status).toBe(403)
    expect((await h.request(TEXTS_BRIDGE, 'POST', '/api/drafts', { body: 'x' })).status).toBe(403)
    expect((await h.bridge(TEXTS_BRIDGE, '/api/work', { account: { id: '7000000001' } })).status).toBe(403)
    // Nothing the refused calls carried was stored.
    expect(h.db.query('SELECT count(*) AS n FROM mailbox').get()).toEqual({ n: 0 })
  })

  test('a person is refused, the owner included, and so is another token', async () => {
    const h = harness()
    for (const who of [OWNER, STRANGER, { common_name: 'some-other-token.access' }]) {
      expect((await h.texts(who, '/api/push', push([person()], []))).status, JSON.stringify(who)).toBe(403)
    }
  })

  test('no assertion, and an assertion for another application’s audience, are a 401', async () => {
    const h = harness()
    expect((await h.texts(null, '/api/push', push([person()], []))).status).toBe(401)
    expect((await h.texts(TEXTS_BRIDGE, '/api/push', push([person()], []), { audience: AGENT_AUD })).status).toBe(401)
    expect((await h.texts(TEXTS_BRIDGE, '/api/push', push([person()], []), { audience: TELEGRAM_AUD })).status).toBe(
      401,
    )
    expect((await h.texts(TEXTS_BRIDGE, '/api/push', push([person()], []), { audience: 'f'.repeat(64) })).status).toBe(
      401,
    )
    expect((await h.texts(TEXTS_BRIDGE, '/api/push', push([person()], []), { audience: TEXTS_AUD })).status).toBe(200)
  })

  test('the token is the bridge’s by its id: with no client id deployed, nobody is the bridge', async () => {
    const h = harness()
    h.env.TEXTS_ACCESS_CLIENT_ID = undefined
    expect((await h.texts(TEXTS_BRIDGE, '/api/work', { account })).status).toBe(403)
  })

  test('the 401 and the 403 name no address to sign in at', async () => {
    const h = harness()
    expect((await h.texts(null, '/api/work', { account })).json).toEqual({ error: 'Present the service token.' })
    expect((await h.texts(AGENT, '/api/work', { account })).text).not.toContain('northfield.example')
  })
})

describe('what the texts door serves', () => {
  test('its five calls, by POST, and nothing else: no read of mail, nothing of Claude’s, no file, no encoded spelling of a path', async () => {
    const h = harness()
    for (const path of [
      '/',
      '/api/queue',
      '/api/texts',
      '/api/conversations/x',
      '/api/drafts',
      '/api/push/',
      '/api/media',
      '/api/picture',
      '/apix',
      '/api',
      '/%61pi/push',
      '/api/pushx',
      '/assets/index.js',
    ]) {
      expect((await h.texts(TEXTS_BRIDGE, path, {})).status, path).toBe(404)
    }
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      expect((await h.texts(TEXTS_BRIDGE, '/api/push', undefined, { method })).status, method).toBe(404)
    }
  })

  test('a write from a page on another site is refused', async () => {
    const h = harness()
    const res = await h.texts(TEXTS_BRIDGE, '/api/work', { account }, { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(res.status).toBe(403)
    const origin = await h.texts(
      TEXTS_BRIDGE,
      '/api/work',
      { account },
      { headers: { origin: 'https://evil.example' } },
    )
    expect(origin.status).toBe(403)
  })

  test('every answer is kept by nothing and cannot be framed', async () => {
    const h = harness()
    for (const res of [
      await h.texts(TEXTS_BRIDGE, '/api/work', { account }),
      await h.texts(null, '/api/work', { account }),
      await h.texts(TEXTS_BRIDGE, '/nope', {}),
    ]) {
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('x-frame-options')).toBe('DENY')
    }
  })
})

describe('what a malformed call is told', () => {
  test('a body that is not a JSON object is a 400 or 422 and stores nothing', async () => {
    const h = harness()
    expect((await h.texts(TEXTS_BRIDGE, '/api/push', undefined, { raw: 'not json' })).status).toBe(400)
    expect((await h.texts(TEXTS_BRIDGE, '/api/push', undefined, { raw: '[]' })).status).toBe(422)
    expect((await h.texts(TEXTS_BRIDGE, '/api/push', {})).status).toBe(422)
    expect(h.db.query('SELECT count(*) AS n FROM mailbox').get()).toEqual({ n: 0 })
  })

  test('a bad chat kind, a bad id, a bad time and a text over the bound are each a 422 that names the field', async () => {
    const h = harness()
    const robot = { ...person(), kind: 'robot' }
    expect((await h.texts(TEXTS_BRIDGE, '/api/push', push([robot as never], []))).json.error).toContain('chats[0].kind')
    const badId = { ...person(), id: '12; DROP TABLE message' }
    expect((await h.texts(TEXTS_BRIDGE, '/api/push', push([badId as never], []))).json.error).toContain('chats[0].id')
    const badNumber = { ...person(), address: '555-0123' }
    expect((await h.texts(TEXTS_BRIDGE, '/api/push', push([badNumber], []))).json.error).toContain('chats[0].address')
    const badTime = push([person()], [{ ...message({ id: 'm1' }), at: 'yesterday' }])
    expect((await h.texts(TEXTS_BRIDGE, '/api/push', badTime)).json.error).toContain('messages[0].at')
    const long = push([person()], [message({ id: 'm1', text: 'x'.repeat(20_001) })])
    expect((await h.texts(TEXTS_BRIDGE, '/api/push', long)).json.error).toContain('messages[0].text')
    expect(h.db.query('SELECT count(*) AS n FROM mailbox').get()).toEqual({ n: 0 })
  })

  test('more than the bound of messages in one push is refused, so one request is never the whole store', async () => {
    const h = harness()
    const many = Array.from({ length: 501 }, (_, i) => message({ id: `m${i}` }))
    expect((await h.texts(TEXTS_BRIDGE, '/api/push', push([person()], many))).status).toBe(422)
  })

  test('the account must be an id of the bridge’s kind, a status one of the five, and a fill outcome the only outcome', async () => {
    const h = harness()
    expect((await h.texts(TEXTS_BRIDGE, '/api/work', { account: { id: 'a:b' } })).status).toBe(422)
    expect((await h.texts(TEXTS_BRIDGE, '/api/status', { account, state: 'asleep' })).status).toBe(422)
    expect(
      (await h.texts(TEXTS_BRIDGE, '/api/status', { account, state: 'signed-out', reason: 'x'.repeat(200) })).status,
    ).toBe(422)
    expect(
      (await h.texts(TEXTS_BRIDGE, '/api/status', { account, state: 'signed-out', reason: 'AUTH_REVOKED' })).status,
    ).toBe(200)
    expect(
      (await h.texts(TEXTS_BRIDGE, '/api/outcomes', { account, outcomes: [{ kind: 'send', chatId: 'c-1', ok: true }] }))
        .status,
    ).toBe(422)
  })

  test('a sign-in code or a bank alert is stored like any other text: nothing is kept out for its kind', async () => {
    const h = harness()
    const res = await h.texts(
      TEXTS_BRIDGE,
      '/api/push',
      push(
        [person(), { id: 'c-5501', kind: 'short-code', name: '55501', address: '55501' }],
        [
          message({ id: 'm1', chatId: 'c-5501', text: 'Your login code: 123456. Do not share it.' }),
          message({ id: 'm2', text: 'hello' }),
        ],
      ),
    )
    expect(res.json).toMatchObject({ stored: 2, skipped: 0 })
    expect(h.db.query(`SELECT count(*) AS n FROM message WHERE body LIKE '%login code%'`).get()).toEqual({ n: 1 })
  })
})
