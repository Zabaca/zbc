// Meet's part of the space as the space's Worker holds it (src/space-part.ts), driven the way the space drives it: a method called in-process with the person its one sign-in check named, and
// `fetch` for the browser's socket upgrade and the dial pad's requests, for that same person. The Durable Objects are the real cores behind the same `invoke` doors the objects have, with the operator's
// three recorded. `cloudflare:workers` is never loaded: the part imports none of the Workers runtime (the classes are named as types only).
//
// What this proves that space-meet.test.ts cannot: that the part is made from the Worker's env alone, that the socket and the phone reach meet's own routes for the person handed in and for nobody a
// request names, that nothing else of meet is reachable, and that the operator's four are the owner's and name only the two long-lived objects.
import { describe, expect, test } from 'bun:test'
import { MEET_BOOKMARK, MEET_OPERATOR_METHODS, NOT_ADMITTED, type SignedIn } from '@space/workspace'
import { createMeetPartFactory } from '../src/space-part'
import { invokePhone } from '../src/phone'
import { invokeCore, LEDGER_NAME, ROOM_COUNTED, countRows } from '../src/room'
import { invokeWorkspace, WORKSPACE_COUNTED } from '../src/workspace'
import { ANA, OWNER, harness, signedAs } from './helpers'
import { actors } from './workspace.helpers'

const SPACE_ORIGIN = 'https://space.northfield.example'
const BOOKMARK = '00000000-00000006-00005118-0123456789abcdef0123456789abcdef'

async function wired(env: Record<string, unknown> = {}) {
  const h = await harness({ devBypass: false })
  const operated: Array<{ object: string; op: string; arg?: string }> = []
  const handedOn: Array<{ url: string; upgrade: string | null; person: string | null; ends: string | null }> = []
  const objectNamed = (object: string) => ({
    bookmark: async () => {
      operated.push({ object, op: 'bookmark' })
      return BOOKMARK
    },
    restoreTo: async (b: string) => {
      operated.push({ object, op: 'restoreTo', arg: b })
      return b
    },
    restart: async () => {
      operated.push({ object, op: 'restart' })
      throw new Error('the object was reset')
    },
    counts: async () => {
      operated.push({ object, op: 'counts' })
      return { people: 2, messages: 7 }
    },
  })
  const WORKSPACE = {
    idFromName: (n: string) => n,
    get: () => ({
      invoke: (method: string, args: unknown[]) => invokeWorkspace(h.workspaceCore, method, structuredClone(args)),
      invokePhone: (method: string, args: unknown[]) => invokePhone(h.phoneCore, method, structuredClone(args)),
      fetch: async (url: string, init: { headers: Record<string, string> }) => {
        handedOn.push({ url, upgrade: init.headers.upgrade ?? null, person: init.headers['x-meet-person'] ?? null, ends: init.headers['x-meet-ends'] ?? null })
        return new Response('socket', { status: 200 })
      },
      ...objectNamed('workspace'),
    }),
  }
  const ROOMS = {
    idFromName: (n: string) => n,
    get: (name: string) => ({
      invoke: (method: string, args: unknown[]) => {
        const core = h.cores.get(name)
        return core ? invokeCore(core, method, structuredClone(args)) : { ok: false, status: 500, message: 'not used' }
      },
      ...objectNamed(name === LEDGER_NAME ? 'ledger' : 'a call'),
    }),
  }
  const meetEnv = { WORKSPACE, ROOMS, EMAIL: { send: async () => ({}) }, ...env }
  const part = createMeetPartFactory()(meetEnv as never)
  // The part reads the real clock (Date.now), as the Worker does, so the sign-in is good for an hour from now, not from the harness's fixed T0.
  const as = (email: string, exp = Math.floor(Date.now() / 1000) + 3600): SignedIn => signedAs(h.deps.install, email, exp)
  return { h, part, as, operated, handedOn, meetEnv }
}

const upgrade = (path: string, origin: string | null = SPACE_ORIGIN) => new Request(`${SPACE_ORIGIN}${path}`, { headers: { upgrade: 'websocket', ...(origin ? { origin } : {}) } })

describe('the part is made from the Worker’s env alone and answers with the person it is handed', () => {
  test('it has the contract’s methods and fetch', async () => {
    const { part } = await wired()
    expect(typeof part.fetch).toBe('function')
    expect(typeof part.conversations).toBe('function')
    for (const m of MEET_OPERATOR_METHODS) expect(typeof part[m]).toBe('function')
  })

  test('a method asks the Workspace object as that person: Tessa sees his own overview', async () => {
    const { part, as } = await wired()
    const r = await part.conversations(as(OWNER))
    expect(r).toMatchObject({ ok: true, value: { me: { address: OWNER } } })
  })
})

describe('fetch serves the phone and nothing else, for the person handed in', () => {
  test('every other path and method is a 404 and nothing of meet is reached: the call API, the guests’ door, Telnyx’s webhook, the old /start', async () => {
    const { part, as, handedOn, h } = await wired()
    const before = h.workspaceCalls.n
    const tessa = as(OWNER)
    for (const path of ['/', '/start', '/r/k7m2qx9frtn4w6hbc8jd', '/r/api/rooms/k7m2qx9frtn4w6hbc8jd', '/api/w/bootstrap', '/api/w/auth/request', '/api/w/dev/mail', '/r/api/phone/webhook', '/api/phone/dev/event', '/api/w/socket', '/api/w/socket?ticket=abcdefghijklmnopqrstuvwxyz012345', '/API/W/SOCKET', '/api/w/socket%2f', '/space/phone/../api/w/bootstrap', '/space/phone/%2e%2e/x']) {
      for (const method of ['GET', 'POST']) {
        const res = await part.fetch(new Request(`${SPACE_ORIGIN}${path}`, { method, headers: { upgrade: 'websocket', origin: SPACE_ORIGIN }, ...(method === 'POST' ? { body: '{}' } : {}) }), tessa)
        expect([method, path, res.status]).toEqual([method, path, 404])
      }
    }
    expect(handedOn).toHaveLength(0)
    expect(h.workspaceCalls.n).toBe(before)
  })
})

describe('the phone runs for the person the space’s check named, and for no one else', () => {
  const phoneAt = (path = '/space/phone', init: RequestInit = {}) => new Request(`http://localhost${path}`, init)
  const withPhone = { FAKE_TELNYX: '1' }

  test('Tessa has a dial pad, a teammate who is not on the phone list does not, and a Worker with no Telnyx secrets has none for anyone', async () => {
    const withTelnyx = await wired(withPhone)
    expect((await (await withTelnyx.part.fetch(phoneAt(), withTelnyx.as(OWNER))).json()) as Record<string, unknown>).toMatchObject({ available: true, sdk: 'fake' })
    expect(await (await withTelnyx.part.fetch(phoneAt(), withTelnyx.as(ANA))).json()).toEqual({ available: false })
    const without = await wired()
    expect(await (await without.part.fetch(phoneAt(), without.as(OWNER))).json()).toEqual({ available: false })
  })

  test('the person is the one handed in for THAT request: a second request for another person is that person’s, and the first is not remembered', async () => {
    const { part, as } = await wired(withPhone)
    const [tessa, ana] = await Promise.all([part.fetch(phoneAt(), as(OWNER)), part.fetch(phoneAt(), as(ANA))])
    expect([await tessa.json(), await ana.json()]).toEqual([expect.objectContaining({ available: true }), { available: false }])
  })

  test('a write from another site is refused before anything happens, as on meet’s own door', async () => {
    const { part, as } = await wired(withPhone)
    const cross = await part.fetch(phoneAt('/space/phone/ack', { method: 'POST', headers: { origin: 'https://evil.example' } }), as(OWNER))
    expect(cross.status).toBe(403)
  })
})

describe('the operator’s four are the owner’s and name only the two long-lived objects', () => {
  test('the owner can bookmark each object, and the bookmark is a bookmark', async () => {
    const { part, as, operated } = await wired()
    for (const object of ['workspace', 'ledger'] as const) {
      const r = await part.storeBookmark(as(OWNER), object)
      expect(r).toEqual({ ok: true, value: { object, bookmark: BOOKMARK } })
    }
    expect(MEET_BOOKMARK.test(BOOKMARK)).toBe(true)
    expect(operated).toEqual([
      { object: 'workspace', op: 'bookmark' },
      { object: 'ledger', op: 'bookmark' },
    ])
  })

  test('a teammate who is not the owner is not-admitted at all three and no object is touched', async () => {
    const { part, as, operated } = await wired()
    const ana = as(ANA)
    for (const r of [await part.storeBookmark(ana, 'workspace'), await part.restartStore(ana, 'workspace'), await part.restoreStore(ana, 'workspace', BOOKMARK), await part.storeCounts(ana, 'workspace')]) {
      expect(r).toEqual({ ok: false, kind: 'refused', reason: 'not-admitted', message: NOT_ADMITTED })
    }
    expect(operated).toEqual([])
  })

  test('only the Workspace object and the ledger can be named: a call’s name, a path or nothing is a bad request and touches nothing', async () => {
    const { part, as, operated } = await wired()
    for (const object of ['a-call-name', '../workspace', '', undefined, null, 7, 'WORKSPACE']) {
      for (const r of [await part.storeBookmark(as(OWNER), object as never), await part.restartStore(as(OWNER), object as never), await part.restoreStore(as(OWNER), object as never, BOOKMARK), await part.storeCounts(as(OWNER), object as never)]) {
        expect([object, r]).toMatchObject([object, { ok: false, kind: 'refused', reason: 'bad-request' }])
      }
    }
    expect(operated).toEqual([])
  })

  test('the counts are the object’s own numbers, for the owner, and the answer names the object', async () => {
    const { part, as, operated } = await wired()
    expect(await part.storeCounts(as(OWNER), 'workspace')).toEqual({ ok: true, value: { object: 'workspace', counts: { people: 2, messages: 7 } } })
    expect(await part.storeCounts(as(OWNER), 'ledger')).toMatchObject({ ok: true, value: { object: 'ledger' } })
    expect(operated).toEqual([
      { object: 'workspace', op: 'counts' },
      { object: 'ledger', op: 'counts' },
    ])
    expect(await part.storeCounts(as(OWNER), 'a-call' as never)).toMatchObject({ ok: false, reason: 'bad-request' })
  })

  test('a restart answers done although the object was reset under the call, which is what was asked', async () => {
    const { part, as, operated } = await wired()
    expect(await part.restartStore(as(OWNER), 'workspace')).toEqual({ ok: true, value: { object: 'workspace', restarted: true } })
    expect(operated).toEqual([{ object: 'workspace', op: 'restart' }])
  })

  test('a restore needs a bookmark in Cloudflare’s shape, arms it and then restarts the object; anything else is refused before the object is touched', async () => {
    const { part, as, operated } = await wired()
    for (const bad of ['', 'latest', '../x', 7, undefined]) {
      expect([bad, await part.restoreStore(as(OWNER), 'ledger', bad as never)]).toMatchObject([bad, { ok: false, kind: 'refused', reason: 'bad-request' }])
    }
    expect(operated).toEqual([])
    expect(await part.restoreStore(as(OWNER), 'ledger', BOOKMARK)).toEqual({ ok: true, value: { object: 'ledger', restoring: true } })
    expect(operated).toEqual([
      { object: 'ledger', op: 'restoreTo', arg: BOOKMARK },
      { object: 'ledger', op: 'restart' },
    ])
  })
})

describe('the counts are real numbers of the real tables (WorkspaceDO.counts and RoomDO.counts read these)', () => {
  test('the Workspace object’s: rows of its tables and the phone’s, and people and conversations by kind; nothing of a message, a person or a call', async () => {
    const { h } = await wired()
    // Arrange a channel and a direct message through the core's own door, as teammates would.
    const a = actors(h)
    const idOf = async (email: string): Promise<string> => (await a.tm(email, 'GET', '/bootstrap')).json.me.id
    expect((await a.tm(OWNER, 'POST', '/channels', { name: 'ops', privacy: 'private' })).status).toBe(201)
    expect((await a.tm(OWNER, 'POST', '/dms', { person: await idOf(ANA) })).status).toBe(201)
    const counts = countRows(h.workspaceSql, WORKSPACE_COUNTED.tables, WORKSPACE_COUNTED.grouped)
    expect(counts).toMatchObject({ conversations: 3, 'conversations:channel': 1, 'conversations:dm': 1, 'conversations:phone': 1, 'people:teammate': 2, messages: 0, guest_sessions: 0 })
    // Every counted table is read (the ones the object has not filled are 0), and the answer is numbers under names.
    for (const t of WORKSPACE_COUNTED.tables) expect(typeof counts[t]).toBe('number')
    for (const v of Object.values(counts)) expect(Number.isInteger(v) && v >= 0).toBe(true)
    expect(Object.keys(counts).every((k) => /^[a-z_]+(:[a-z_]+)?$/.test(k))).toBe(true)
    expect(JSON.stringify(counts)).not.toContain('@')
  })

  test('a table the object has not made yet is 0, and the names counted are constants, never a caller’s', () => {
    expect(countRows({ all: () => { throw new Error('no such table') }, run: () => {} }, ['gone'], [{ table: 'gone', by: 'kind' }])).toEqual({ gone: 0 })
    expect([...ROOM_COUNTED]).toEqual(['room', 'members', 'messages', 'calls', 'usage', 'orphans', 'pubs', 'subs'])
    expect([...WORKSPACE_COUNTED.tables]).toContain('guest_sessions')
  })
})
