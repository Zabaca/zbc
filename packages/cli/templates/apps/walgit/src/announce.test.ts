/**
 * The push path's half of ref events: what is published, when, and what happens
 * when publishing fails.
 */

import { describe, expect, test } from 'bun:test'

import { announce, announceConfigFromEnv } from './announce'
import { ZERO_OID } from '../shared/protocol'

const SHA = 'a'.repeat(40)
const CONFIG = { url: 'https://walgit.example.com', token: 'announce-secret' }

describe('announceConfigFromEnv', () => {
  test('off unless both halves are configured', () => {
    expect(announceConfigFromEnv({})).toBeNull()
    expect(announceConfigFromEnv({ WALGIT_EVENTS_URL: 'https://x' })).toBeNull()
    expect(announceConfigFromEnv({ WALGIT_EVENTS_TOKEN: 's' })).toBeNull()
    expect(
      announceConfigFromEnv({
        WALGIT_EVENTS_URL: ' ',
        WALGIT_EVENTS_TOKEN: 's',
      }),
    ).toBeNull()
  })

  test('a trailing slash does not become a double slash on the wire', () => {
    expect(
      announceConfigFromEnv({
        WALGIT_EVENTS_URL: 'https://x/',
        WALGIT_EVENTS_TOKEN: 's',
      }),
    ).toEqual({ url: 'https://x', token: 's' })
  })
})

describe('announce', () => {
  test('posts the push, authenticated, to the announce endpoint', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const ok = await announce(
      CONFIG,
      'my-thing',
      [{ ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: SHA }],
      (async (url: string, init: RequestInit) => {
        seen = { url, init }
        return new Response('{"ok":true}')
      }) as unknown as typeof fetch,
    )

    expect(ok).toBe(true)
    expect(seen!.url).toBe('https://walgit.example.com/_walgit/announce')
    expect((seen!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer announce-secret',
    )
    expect(JSON.parse(seen!.init.body as string)).toEqual({
      events: [{ repo: 'my-thing', ref: 'refs/heads/main', sha: SHA }],
    })
  })

  test('a deletion is announced as a null sha', async () => {
    let body = ''
    await announce(
      CONFIG,
      'my-thing',
      [{ ref: 'refs/heads/gone', oldOid: SHA, newOid: ZERO_OID }],
      (async (_url: string, init: RequestInit) => {
        body = init.body as string
        return new Response('{}')
      }) as unknown as typeof fetch,
    )
    expect(JSON.parse(body).events[0].sha).toBeNull()
  })

  test('a failed announce is swallowed, so it can never fail a push', async () => {
    // The push is already acknowledged by the time this runs; throwing here
    // would turn a notification outage into a git host that stops working.
    const refused = await announce(
      CONFIG,
      'r',
      [{ ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: SHA }],
      (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch,
    )
    expect(refused).toBe(false)

    const threw = await announce(
      CONFIG,
      'r',
      [{ ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: SHA }],
      (async () => {
        throw new Error('connection refused')
      }) as unknown as typeof fetch,
    )
    expect(threw).toBe(false)
  })

  test('nothing to say is not said', async () => {
    let called = false
    const sent = await announce(
      CONFIG,
      'r',
      [{ ref: 'HEAD', oldOid: ZERO_OID, newOid: SHA }],
      (async () => {
        called = true
        return new Response('{}')
      }) as unknown as typeof fetch,
    )
    expect(sent).toBe(false)
    expect(called).toBe(false)
  })
})
