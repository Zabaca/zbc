import { describe, expect, test } from 'bun:test'
import { collectRemote, continueRemote, destroyRemote, runRemote } from './remote'

// The remote tier is an HTTP client over an agent-host (a box running sessions
// as containers). These tests own the wire contract with an injected fetch —
// no host, no money.

const CONFIG = { host: 'http://agent-host.tail:8794', token: 'bearer-secret' }

type Captured = { url: string; method: string; headers: Record<string, string>; body?: unknown }

function fakeFetch(status: number, payload: unknown, captured: Captured[] = []) {
  const impl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    captured.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
    })
    if (payload instanceof ArrayBuffer) return new Response(payload, { status })
    return new Response(JSON.stringify(payload), { status })
  }
  return { impl, captured }
}

const RUN_PAYLOAD = {
  id: 'ab12cd34',
  claudeSessionId: 'uuid-1',
  text: 'done',
  turns: 3,
  totalCostUsd: 0.05,
  status: 'idle',
}

describe('runRemote', () => {
  test('POSTs the profile, repo and tokens to /api/sessions with the bearer', async () => {
    const { impl, captured } = fakeFetch(201, RUN_PAYLOAD)
    const run = await runRemote('coding', 'fix the test', CONFIG, {
      repo: 'https://github.com/x/y.git',
      claudeToken: 'sk-ant-oat01-x',
      fetch: impl,
    })
    expect(captured[0]?.url).toBe('http://agent-host.tail:8794/api/sessions')
    expect(captured[0]?.method).toBe('POST')
    expect(captured[0]?.headers['authorization']).toBe('Bearer bearer-secret')
    expect(captured[0]?.body).toMatchObject({
      repo: 'https://github.com/x/y.git',
      prompt: 'fix the test',
      profile: 'coding',
      claudeToken: 'sk-ant-oat01-x',
    })
    expect(run).toEqual({ id: 'ab12cd34', sessionId: 'uuid-1', text: 'done', turns: 3, totalCostUsd: 0.05 })
  })

  test('surfaces the host error body on a non-2xx answer', async () => {
    const { impl } = fakeFetch(502, { error: 'guest exec failed: boom' })
    await expect(
      runRemote('review', 'look', CONFIG, { repo: 'r', claudeToken: 't', fetch: impl }),
    ).rejects.toThrow(/boom/)
  })
})

describe('continueRemote', () => {
  test('POSTs to the session turns route and returns the same shape', async () => {
    const { impl, captured } = fakeFetch(200, RUN_PAYLOAD)
    const run = await continueRemote({ id: 'ab12cd34' }, 'also update docs', CONFIG, {
      claudeToken: 'sk-ant-oat01-x',
      fetch: impl,
    })
    expect(captured[0]?.url).toBe('http://agent-host.tail:8794/api/sessions/ab12cd34/turns')
    expect(captured[0]?.body).toMatchObject({ prompt: 'also update docs' })
    expect(run.sessionId).toBe('uuid-1')
  })
})

describe('collectRemote', () => {
  test('downloads the bundle to a file and reports the agent branch', async () => {
    const bytes = new TextEncoder().encode('BUNDLE').buffer as ArrayBuffer
    const { impl, captured } = fakeFetch(200, bytes)
    const collected = await collectRemote({ id: 'ab12cd34' }, CONFIG, { fetch: impl })
    expect(captured[0]?.url).toBe('http://agent-host.tail:8794/api/sessions/ab12cd34/collect')
    expect(collected.branch).toBe('agent/ab12cd34')
    expect(await Bun.file(collected.bundle).text()).toBe('BUNDLE')
  })
})

describe('destroyRemote', () => {
  test('DELETEs the session', async () => {
    const { impl, captured } = fakeFetch(200, { id: 'ab12cd34', status: 'destroyed' })
    await destroyRemote({ id: 'ab12cd34' }, CONFIG, { fetch: impl })
    expect(captured[0]?.method).toBe('DELETE')
    expect(captured[0]?.url).toBe('http://agent-host.tail:8794/api/sessions/ab12cd34')
  })
})
