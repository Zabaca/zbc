// The event log in REAL local D1, in workerd: what test/ cannot show, because bun:sqlite is not D1. The append-only triggers
// are exercised by the database the Worker really runs (the wrangler CLI against the same local state), and the guarded
// batch is raced for real: signers finishing at once, one signer pressing Finish twice, and many writers racing for the
// same place in one envelope's chain.
//
//   bun test e2e/events.test.ts     (FORMS_E2E_PORT_EVENTS names the port, else a free one is used)
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { setUpClient } from './clients'
import { linkFor } from './local-mail'
import { ROOT, type Server, startServer } from './server'

let server: Server
beforeAll(async () => {
  server = await startServer({ portEnv: 'FORMS_E2E_PORT_EVENTS' })
}, 240_000)
afterAll(() => server?.kill(), 60_000)

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const admin = async <T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
  const res = await fetch(`${server.base}/admin/api${path}`, body === undefined ? { method } : json(method, body))
  return { status: res.status, body: (await res.json().catch(() => null)) as T }
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('base64')

const tokenOf = (link: string) => link.split('/s/')[1]!
const api = (token: string) => async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${server.base}/s/api/s/${token}${path}`, body === undefined ? { method } : json(method, body))
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}

async function sendSample(order: 'parallel' | 'sequential', people: string[]) {
  const client = await setUpClient(server.base, { slug: `ev-${Math.random().toString(36).slice(2, 8)}`, display_name: 'Pinecrest', legal_name: 'Pinecrest Roofing', reply_to: 'office@pinecrest.example' })
  const draft = await admin('POST', '/envelopes', { client_id: client.id, source: { type: 'sample' }, order, recipients: people.map((name, i) => ({ role: `Signer ${i + 1}`, name, email: `${name.split(' ')[0]!.toLowerCase()}@example.test` })) })
  expect(draft.status).toBe(201)
  const id = draft.body.envelope.id as string
  expect((await admin('POST', `/envelopes/${id}/send`, {})).status).toBe(200)
  return id
}

/** Everything a signer does short of Finish, over the real HTTP API. */
async function ready(token: string, name: string) {
  const s = api(token)
  await s('POST', '/open')
  expect((await s('POST', '/consent')).status).toBe(200)
  const view = (await s('GET', '')).body
  expect(view.state).toBe('sign')
  expect((await s('POST', '/adopt', { kind: 'signature', method: 'drawn', image: png })).status).toBe(200)
  expect((await s('POST', '/adopt', { kind: 'initials', method: 'drawn', image: png })).status).toBe(200)
  for (const f of view.fields) {
    const value = f.type === 'signature' || f.type === 'initials' ? 'adopted' : f.type === 'text' ? name : f.type === 'checkbox' ? true : undefined
    if (value !== undefined) expect((await s('PUT', `/fields/${f.id}`, { value })).status).toBe(200)
  }
  return s
}

const actionsOf = async (id: string) => ((await admin('GET', `/envelopes/${id}`)).body.events as { action: string; seq: number }[]).map((e) => e.action)

describe('the event log in real D1', () => {
  test('two signers finishing at once complete the envelope once, with the chain intact', async () => {
    const id = await sendSample('parallel', ['Alice Example', 'Bob Preparer'])
    const a = await ready(tokenOf(linkFor(server.base, 'Alice Example')), 'Alice Example')
    const b = await ready(tokenOf(linkFor(server.base, 'Bob Preparer')), 'Bob Preparer')
    const done = await Promise.all([a('POST', '/finish', { intent: true }), b('POST', '/finish', { intent: true })])
    expect(done.map((d) => d.status)).toEqual([200, 200])
    const actions = await actionsOf(id)
    expect(actions.filter((x) => x === 'signed')).toHaveLength(2)
    expect(actions.filter((x) => x === 'sealing')).toHaveLength(1)
    expect(actions.filter((x) => x === 'completed')).toHaveLength(1)
    const view = (await admin('GET', `/envelopes/${id}`)).body
    expect(view.envelope.status).toBe('completed')
    expect(view.chain.ok).toBe(true)
    // Sequence numbers are contiguous: no event was lost to the race and none was written twice.
    expect(view.events.map((e: { seq: number }) => e.seq)).toEqual(view.events.map((_: unknown, i: number) => i + 1))
  }, 120_000)

  test('one signer pressing Finish twice at once signs once', async () => {
    const id = await sendSample('parallel', ['Carol Example', 'Dan Preparer'])
    const c = await ready(tokenOf(linkFor(server.base, 'Carol Example')), 'Carol Example')
    const [x, y] = await Promise.all([c('POST', '/finish', { intent: true }), c('POST', '/finish', { intent: true })])
    expect([x.status, y.status].filter((s) => s === 200)).toHaveLength(1)
    expect([x.status, y.status].filter((s) => s !== 200).every((s) => s === 409 || s === 410)).toBe(true)
    expect((await actionsOf(id)).filter((a) => a === 'signed')).toHaveLength(1)
    expect(((await admin('GET', `/envelopes/${id}`)).body.chain as { ok: boolean }).ok).toBe(true)
  }, 120_000)

  test('writers racing for the same place in one envelope\'s chain each land, one after another', async () => {
    const id = await sendSample('sequential', ['Erin Example', 'Fay Preparer'])
    const results = await Promise.all(Array.from({ length: 4 }, () => admin('POST', `/envelopes/${id}/remind`, {})))
    const ok = results.filter((r) => r.status === 200).length
    expect(ok).toBeGreaterThanOrEqual(1)
    const view = (await admin('GET', `/envelopes/${id}`)).body
    const reminded = view.events.filter((e: { action: string }) => e.action === 'reminded')
    // Every reminder that answered 200 is on the record exactly once, and the chain is unbroken.
    expect(reminded).toHaveLength(ok)
    expect(view.chain.ok).toBe(true)
    expect(view.events.map((e: { seq: number }) => e.seq)).toEqual(view.events.map((_: unknown, i: number) => i + 1))
  }, 120_000)
})

describe('the triggers in the database the Worker really runs', () => {
  const sql = (command: string) => {
    const r = Bun.spawnSync(['bunx', 'wrangler', 'd1', 'execute', 'forms-records', '--local', '--config', 'dev/wrangler.jsonc', '--persist-to', '.wrangler/state', '--command', command], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
    return { code: r.exitCode, out: `${r.stdout.toString()}\n${r.stderr.toString()}` }
  }

  test('an event is never changed, and is deleted only once its envelope has been purged', () => {
    const update = sql("UPDATE events SET ip = '6.6.6.6'")
    expect(update.code).not.toBe(0)
    expect(update.out).toContain('an event is never changed')
    const del = sql('DELETE FROM events')
    expect(del.code).not.toBe(0)
    expect(del.out).toContain('deleted only when its envelope has been purged')
  })

  test('an event cannot be inserted anywhere but at the end of its envelope\'s chain', () => {
    const insert = sql("INSERT INTO events (envelope_id, client_id, seq, at, actor_kind, action, details, prev_hash, hash) SELECT envelope_id, client_id, 99, 'now', 'system', 'forged', '{}', 'x', 'y' FROM events LIMIT 1")
    expect(insert.code).not.toBe(0)
    expect(insert.out).toContain('UNIQUE constraint failed')
  })

  test('a writer that lost the race for a place (the sequence number is taken) is refused, and writes nothing', () => {
    const count = () => Number(/"n":\s*(\d+)/.exec(sql('SELECT count(*) AS n FROM events').out)![1])
    const before = count()
    const lost = sql("INSERT INTO events (envelope_id, client_id, seq, at, actor_kind, action, details, prev_hash, hash) SELECT envelope_id, client_id, seq, 'later', 'system', 'late', '{}', prev_hash, 'z' FROM events WHERE seq = 1 LIMIT 1")
    expect(lost.code).not.toBe(0)
    expect(lost.out).toContain('UNIQUE constraint failed')
    expect(count()).toBe(before)
  })

  test('Claude\'s sending switch is off in the database a fresh deploy gets', () => {
    const row = sql("SELECT value FROM settings WHERE key = 'agent_sending'")
    expect(row.code).toBe(0)
    expect(row.out).toContain('off')
  })
})
