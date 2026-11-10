// The SFU client: a request that is never answered must fail, not hang a check-in until the member is reaped.
import { describe, expect, test } from 'bun:test'
import { RealtimeError, cloudflareRealtime } from '../src/realtime'

const cfg = { appId: 'a', appSecret: 's', turnKeyId: 'k', turnToken: 't' }

describe('the SFU client', () => {
  test('a request the SFU never answers fails with a 504 once the timeout passes', async () => {
    const rt = cloudflareRealtime({
      ...cfg,
      timeoutMs: 30,
      fetch: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        )) as unknown as typeof fetch,
    })
    const started = Date.now()
    const err = await rt.newSession().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RealtimeError)
    expect((err as RealtimeError).status).toBe(504)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('every request carries the timeout, and an answer in time is returned as before', async () => {
    let signalSeen = false
    const rt = cloudflareRealtime({
      ...cfg,
      fetch: (async (_url: string, init?: RequestInit) => {
        signalSeen = init?.signal instanceof AbortSignal
        return Response.json({ sessionId: 'abc' })
      }) as unknown as typeof fetch,
    })
    expect(await rt.newSession()).toBe('abc')
    expect(signalSeen).toBe(true)
  })

  test('an error that is not the timeout is not reported as one', async () => {
    const rt = cloudflareRealtime({
      ...cfg,
      fetch: (async () => Response.json({ errorDescription: 'nope' }, { status: 500 })) as unknown as typeof fetch,
    })
    const err = await rt.newSession().catch((e: unknown) => e)
    expect((err as RealtimeError).status).toBe(500)
  })
})
