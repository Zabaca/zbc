// The knowledge base in the space, driven through the real router with a stand-in knowledge app behind the
// binding. What is asserted is what a person sees (the answers the page is given, what a write came to) or what is refused, never the Worker's internals: no sign-in is
// refused at both paths and the app is never asked; the assertion the space received is the one it hands on; a write is never retried; the app's own words come
// through; a reply that is not the contract's shape is not half read; and the tab says it could not be reached while everything else keeps working.
import { describe, expect, test } from 'bun:test'
import { answered, type KnowledgeBase } from '@space/workspace'
import { T0, northfield } from '../../workspace/test/helpers'
import { fixtureKnowledge } from '../src/fixture-knowledge'
import { standInKnowledge } from '../src/stand-in-knowledge'
import type { ViewAnswer } from '../src/views'
import { NORTHFIELD_TEAM, world } from './world'

const ORIGIN = 'https://space.northfield.example'
const JSON_POST = { origin: ORIGIN, 'content-type': 'application/json' }

async function asOwner(options: { writeWithinMs?: number; answerWithinMs?: number; noKnowledge?: boolean } = {}) {
  const knowledge = standInKnowledge(fixtureKnowledge(T0), { now: () => T0 })
  const w = await world(northfield(), NORTHFIELD_TEAM, options.noKnowledge ? {} : { parts: { knowledge: knowledge.methods } }, undefined, {
    answerWithinMs: options.answerWithinMs ?? 60,
    writeWithinMs: options.writeWithinMs ?? 200,
    now: () => T0,
  })
  const jwt = await w.signIn('tessa@northfield.example')
  const get = async (path = '/api/knowledge'): Promise<ViewAnswer<KnowledgeBase>> => {
    const res = await w.call(path, { jwt })
    expect([path, res.status]).toEqual([path, 200])
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    return (await res.json()) as ViewAnswer<KnowledgeBase>
  }
  const post = (body: unknown, headers: Record<string, string> = JSON_POST) => w.call('/api/knowledge', { method: 'POST', jwt, headers, body: JSON.stringify(body) })
  const change = async (c: unknown): Promise<ViewAnswer<{ id: string; version: number; businesses: string[]; status: string }>> => {
    const res = await post({ change: c })
    expect(res.status).toBe(200)
    return (await res.json()) as never
  }
  return { w, jwt, knowledge, get, post, change, calls: () => knowledge.calls.map((c) => c.method) }
}

describe('no sign-in is refused, and the knowledge app is not asked', () => {
  test('without a sign-in, whatever the method and whatever else rides along, at the read and at the write', async () => {
    const s = await asOwner()
    const cookie = await s.w.signIn('tessa@northfield.example')
    const forms = await s.w.signInForms('tessa@northfield.example')
    for (const path of ['/api/knowledge', '/api/knowledge?business=northfield']) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        for (const init of [{}, { cookieJwt: cookie }, { jwt: forms }]) {
          const res = await s.w.call(path, { method, ...init, headers: JSON_POST, body: method === 'POST' ? '{}' : undefined })
          expect([path, method, Object.keys(init)[0] ?? 'none', res.status]).toEqual([path, method, Object.keys(init)[0] ?? 'none', 401])
        }
      }
    }
    expect(s.knowledge.calls).toEqual([])
  })

  test('another company’s person is refused too', async () => {
    const s = await asOwner()
    const stranger = await s.w.signIn('lane@pinecrest.test')
    expect((await s.w.call('/api/knowledge', { jwt: stranger })).status).toBe(403)
    expect((await s.w.call('/api/knowledge', { method: 'POST', jwt: stranger, headers: JSON_POST, body: '{}' })).status).toBe(403)
    expect(s.knowledge.calls).toEqual([])
  })
})

describe('what a write has to be', () => {
  test('from this host, as JSON, small and a change: a form on another site cannot change what the assistants say', async () => {
    const s = await asOwner()
    const call = (headers: Record<string, string>, b: string) => s.w.call('/api/knowledge', { method: 'POST', jwt: s.jwt, headers, body: b })
    const change = JSON.stringify({ change: { do: 'remove', id: 'k-old', version: 1 } })
    expect((await call({ 'content-type': 'application/json' }, change)).status).toBe(403) // no Origin
    expect((await call({ origin: 'https://evil.example', 'content-type': 'application/json' }, change)).status).toBe(403)
    expect((await call({ origin: ORIGIN, 'content-type': 'text/plain' }, change)).status).toBe(415)
    expect((await call({ origin: ORIGIN, 'content-type': 'application/json', 'content-length': '999999' }, change)).status).toBe(413)
    expect((await call(JSON_POST, 'not json')).status).toBe(400)
    expect((await call(JSON_POST, '[1]')).status).toBe(400)
    for (const bad of [{ change: 'add' }, { change: {} }, { change: { do: 'burn' } }, {}]) expect([JSON.stringify(bad), (await s.post(bad)).status]).toEqual([JSON.stringify(bad), 400])
    expect((await s.post({ change: { do: 'add', title: 'x'.repeat(50_000), body: 'b', businesses: ['northfield'] } })).status).toBe(400)
    expect(s.knowledge.calls).toEqual([])
  })

  test('a business that is not a slug is a 400 and asks no one; a method other than GET and POST is refused', async () => {
    const s = await asOwner()
    for (const path of ['/api/knowledge?business=../x', '/api/knowledge?business=A B', `/api/knowledge?business=${'a'.repeat(80)}`]) {
      expect([path, (await s.w.call(path, { jwt: s.jwt })).status]).toEqual([path, 400])
    }
    expect((await s.w.call('/api/knowledge', { method: 'PUT', jwt: s.jwt, headers: JSON_POST, body: '{}' })).status).toBe(405)
    expect((await s.w.call('/api/knowledge', { method: 'DELETE', jwt: s.jwt })).status).toBe(405)
    expect(s.knowledge.calls).toEqual([])
  })
})

describe('the read', () => {
  test('is the app’s answer, handed the person the one check named, Tessa: the businesses and every entry in each status', async () => {
    const s = await asOwner()
    const base = await s.get()
    expect(base.result).toBe('ok')
    if (base.result !== 'ok') return
    expect(base.value.businesses.map((b) => b.name)).toEqual(['Northfield Works', 'Ridgeway Cycles', 'ShiftLantern'])
    expect(base.value.business).toBeNull()
    expect(new Set(base.value.entries.map((e) => e.status))).toEqual(new Set(['active', 'proposed', 'removed']))
    expect(s.knowledge.calls).toHaveLength(1)
    expect(s.knowledge.calls[0]?.asker).toBe('tessa@northfield.example')
  })

  test('one business’s entries are exactly those marked for it, and a business the app does not list is its own refusal, in its words', async () => {
    const s = await asOwner()
    const northfield = await s.get('/api/knowledge?business=northfield')
    expect(northfield.result === 'ok' && northfield.value.entries.every((e) => e.businesses.includes('northfield'))).toBe(true)
    expect(northfield.result === 'ok' && northfield.value.entries.map((e) => e.title).sort()).toEqual(['Reply time', 'What a website costs', 'Where the guides are'])
    expect(await s.get('/api/knowledge?business=nowhere')).toEqual({ result: 'refused', reason: 'not-found', message: 'No such business.' })
  })

  test('the app down, slow, not connected or answering something that is not the contract’s shape: said as not reached, and nothing is half read', async () => {
    const s = await asOwner()
    s.knowledge.script.push('throw')
    expect(await s.get()).toMatchObject({ result: 'unreachable', message: 'Knowledge could not be reached.' })
    s.knowledge.script.push('hang')
    expect(await s.get()).toMatchObject({ result: 'unreachable', message: 'Knowledge took too long to answer.' })
    s.knowledge.methods.knowledge = async () => answered({ businesses: [], business: null, entries: [{ id: 'k' }] }) as never
    expect(await s.get()).toMatchObject({ result: 'unreachable', message: 'Knowledge answered in a way the space could not read.' })
    const fresh = await asOwner()
    fresh.knowledge.script.push('broken')
    expect(await fresh.get()).toEqual({ result: 'failed', message: 'The knowledge base could not answer that. Nothing was changed.' })
    const gone = await asOwner({ noKnowledge: true })
    expect(await gone.get()).toMatchObject({ result: 'unreachable', message: 'Knowledge is not connected to the space.' })
  })

  test('the other tabs keep working while the knowledge app is down: the page, Today and the conversation list are not its readers', async () => {
    const s = await asOwner()
    s.knowledge.script.push('throw')
    expect((await s.get()).result).toBe('unreachable')
    expect((await s.w.call('/knowledge', { jwt: s.jwt })).status).toBe(200)
    expect((await s.w.call('/api/me', { jwt: s.jwt })).status).toBe(200)
    expect((await s.w.call('/api/today', { jwt: s.jwt })).status).toBe(200)
    expect(s.calls()).toEqual(['knowledge']) // only the one read asked it
  })
})

describe('the writes', () => {
  test('an entry is added for the businesses named, in the declaration’s order, as Tessa, the person the one check named', async () => {
    const s = await asOwner()
    const added = await s.change({ do: 'add', title: 'Parking', body: 'Free in the back lot.', businesses: ['shiftlantern', 'ridgeway-cycles'] })
    expect(added).toMatchObject({ result: 'ok', value: { businesses: ['ridgeway-cycles', 'shiftlantern'], version: 1, status: 'active' } })
    expect(s.knowledge.calls[0]?.asker).toBe('tessa@northfield.example')
  })

  test('an entry for no business, or one the company does not have, is the app’s refusal and nothing is added', async () => {
    const s = await asOwner()
    const before = s.knowledge.state.entries.length
    expect(await s.change({ do: 'add', title: 'Parking', body: 'Free.', businesses: [] })).toMatchObject({ result: 'refused', reason: 'bad-request' })
    expect(await s.change({ do: 'add', title: 'Parking', body: 'Free.', businesses: ['atlantis'] })).toMatchObject({ result: 'refused', reason: 'bad-request' })
    expect(s.knowledge.state.entries).toHaveLength(before)
  })

  test('an entry added twice is added once: the second is a conflict that says to add the business to the first', async () => {
    const s = await asOwner()
    const entry = { do: 'add', title: 'Parking', body: 'Free in the back lot.', businesses: ['northfield'] }
    expect((await s.change(entry)).result).toBe('ok')
    const again = await s.change({ ...entry, businesses: ['shiftlantern'] })
    expect(again).toMatchObject({ result: 'refused', reason: 'conflict' })
    expect(again.result === 'refused' && again.message).toContain('Add the business to that entry')
  })

  test('an edit over a screen that moved on is the app’s conflict, and a change of businesses alone is a new version', async () => {
    const s = await asOwner()
    expect(await s.change({ do: 'edit', id: 'k-pricing', version: 1, body: 'A fitting is $1.' })).toMatchObject({ result: 'refused', reason: 'conflict' })
    const extended = await s.change({ do: 'edit', id: 'k-pricing', version: 2, businesses: ['northfield', 'ridgeway-cycles'] })
    expect(extended).toMatchObject({ result: 'ok', value: { version: 3, businesses: ['northfield', 'ridgeway-cycles'] } })
    const history = s.knowledge.state.entries.find((e) => e.id === 'k-pricing')?.versions.map((v) => v.businesses)
    expect(history).toEqual([['ridgeway-cycles'], ['ridgeway-cycles'], ['northfield', 'ridgeway-cycles']])
  })

  test('a proposed change gone out of date cannot be approved, and can be rejected', async () => {
    const s = await asOwner()
    // Pricing is at version 2; this change was written against version 1.
    const stale = await s.change({ do: 'approve', id: 'k-pricing-change', version: 1 })
    expect(stale).toMatchObject({ result: 'refused', reason: 'conflict' })
    expect(stale.result === 'refused' && stale.message).toContain('would undo that change')
    expect(s.knowledge.state.entries.find((e) => e.id === 'k-pricing')?.version).toBe(2)
    expect(await s.change({ do: 'reject', id: 'k-pricing-change', version: 1 })).toMatchObject({ result: 'ok', value: { status: 'removed' } })
    // One written against the version the entry is at now goes through, and is a version by Tessa.
    const ok = await s.change({ do: 'approve', id: 'k-hours-change', version: 1 })
    expect(ok).toMatchObject({ result: 'ok', value: { id: 'k-hours', version: 2 } })
  })

  test('A WRITE IS NEVER RETRIED: a lost connection is outcome unknown after exactly one try, and so is no answer in time or one that is not the contract’s shape', async () => {
    const s = await asOwner({ writeWithinMs: 80 })
    s.knowledge.script.push('throw')
    expect(await s.change({ do: 'remove', id: 'k-hours', version: 1 })).toMatchObject({ result: 'outcome-unknown', message: expect.stringContaining('did not say whether it went through') })
    s.knowledge.script.push('hang')
    expect(await s.change({ do: 'remove', id: 'k-hours', version: 1 })).toMatchObject({ result: 'outcome-unknown' })
    expect(s.calls()).toEqual(['changeKnowledge', 'changeKnowledge']) // one try each, no second
    s.knowledge.methods.changeKnowledge = async () => answered({ id: 'k' }) as never
    expect(await s.change({ do: 'remove', id: 'k-hours', version: 1 })).toMatchObject({ result: 'outcome-unknown' })
  })

  test('a fault the app knows nothing was changed by is failed, and with no app bound nothing is changed and it says so', async () => {
    const s = await asOwner()
    s.knowledge.script.push('broken')
    expect(await s.change({ do: 'remove', id: 'k-hours', version: 1 })).toEqual({ result: 'failed', message: 'The knowledge base could not answer that. Nothing was changed.' })
    const gone = await asOwner({ noKnowledge: true })
    expect(await gone.change({ do: 'remove', id: 'k-hours', version: 1 })).toEqual({ result: 'failed', message: 'Knowledge is not connected to the space. Nothing was changed.' })
  })
})

describe('the inbox no longer answers for the knowledge base', () => {
  test('the old addresses are not views any more', async () => {
    const s = await asOwner()
    expect((await s.w.call('/api/inbox/knowledge', { jwt: s.jwt })).status).toBe(404)
    expect((await s.w.call('/api/inbox/knowledge', { method: 'POST', jwt: s.jwt, headers: JSON_POST, body: '{}' })).status).toBe(405)
    expect(s.knowledge.calls).toEqual([])
  })
})

describe('the operator’s three, for a move of the store', () => {
  const BOOKMARK = '00000000-00000006-00005118-0123456789abcdef0123456789abcdef'
  const store = (path: string) => `/api/knowledge/store/${path}`

  test('are POSTs only, behind the sign-in and this host’s Origin, and the app is never asked without them', async () => {
    const s = await asOwner()
    const cookie = await s.w.signIn('tessa@northfield.example')
    for (const path of ['bookmark', 'restart', 'restore']) {
      for (const init of [{}, { cookieJwt: cookie }]) expect([path, (await s.w.call(store(path), { method: 'POST', ...init, headers: JSON_POST, body: '{}' })).status]).toEqual([path, 401])
      expect([path, (await s.w.call(store(path), { jwt: s.jwt })).status]).toEqual([path, 404]) // a read of a POST route is no route
      expect([path, (await s.w.call(store(path), { method: 'POST', jwt: s.jwt, headers: { 'content-type': 'application/json' }, body: '{}' })).status]).toEqual([path, 403])
    }
    expect(s.knowledge.calls).toEqual([])
  })

  test('the owner’s bookmark, restart and restore each go to the app once with the person the one check named, and come back as the app answered', async () => {
    const s = await asOwner()
    const post = (path: string, body: unknown = {}) => s.w.call(store(path), { method: 'POST', jwt: s.jwt, headers: JSON_POST, body: JSON.stringify(body) })
    expect(await (await post('bookmark')).json()).toMatchObject({ result: 'ok', value: { bookmark: BOOKMARK } })
    expect(await (await post('restart')).json()).toMatchObject({ result: 'ok', value: { restarted: true } })
    expect(await (await post('restore', { bookmark: BOOKMARK })).json()).toMatchObject({ result: 'ok', value: { restoring: true } })
    expect(s.knowledge.calls.map((c) => [c.method, c.asker])).toEqual([
      ['storeBookmark', 'tessa@northfield.example'],
      ['restartStore', 'tessa@northfield.example'],
      ['restoreStore', 'tessa@northfield.example'],
    ])
  })

  test('a restore with anything but a bookmark is a 400 and the app is not asked', async () => {
    const s = await asOwner()
    for (const body of [{}, { bookmark: '' }, { bookmark: 'latest' }, { bookmark: 7 }, []]) {
      const res = await s.w.call(store('restore'), { method: 'POST', jwt: s.jwt, headers: JSON_POST, body: JSON.stringify(body) })
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400])
    }
    expect(s.knowledge.calls).toEqual([])
  })

  test('where the knowledge app is not connected they say so and change nothing', async () => {
    const s = await asOwner({ noKnowledge: true })
    const res = await s.w.call(store('restart'), { method: 'POST', jwt: s.jwt, headers: JSON_POST, body: '{}' })
    expect(await res.json()).toMatchObject({ result: 'failed', message: expect.stringContaining('not connected') })
  })
})
