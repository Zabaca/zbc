import { describe, expect, test } from 'bun:test'
import { createApp } from '../src/app'
import { createInboxPartFactory, type InboxPartEnv } from '../src/space-part'
import { AGENT, AGENT_ID, asker, harness, OWNER, STRANGER, TELEGRAM_ID } from '../test-support/harness'

/**
 * The inbox's part as the space's Worker holds it (src/space-part.ts), driven the way the Worker drives it: made once
 * from its environment, called in-process with the person the space's one check named, and handed Claude's door's requests with the service token that check verified. What these cannot show is
 * the runtime: that the namespace is a real binding to a class another Worker owns, and the DO's own env after the transfer. Those are the sitting's checks.
 */

/** A namespace over the harness's store: what `env.INBOX` is in a Worker. */
function namespaceOver(h: ReturnType<typeof harness>): InboxPartEnv['INBOX'] {
  const stub = {
    call: (method: string, args: unknown[]) =>
      (h.store.call as (m: string, ...a: unknown[]) => Promise<unknown>)(method, ...args),
    bookmark: async () => `00000001-00000002-00000003-${'b'.repeat(32)}`,
    counts: async () => ({ message: 0 }),
    restart: async () => {},
  }
  return { idFromName: (name: string) => name, get: () => stub } as unknown as InboxPartEnv['INBOX']
}

const partOver = (h: ReturnType<typeof harness>, over: Partial<InboxPartEnv> = {}) =>
  createInboxPartFactory()({
    INBOX: namespaceOver(h),
    clients: h.directory,
    INBOX_ACCESS_CLIENT_ID: AGENT_ID,
    TELEGRAM_ACCESS_CLIENT_ID: TELEGRAM_ID,
    ...over,
  })

describe('the inbox’s part in the space’s Worker', () => {
  test('is called with the person the check named: the owner is answered, anyone else is not-admitted, and no assertion is read anywhere', async () => {
    const h = harness()
    const part = partOver(h)
    expect(await part.people(asker(OWNER))).toMatchObject({ ok: true })
    expect(await part.people(asker(STRANGER))).toMatchObject({ ok: false, reason: 'not-admitted' })
    expect(await part.storeBookmark(asker(OWNER))).toMatchObject({ ok: true })
  })

  test('its operator reaches the store’s object through the namespace, and only for the owner', async () => {
    const h = harness()
    const part = partOver(h)
    expect(await part.storeCounts(asker(OWNER))).toEqual({ ok: true, value: { counts: { message: 0 } } })
    expect(await part.restartStore(asker(OWNER))).toEqual({ ok: true, value: { restarted: true } })
    expect(await part.storeCounts(asker(STRANGER))).toMatchObject({ ok: false, reason: 'not-admitted' })
  })

  test('Claude’s door: the token the check verified is admitted as the agent by its id alone, on /api/ only', async () => {
    const h = harness()
    const part = partOver(h)
    const request = (path: string) =>
      new Request(`https://space.northfield.example${path}`, {
        headers: { 'cf-access-jwt-assertion': 'not.even.a.jwt' },
      })
    const ok = await part.claude(request('/api/queue'), {
      kind: 'service',
      commonName: AGENT_ID,
      exp: Math.floor(Date.now() / 1000) + 600,
    })
    expect(ok.status).toBe(200)
    // Not the token the inbox knows: refused (a verified token of another application, or a name nobody holds).
    expect(
      (
        await part.claude(request('/api/queue'), {
          kind: 'service',
          commonName: 'someone-else.access',
          exp: 9_999_999_999,
        })
      ).status,
    ).toBe(403)
    // Nothing but the API: no page, no file.
    expect(
      (await part.claude(request('/index.html'), { kind: 'service', commonName: AGENT_ID, exp: 9_999_999_999 })).status,
    ).toBe(404)
    // Without the token's id deployed, nobody is admitted.
    const bare = partOver(h, { INBOX_ACCESS_CLIENT_ID: '' })
    expect(
      (await bare.claude(request('/api/queue'), { kind: 'service', commonName: AGENT_ID, exp: 9_999_999_999 })).status,
    ).toBe(403)
  })

  test('Claude’s door gives the router only what it reads: the knowledge it is handed is the in-process one, not a binding', async () => {
    const h = harness()
    const token = { kind: 'service', commonName: AGENT_ID, exp: 9_999_999_999 } as const
    h.knowledge.seed({ title: 'Hours', body: 'Open weekdays.', businesses: ['ridgeway-cycles'] })
    // Handed a port, the knowledge route reads it; handed none, the route says the knowledge app is not reached (it never looks for a binding of the Worker's own).
    const wired = await partOver(h, { knowledge: h.knowledge }).claude(
      new Request('https://space.northfield.example/api/knowledge'),
      token,
    )
    expect(wired.status).toBe(200)
    const bare = await partOver(h).claude(new Request('https://space.northfield.example/api/knowledge'), token)
    expect(bare.status).toBe(502)
  })

  test('the Telegram bridge’s door: the token the check verified is admitted by its own id, on its five calls only, and Claude’s token is not the bridge', async () => {
    const h = harness()
    const part = partOver(h)
    const bridge = { kind: 'service', commonName: TELEGRAM_ID, exp: 9_999_999_999 } as const
    const call = (path: string) =>
      new Request(`https://space.northfield.example${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: { id: '7000000001' } }),
      })
    expect((await part.telegram(call('/api/work'), bridge)).status).toBe(200)
    // Claude's token is not the bridge's, and the bridge's is not Claude's.
    expect((await part.telegram(call('/api/work'), { ...bridge, commonName: AGENT_ID })).status).toBe(403)
    expect((await part.claude(new Request('https://space.northfield.example/api/queue'), bridge)).status).toBe(403)
    // Nothing but its five calls.
    expect((await part.telegram(call('/api/queue'), bridge)).status).toBe(404)
    // Without the token's id deployed, nobody is admitted.
    const bare = partOver(h, { TELEGRAM_ACCESS_CLIENT_ID: '' })
    expect((await bare.telegram(call('/api/work'), bridge)).status).toBe(403)
  })

  test('the router asked to name the caller refuses a request the map does not hold, and reads no assertion', async () => {
    const h = harness()
    const router = createApp({ store: () => h.store, named: () => null })
    const res = await router.request(
      'https://space.northfield.example/api/queue',
      {
        headers: {
          'cf-access-jwt-assertion': await (await import('../test-support/harness')).mint(AGENT, {
            audience: 'd'.repeat(64),
          }),
        },
      },
      { INBOX: {} as never, INBOX_ACCESS_CLIENT_ID: AGENT_ID },
    )
    expect(res.status).toBe(401)
  })
})
