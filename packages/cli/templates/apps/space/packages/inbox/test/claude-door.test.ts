import { describe, expect, test } from 'bun:test'
import { AGENT, AGENT_AUD, AGENT_ID, harness, mint, mintPush, OWNER, STRANGER } from '../test-support/harness'

/**
 * Claude's door (docs/adr/0002 of the company layer): the inbox's own API, answering only Claude's service token, which the SPACE verified once for the request (packages/space/test/agent.test.ts
 * proves the check) and handed to this router in-process (`InboxPart.claude`, src/space-part.ts; test/space-part.test.ts). Driven through the real router behind the harness's copy of the space's one
 * check (test-support/harness.ts); what is proved here is what the inbox adds: who the token becomes, what is served, its wording and the cross-site write check.
 */

const _OTHER = 'b'.repeat(64)

/** A cheap read that exists on the door: any route answers the gate the same way. */
const PROBE = '/api/mailbox'

describe('who gets through Claude’s door', () => {
  test('Claude’s token, for the agent application’s audience, is the agent: what it writes is audited as the token', async () => {
    const h = harness()
    const res = await h.request(AGENT, 'GET', PROBE)
    expect(res.status).toBe(200)
    await h.request(AGENT, 'POST', '/api/drafts', {
      address: 'dana@example.com',
      subject: 'Hello',
      body: 'Hi Dana',
      why: 'She asked.',
    })
    const audit = (await h.request(AGENT, 'GET', '/api/audit')).json as { actor: string }[]
    expect(audit.map((a) => a.actor)).toContain(`agent:${AGENT_ID}`)
  })

  test('a person is refused, the owner included, even with an assertion for that audience', async () => {
    const h = harness()
    for (const who of [OWNER, STRANGER]) {
      expect((await h.request(who, 'GET', PROBE)).status, JSON.stringify(who)).toBe(403)
    }
    expect((await h.request(OWNER, 'GET', '/api/queue')).status).toBe(403)
  })

  test('another token is refused', async () => {
    const h = harness()
    expect((await h.request({ common_name: 'some-other-token.access' }, 'GET', PROBE)).status).toBe(403)
  })

  test('the 401 tells Claude to present its token, and names no address to sign in at', async () => {
    const h = harness()
    const res = await h.request(null, 'GET', PROBE)
    expect(res.json).toEqual({ error: 'Present the service token.' })
    expect(res.text).not.toContain('inbox.northfield.example')
  })

  test('the cookie is never read: a genuine assertion in CF_Authorization, with no header, is refused, and a cookie beside the header changes nothing', async () => {
    const h = harness()
    const jwt = await mint(AGENT, { audience: AGENT_AUD })
    expect((await h.request(null, 'GET', PROBE, undefined, { cookie: `CF_Authorization=${jwt}` })).status).toBe(401)
    const beside = await h.request(AGENT, 'GET', PROBE, undefined, {
      cookie: `CF_Authorization=${await mint(STRANGER)}`,
    })
    expect(beside.status).toBe(200)
  })

  test('the token is Claude’s by its id: with no client id deployed, nobody is the agent', async () => {
    const h = harness()
    h.env.INBOX_ACCESS_CLIENT_ID = undefined
    expect((await h.request(AGENT, 'GET', PROBE)).status).toBe(403)
  })
})

describe('what Claude’s door serves', () => {
  test('the API, and nothing else: no page, no file, no encoded spelling of a path', async () => {
    const h = harness()
    for (const path of [
      '/',
      '/drafts',
      '/assets/index.js',
      '/sw.js',
      '/manifest.webmanifest',
      '/%61pi/queue',
      '/apix',
      '/api',
    ]) {
      expect((await h.request(AGENT, 'GET', path)).status, path).toBe(404)
    }
  })

  test('it is the inbox’s API for the script: every read the script makes answers', async () => {
    const h = harness()
    h.tick()
    await h.request(AGENT, 'POST', '/api/drafts', {
      address: 'dana@example.com',
      subject: 'Hello',
      body: 'Hi Dana',
      why: 'She asked.',
    })
    for (const path of [
      '/api/queue',
      '/api/drafts',
      '/api/contacts',
      '/api/mailboxes',
      '/api/audit',
      '/api/settings/claude-sending',
    ]) {
      expect((await h.request(AGENT, 'GET', path)).status, path).toBe(200)
    }
  })

  test('what only Tessa did is not here at all: the Gmail connection, notifications, restore, the chat, the page’s own reads', async () => {
    const h = harness()
    for (const [method, path] of [
      ['GET', '/api/me'],
      ['GET', '/api/gmail/connect'],
      ['GET', '/api/gmail/callback'],
      ['POST', '/api/gmail/disconnect'],
      ['GET', '/api/notifications'],
      ['POST', '/api/notifications/devices'],
      ['POST', '/api/restore/prepare'],
      ['POST', '/api/restore/confirm'],
      ['PUT', '/api/settings/claude-sending'],
      ['PUT', '/api/mailboxes/x/assistant'],
      ['POST', '/api/conversations/c-1/chat'],
      ['POST', '/api/conversations/c-1/read'],
      ['POST', '/api/messages/m-1/resolve-send'],
      ['GET', '/api/messages/m-1/attachments/0'],
    ] as const) {
      expect(
        (await h.request(AGENT, method, path, method === 'GET' ? undefined : {})).status,
        `${method} ${path}`,
      ).toBe(404)
    }
  })

  test('a write from a page on another site is refused, a same-site one is not', async () => {
    const h = harness()
    const body = { address: 'dana@example.com', body: 'Hi', subject: 's', why: 'x' }
    expect((await h.request(AGENT, 'POST', '/api/drafts', body, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await h.request(AGENT, 'POST', '/api/drafts', body, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect(
      (await h.request(AGENT, 'POST', '/api/drafts', body, { origin: 'https://space.northfield.example' })).status,
    ).toBe(201)
    expect((await h.request(AGENT, 'POST', '/api/drafts', body)).status).toBe(201)
  })

  test('every answer is framed by nothing and kept by no browser, refusals included', async () => {
    const h = harness()
    for (const res of [
      await h.request(AGENT, 'GET', PROBE),
      await h.request(null, 'GET', PROBE),
      await h.request(OWNER, 'GET', PROBE),
      await h.request(AGENT, 'GET', '/'),
    ]) {
      expect(res.headers.get('x-frame-options')).toBe('DENY')
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
  })

  test('the push hostname is not answered here: Google’s push to this router is a refusal, never a filed message', async () => {
    const h = harness()
    const res = await h.app.request(
      'https://inbox-push.northfield.example/api/gmail/push',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await mintPush()}` },
        body: '{}',
      },
      h.env,
    )
    expect(res.status).toBe(401)
  })
})
