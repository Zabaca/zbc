import { describe, expect, test } from 'bun:test'
import { TELEGRAM_SERVICE_CHAT } from '../src/telegram/wire'
import { AGENT, AGENT_AUD, BRIDGE, harness, OWNER, STRANGER, TELEGRAM_AUD } from '../test-support/harness'
import { account, chat, push } from '../test-support/telegram'

/**
 * The Telegram bridge's door (packages/workspace/docs/adr/0002, amended): the inbox's router for the bridge's token, which the SPACE verified once for the request (packages/space/test/telegram.test.ts
 * proves that check) and handed over in-process. Driven through the real router behind the harness's copy of that one check. What is proved here is what the inbox adds: who the token becomes, the six calls it
 * may make and no others, the refusal of Claude's token on this door and of the bridge's on Claude's, and what a malformed call is told.
 */

const CALLS = ['/api/push', '/api/events', '/api/work', '/api/outcomes', '/api/status']
const bodyFor = (path: string): unknown =>
  path === '/api/push'
    ? push([chat()], [])
    : path === '/api/events'
      ? { account, edits: [], deletions: [] }
      : path === '/api/work'
        ? { account }
        : path === '/api/outcomes'
          ? { account, outcomes: [] }
          : { account, state: 'live' }

describe('who gets through the bridge’s door', () => {
  test('the bridge’s token, for the bridge application’s audience, makes each of its six calls (five of JSON, and the file call, tested in telegram-media.test.ts)', async () => {
    const h = harness()
    for (const path of CALLS) {
      const res = await h.bridge(BRIDGE, path, bodyFor(path))
      expect([path, res.status]).toEqual([path, 200])
    }
  })

  test('Claude’s token is refused on the bridge’s door, and the bridge’s token is refused on Claude’s', async () => {
    const h = harness()
    for (const path of CALLS) expect((await h.bridge(AGENT, path, bodyFor(path))).status, path).toBe(403)
    expect((await h.request(BRIDGE, 'GET', '/api/queue')).status).toBe(403)
    expect((await h.request(BRIDGE, 'GET', '/api/telegram')).status).toBe(403)
    expect((await h.request(BRIDGE, 'POST', '/api/drafts', { body: 'x' })).status).toBe(403)
    // Nothing the refused calls carried was stored.
    expect(h.db.query('SELECT count(*) AS n FROM mailbox').get()).toEqual({ n: 0 })
  })

  test('a person is refused, the owner included, and so is another token', async () => {
    const h = harness()
    for (const who of [OWNER, STRANGER, { common_name: 'some-other-token.access' }]) {
      expect((await h.bridge(who, '/api/push', push([chat()], []))).status, JSON.stringify(who)).toBe(403)
    }
  })

  test('no assertion, and an assertion for another application’s audience, are a 401', async () => {
    const h = harness()
    expect((await h.bridge(null, '/api/push', push([chat()], []))).status).toBe(401)
    expect((await h.bridge(BRIDGE, '/api/push', push([chat()], []), { audience: AGENT_AUD })).status).toBe(401)
    expect((await h.bridge(BRIDGE, '/api/push', push([chat()], []), { audience: 'f'.repeat(64) })).status).toBe(401)
    expect((await h.bridge(BRIDGE, '/api/push', push([chat()], []), { audience: TELEGRAM_AUD })).status).toBe(200)
  })

  test('the token is the bridge’s by its id: with no client id deployed, nobody is the bridge', async () => {
    const h = harness()
    h.env.TELEGRAM_ACCESS_CLIENT_ID = undefined
    expect((await h.bridge(BRIDGE, '/api/work', { account })).status).toBe(403)
  })

  test('the 401 and the 403 name no address to sign in at', async () => {
    const h = harness()
    expect((await h.bridge(null, '/api/work', { account })).json).toEqual({ error: 'Present the service token.' })
    expect((await h.bridge(AGENT, '/api/work', { account })).text).not.toContain('northfield.example')
  })
})

describe('what the bridge’s door serves', () => {
  test('its six calls, by POST, and nothing else: no read of mail, nothing of Claude’s, no encoded spelling of a path', async () => {
    const h = harness()
    for (const path of [
      '/',
      '/api/queue',
      '/api/telegram',
      '/api/conversations/x',
      '/api/drafts',
      '/api/push/',
      '/apix',
      '/api',
      '/%61pi/push',
      '/api/pushx',
      '/assets/index.js',
    ]) {
      expect((await h.bridge(BRIDGE, path, {})).status, path).toBe(404)
    }
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      expect((await h.bridge(BRIDGE, '/api/push', undefined, { method })).status, method).toBe(404)
    }
  })

  test('a write from a page on another site is refused', async () => {
    const h = harness()
    const res = await h.bridge(BRIDGE, '/api/work', { account }, { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(res.status).toBe(403)
    const origin = await h.bridge(BRIDGE, '/api/work', { account }, { headers: { origin: 'https://evil.example' } })
    expect(origin.status).toBe(403)
  })

  test('every answer is kept by nothing and cannot be framed', async () => {
    const h = harness()
    for (const res of [
      await h.bridge(BRIDGE, '/api/work', { account }),
      await h.bridge(null, '/api/work', { account }),
      await h.bridge(BRIDGE, '/nope', {}),
    ]) {
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('x-frame-options')).toBe('DENY')
    }
  })
})

describe('what a malformed call is told', () => {
  test('a body that is not a JSON object is a 400 or 422 and stores nothing', async () => {
    const h = harness()
    expect((await h.bridge(BRIDGE, '/api/push', undefined, { raw: 'not json' })).status).toBe(400)
    expect((await h.bridge(BRIDGE, '/api/push', undefined, { raw: '[]' })).status).toBe(422)
    expect((await h.bridge(BRIDGE, '/api/push', {})).status).toBe(422)
    expect(h.db.query('SELECT count(*) AS n FROM mailbox').get()).toEqual({ n: 0 })
  })

  test('a chat that is not one-to-one, a bad id, a bad time and a text over the bound are each a 422 that names the field', async () => {
    const h = harness()
    const group = { ...chat(), kind: 'supergroup' }
    expect((await h.bridge(BRIDGE, '/api/push', push([group as never], []))).json.error).toContain('chats[0].kind')
    const noId = { ...chat(), id: '12; DROP TABLE message' }
    expect((await h.bridge(BRIDGE, '/api/push', push([noId as never], []))).json.error).toContain('chats[0].id')
    const badTime = push([chat()], [{ chatId: '2001', id: 1, at: 'yesterday', out: false, text: 'x' }])
    expect((await h.bridge(BRIDGE, '/api/push', badTime)).json.error).toContain('messages[0].at')
    const long = push(
      [chat()],
      [{ chatId: '2001', id: 1, at: '2026-11-05T10:00:00Z', out: false, text: 'x'.repeat(20_001) }],
    )
    expect((await h.bridge(BRIDGE, '/api/push', long)).json.error).toContain('messages[0].text')
    const disagree = { ...chat(), kind: 'bot' }
    expect((await h.bridge(BRIDGE, '/api/push', push([disagree as never], []))).json.error).toContain('chats[0].kind')
    expect(h.db.query('SELECT count(*) AS n FROM mailbox').get()).toEqual({ n: 0 })
  })

  test('more than the bound of messages in one push is refused, so one request is never the whole store', async () => {
    const h = harness()
    const many = Array.from({ length: 501 }, (_, i) => ({
      chatId: '2001',
      id: i + 1,
      at: '2026-11-05T10:00:00Z',
      out: false,
      text: 'x',
    }))
    expect((await h.bridge(BRIDGE, '/api/push', push([chat()], many))).status).toBe(422)
  })

  test('the account must be a Telegram user id, and a status must be one of the three', async () => {
    const h = harness()
    expect((await h.bridge(BRIDGE, '/api/work', { account: { id: 'tessa' } })).status).toBe(422)
    expect((await h.bridge(BRIDGE, '/api/status', { account, state: 'asleep' })).status).toBe(422)
    expect(
      (await h.bridge(BRIDGE, '/api/status', { account, state: 'signed-out', reason: 'x'.repeat(200) })).status,
    ).toBe(422)
    expect(
      (await h.bridge(BRIDGE, '/api/status', { account, state: 'signed-out', reason: 'AUTH_KEY_UNREGISTERED' })).status,
    ).toBe(200)
  })

  test('Telegram’s own service chat is never stored, even when the bridge sends it', async () => {
    const h = harness()
    const service = chat({ id: TELEGRAM_SERVICE_CHAT, name: 'Telegram' })
    const res = await h.bridge(
      BRIDGE,
      '/api/push',
      push(
        [service, chat()],
        [
          {
            chatId: TELEGRAM_SERVICE_CHAT,
            id: 1,
            at: '2026-11-05T10:00:00Z',
            out: false,
            text: 'Login code: 12345. Do not give this code to anyone.',
          },
          { chatId: '2001', id: 2, at: '2026-11-05T10:01:00Z', out: false, text: 'hello' },
        ],
      ),
    )
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ stored: 1, repeated: 0, skipped: 2 })
    expect(h.db.query(`SELECT count(*) AS n FROM message WHERE body LIKE '%Login code%'`).get()).toEqual({ n: 0 })
    expect(h.db.query(`SELECT count(*) AS n FROM identity WHERE address = '777000'`).get()).toEqual({ n: 0 })
    expect(h.db.query(`SELECT count(*) AS n FROM conversation WHERE telegram_chat_id = '777000'`).get()).toEqual({
      n: 0,
    })
  })
})
