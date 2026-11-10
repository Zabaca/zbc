// The Worker's entrances (src/worker.ts), driven the way Google, Cloudflare Email Routing, Cloudflare Queues and Cloudflare's cron drive them.
// The inbox's own suites hold what each entrance does with a store; what is held here is where each request goes: which
// hostname reaches Gmail's push and which reaches the router, and which cron runs which work.
import { describe, expect, test } from 'bun:test'
import { googleKeys, mintPush, PUSH_ACCOUNT, PUSH_ENDPOINT } from '../../inbox/test-support/harness'
import { createWorker, FORMS_CRON, type WorkerEnv } from '../src/worker'

const PUSH = 'https://inbox-push.northfield.example/api/gmail/push'
const body = JSON.stringify({ message: { data: btoa(JSON.stringify({ emailAddress: 'tessa@northfield.example', historyId: '1' })) } })

function worker(settings: { endpoint?: string } = {}) {
  const stored: string[] = []
  const reached: string[] = []
  const env = {
    GMAIL_PUSH_ENDPOINT: settings.endpoint ?? PUSH_ENDPOINT,
    GMAIL_PUSH_SERVICE_ACCOUNT: PUSH_ACCOUNT,
    INBOX: {
      idFromName: (name: string) => name,
      get: () => ({
        call: async (method: string) => {
          stored.push(method)
          return method === 'keepDeliveryEvents' ? { kept: 0, repeated: 0, dropped: 0, unmatched: 0 } : undefined
        },
      }),
    },
  }
  const w = createWorker<WorkerEnv>({
    team: async (request) => {
      reached.push(new URL(request.url).pathname)
      return new Response('team', { status: 401 })
    },
    pushKeys: googleKeys,
  })
  const promises: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => void promises.push(p), settled: () => Promise.all(promises) }
  const fetch = (url: string, init: RequestInit = {}) => w.fetch(new Request(url, init), env as never, ctx as never)
  return { w, env: env as never, stored, reached, ctx, fetch }
}

const authorised = async () => ({ authorization: `Bearer ${await mintPush()}` })

describe('inbox-push.northfield.example', () => {
  test('takes Google’s push, with its token, and the router is never asked', async () => {
    const t = worker()
    const res = await t.fetch(PUSH, { method: 'POST', body, headers: await authorised() })
    expect(res.status).toBe(204)
    expect(t.stored).toEqual(['receivePush'])
    expect(t.reached).toEqual([])
  })

  test('answers nothing else: another path, another method and a team path are each a 404 that never reaches the router, and a push without its token is refused', async () => {
    const t = worker()
    const answers = [
      await t.fetch('https://inbox-push.northfield.example/api/me', { method: 'POST', headers: await authorised() }),
      await t.fetch('https://inbox-push.northfield.example/', { headers: { 'cf-access-jwt-assertion': 'anything' } }),
      await t.fetch(PUSH, { method: 'GET' }),
      await t.fetch('https://inbox-push.northfield.example/agent/inbox/api/queue', { method: 'POST' }),
      await t.fetch(PUSH, { method: 'POST', body }),
    ]
    expect(answers.map((a) => a.status)).toEqual([404, 404, 404, 404, 401])
    expect(t.reached).toEqual([])
    expect(t.stored).toEqual([])
    for (const a of answers) expect(a.headers.get('x-frame-options')).toBe('DENY')
  })

  test('is recognised from the deployed constant even when the settings are missing, and then refuses everything', async () => {
    const t = worker()
    const res = await t.w.fetch(new Request(PUSH, { method: 'POST', body, headers: await authorised() }), {} as never, t.ctx as never)
    expect(res.status).toBe(401)
    expect(t.reached).toEqual([])
  })
})

describe('space.northfield.example and every other host', () => {
  test('a push POSTed at the space’s own host, token and all, is a request for the router like any other: it is not taken', async () => {
    const t = worker()
    const res = await t.fetch('https://space.northfield.example/api/gmail/push', { method: 'POST', body, headers: await authorised() })
    expect(res.status).toBe(401)
    expect(t.reached).toEqual(['/api/gmail/push'])
    expect(t.stored).toEqual([])
  })

  test('the space’s host is never the push host, whatever the settings say, so a mistyped endpoint cannot turn the team’s door into a 404', async () => {
    const t = worker({ endpoint: 'https://space.northfield.example/api/gmail/push' })
    await t.fetch('https://space.northfield.example/api/me')
    expect(t.reached).toEqual(['/api/me'])
  })

  test('a host the settings name is the push host too (as the inbox’s push door has always accepted), and any other is the router’s', async () => {
    const t = worker({ endpoint: 'https://inbox-push2.northfield.example/api/gmail/push' })
    const moved = await t.fetch('https://inbox-push2.northfield.example/api/me')
    expect(moved.status).toBe(404)
    await t.fetch('https://localhost/api/me')
    await t.fetch('https://space.northfield.example/anything')
    expect(t.reached).toEqual(['/api/me', '/anything'])
  })
})

describe('the other three entrances', () => {
  test('Cloudflare’s mail for a domain nobody declared is refused and touches no store', async () => {
    const t = worker()
    const rejected: string[] = []
    await t.w.email(
      { from: 'a@example.net', to: 'x@elsewhere.example', raw: new Response('x').body as never, rawSize: 1, setReject: (r: string) => void rejected.push(r) },
      t.env,
      t.ctx,
    )
    expect(rejected).toHaveLength(1)
    expect(t.stored).toEqual([])
  })

  test('the delivery reports are kept by the store and acknowledged', async () => {
    const t = worker()
    const answered: string[] = []
    await t.w.queue({ messages: [{ body: {} }], ackAll: () => void answered.push('ack'), retryAll: () => void answered.push('retry') }, t.env)
    expect([t.stored, answered]).toEqual([['keepDeliveryEvents'], ['ack']])
  })

  test('the daily expression runs the inbox’s daily pass; every other expression is meet’s sweep and the inbox hears nothing', async () => {
    const daily = worker()
    daily.w.scheduled({ cron: '47 9 * * *' }, daily.env, daily.ctx)
    await daily.ctx.settled()
    expect(daily.stored).toEqual(['runDaily', 'runJmapDaily'])
    const sweep = worker()
    sweep.w.scheduled({ cron: '*/5 * * * *' }, sweep.env, sweep.ctx)
    sweep.w.scheduled({}, sweep.env, sweep.ctx)
    await sweep.ctx.settled()
    expect(sweep.stored).toEqual([])
  })

  test('the five-minute tick also puts right Forms’ copy of each Client’s names, over Forms’ database and the Clients store, and does nothing where either is not bound', async () => {
    const written: unknown[][] = []
    const client = { number: 5, name: 'Acme Law', legalName: 'Acme Legal LLP', createdAt: 1, createdBy: 'x', updatedAt: 1, updatedBy: 'x', archivedAt: null, archivedBy: null, revision: 2, source: null }
    const store = { idFromName: () => 'id', get: () => ({ call: async (method: string) => (method === 'list' ? { ok: true, value: [client] } : { ok: false, reason: 'not-found', error: 'no' }) }) }
    const sql: string[] = []
    const forms = {
      prepare: (text: string) => {
        sql.push(text)
        const stmt = {
          bind: (...values: unknown[]) => (written.push([text, ...values]), stmt),
          all: async () => ({ results: [{ id: 'row-5', client_number: 5, display_name: 'Acme Legal', legal_name: 'Acme Legal LLP', reply_to: 'a@b.example' }] }),
          first: async () => ({ id: 'row-5', display_name: 'Acme Legal', legal_name: 'Acme Legal LLP' }),
          run: async () => ({}),
        }
        return stmt
      },
      batch: async () => [{ results: [{ id: 'row-5' }] }],
    }
    const FIVE_MINUTES = ['*', '/5 * * * *'].join('')
    const t = worker()
    t.w.scheduled({ cron: FIVE_MINUTES }, { ...(t.env as object), FORMS_DB: forms, CLIENTS_STORE: store } as never, t.ctx)
    await t.ctx.settled()
    expect(sql.some((q) => /FROM clients WHERE client_number IS NOT NULL/.test(q))).toBe(true)
    // The row named "Acme Legal" is written as the Client's name, "Acme Law", by the repair.
    expect(written.some((w) => w.includes('Acme Law'))).toBe(true)
    expect(written.some((w) => w.includes('clients:repair'))).toBe(true)
    // Neither side bound: nothing is asked of Forms.
    const none: string[] = []
    const bare = worker()
    bare.w.scheduled({ cron: FIVE_MINUTES }, { ...(bare.env as object), FORMS_DB: { prepare: (q: string) => (none.push(q), {}) } } as never, bare.ctx)
    await bare.ctx.settled()
    expect(none).toEqual([])
  })

  test('forms’ hourly expression runs forms’ sweep over forms’ database, and neither the inbox nor meet hears of it', async () => {
    const prepared: string[] = []
    const t = worker()
    const env = {
      ...(t.env as object),
      FORMS_FILES: {},
      FORMS_DATA_KEY: btoa('k'.repeat(32)),
      FORMS_DB: { prepare: (sql: string) => (prepared.push(sql), { bind: () => ({ all: async () => ({ results: [] }), first: async () => null, run: async () => ({}) }), all: async () => ({ results: [] }), first: async () => null, run: async () => ({}) }), batch: async () => [] },
    }
    t.w.scheduled({ cron: FORMS_CRON }, env as never, t.ctx)
    await Promise.allSettled([t.ctx.settled()])
    expect(prepared.length).toBeGreaterThan(0)
    expect(t.stored).toEqual([])
  })

  test('forms’ expression is the one the Worker’s settings declare, beside the other two, and does nothing where forms’ database is not bound', async () => {
    expect(FORMS_CRON).toBe('0 * * * *')
    const t = worker()
    t.w.scheduled({ cron: FORMS_CRON }, t.env, t.ctx)
    await t.ctx.settled()
    expect(t.stored).toEqual([])
  })
})
