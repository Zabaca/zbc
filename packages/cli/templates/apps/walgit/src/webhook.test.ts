/**
 * The push webhook's contract: what is sent, how it is signed, how a receiver
 * checks it, and when a delivery is tried again.
 */

import { describe, expect, test } from 'bun:test'

import { publish, publishConfigFromEnv } from './announce'
import { ZERO_OID } from '../shared/protocol'
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  type WebhookEvent,
  deliverWebhook,
  signWebhook,
  verifyWebhook,
  webhookConfigFromEnv,
  webhookEventsFromChanges,
} from '../shared/webhook'

const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const CONFIG = { url: 'https://receiver.example.com/hook', secret: 'hook-secret' }
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0)

interface Seen {
  url: string
  headers: Record<string, string>
  body: string
}

/** A receiver answering each attempt with the next status in `statuses`. */
function receiver(statuses: number[]) {
  const seen: Seen[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: init.body as string })
    return new Response('', { status: statuses[seen.length - 1] ?? 200 })
  }) as unknown as typeof fetch
  return { seen, fetchImpl }
}

const noSleep = { sleep: async () => {}, now: () => NOW, log: () => {} }

function event(): WebhookEvent {
  return webhookEventsFromChanges(
    'my-thing',
    [{ ref: 'refs/heads/main', oldOid: OLD, newOid: NEW }],
    {},
    NOW,
  )[0]!
}

describe('webhookConfigFromEnv', () => {
  test('off unless both halves are set', () => {
    expect(webhookConfigFromEnv({})).toBeNull()
    expect(webhookConfigFromEnv({ WALGIT_WEBHOOK_URL: 'https://x' })).toBeNull()
    expect(webhookConfigFromEnv({ WALGIT_WEBHOOK_SECRET: 's' })).toBeNull()
    expect(webhookConfigFromEnv({ WALGIT_WEBHOOK_URL: ' ', WALGIT_WEBHOOK_SECRET: 's' })).toBeNull()
    expect(
      webhookConfigFromEnv({ WALGIT_WEBHOOK_URL: 'https://x', WALGIT_WEBHOOK_SECRET: 's' }),
    ).toEqual({
      url: 'https://x',
      secret: 's',
    })
  })

  test('with neither the stream nor the webhook set, nothing is announced at all', () => {
    expect(publishConfigFromEnv({})).toBeNull()
    expect(
      publishConfigFromEnv({ WALGIT_WEBHOOK_URL: 'https://x', WALGIT_WEBHOOK_SECRET: 's' }),
    ).toEqual({ events: null, webhook: { url: 'https://x', secret: 's' } })
  })
})

describe('webhookEventsFromChanges', () => {
  test('carries the stream fields plus the previous sha, an id and a timestamp', () => {
    const [moved, created, deleted] = webhookEventsFromChanges(
      'my-thing',
      [
        { ref: 'refs/heads/main', oldOid: OLD, newOid: NEW },
        { ref: 'refs/heads/new', oldOid: ZERO_OID, newOid: NEW },
        { ref: 'refs/heads/gone', oldOid: OLD, newOid: ZERO_OID },
      ],
      { 'refs/heads/main': ['p1'] },
      NOW,
    )
    expect(moved).toMatchObject({
      repo: 'my-thing',
      ref: 'refs/heads/main',
      oldSha: OLD,
      sha: NEW,
      merged: ['p1'],
      timestamp: '2026-11-11T12:00:00.000Z',
    })
    expect(created).toMatchObject({ oldSha: null, sha: NEW })
    expect(created).not.toHaveProperty('merged')
    expect(deleted).toMatchObject({ oldSha: OLD, sha: null })
    expect(new Set([moved!.id, created!.id, deleted!.id]).size).toBe(3)
  })
})

describe('signature', () => {
  test("a receiver's check passes on what walgit sent, and fails on a tampered body", async () => {
    const { seen, fetchImpl } = receiver([200])
    expect(await deliverWebhook(CONFIG, event(), { fetchImpl, ...noSleep })).toBe(true)
    const [req] = seen
    const check = (body: string) =>
      verifyWebhook({
        secret: CONFIG.secret,
        body,
        signature: req!.headers[SIGNATURE_HEADER]!,
        timestamp: req!.headers[TIMESTAMP_HEADER]!,
        now: NOW,
      })
    expect(req!.url).toBe(CONFIG.url)
    expect(req!.headers[EVENT_ID_HEADER]).toBe(JSON.parse(req!.body).id)
    expect(req!.headers[SIGNATURE_HEADER]).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(await check(req!.body)).toBe(true)
    expect(await check(req!.body.replace(NEW, OLD))).toBe(false)
    expect(
      await verifyWebhook({
        secret: 'not-the-secret',
        body: req!.body,
        signature: req!.headers[SIGNATURE_HEADER]!,
        timestamp: req!.headers[TIMESTAMP_HEADER]!,
        now: NOW,
      }),
    ).toBe(false)
  })

  test('a replay outside the tolerance is refused, as is a missing header', async () => {
    const timestamp = String(NOW / 1000)
    const body = '{}'
    const signature = await signWebhook('s', timestamp, body)
    expect(await verifyWebhook({ secret: 's', body, signature, timestamp, now: NOW })).toBe(true)
    expect(
      await verifyWebhook({ secret: 's', body, signature, timestamp, now: NOW + 301_000 }),
    ).toBe(false)
    expect(await verifyWebhook({ secret: 's', body, signature: null, timestamp, now: NOW })).toBe(
      false,
    )
    expect(await verifyWebhook({ secret: 's', body, signature, timestamp: null, now: NOW })).toBe(
      false,
    )
  })

  test('the secret is never sent', async () => {
    const { seen, fetchImpl } = receiver([200])
    await deliverWebhook(CONFIG, event(), { fetchImpl, ...noSleep })
    expect(JSON.stringify(seen)).not.toContain(CONFIG.secret)
  })
})

describe('delivery', () => {
  test('a 5xx is retried with backoff until it is accepted, as the same event', async () => {
    const { seen, fetchImpl } = receiver([500, 503, 200])
    const waits: number[] = []
    const ok = await deliverWebhook(CONFIG, event(), {
      fetchImpl,
      ...noSleep,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(ok).toBe(true)
    expect(seen).toHaveLength(3)
    expect(waits).toEqual([1_000, 2_000])
    expect(new Set(seen.map((s) => s.body)).size).toBe(1)
  })

  test('retries are bounded, and giving up logs neither the secret nor throws', async () => {
    const { seen, fetchImpl } = receiver([500, 500, 500, 500, 500, 500, 500])
    const lines: string[] = []
    const ok = await deliverWebhook(CONFIG, event(), {
      fetchImpl,
      ...noSleep,
      log: (line) => lines.push(line),
    })
    expect(ok).toBe(false)
    expect(seen).toHaveLength(5)
    expect(lines.join('\n')).not.toContain(CONFIG.secret)
  })

  test('a network failure is retried too', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      if (calls === 1) throw new TypeError('connection refused')
      return new Response('')
    }) as unknown as typeof fetch
    expect(await deliverWebhook(CONFIG, event(), { fetchImpl, ...noSleep })).toBe(true)
    expect(calls).toBe(2)
  })

  test('a 4xx refusal is not repeated', async () => {
    const { seen, fetchImpl } = receiver([401])
    expect(await deliverWebhook(CONFIG, event(), { fetchImpl, ...noSleep })).toBe(false)
    expect(seen).toHaveLength(1)
  })
})

describe('publish', () => {
  test('one push fires the stream and one webhook per moved ref', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string) => {
      urls.push(url)
      return new Response('{"ok":true}')
    }) as unknown as typeof fetch
    await publish(
      { events: { url: 'https://walgit.example.com', token: 't' }, webhook: CONFIG },
      'my-thing',
      [
        { ref: 'refs/heads/main', oldOid: OLD, newOid: NEW },
        { ref: 'refs/heads/dev', oldOid: ZERO_OID, newOid: NEW },
      ],
      {},
      { fetchImpl, webhook: noSleep },
    )
    expect(urls.toSorted()).toEqual([
      CONFIG.url,
      CONFIG.url,
      'https://walgit.example.com/_walgit/announce',
    ])
  })
})
