// The live object (src/live-do.ts) and the decisions it applies (src/live-sockets.ts), driven with fake sockets: who a message reaches, that a frame carries no more than the part and the conversation, who has the
// space open, and that the socket closes when the person's sign-in ends. `cloudflare:workers` and the socket pair exist only in the Workers runtime, so they are stood in for (as worker-exports.test.ts does).
// That a real page's real socket reaches this object through the Worker is a live check after a deploy.
import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { EVERYONE, LIVE_CLOSE_SIGNED_OUT } from '@space/workspace'
import { type LiveAttachment, attachmentOf, audience, nextExpiry, peopleOpen, signInEnded } from '../src/live-sockets'

mock.module('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {},
}))
;(globalThis as Record<string, unknown>).WebSocketRequestResponsePair = class {
  constructor(
    readonly request: string,
    readonly response: string,
  ) {}
}

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)
const HOUR = 3_600_000
const TESSA = 'tessa@northfield.example'
const ANA = 'ana@northfield.example'

class FakeSocket {
  sent: string[] = []
  closed: { code: number; reason: string } | null = null
  constructor(private attachment: LiveAttachment) {}
  deserializeAttachment() {
    return this.attachment
  }
  send(data: string) {
    if (this.closed) throw new Error('closed')
    this.sent.push(data)
  }
  close(code: number, reason: string) {
    this.closed = { code, reason }
  }
}

type LiveObject = {
  fetch(request: Request): Promise<Response>
  tell(raw: unknown): number
  openPeople(): string[]
  webSocketMessage(ws: unknown, message: string): void
  alarm(): Promise<void>
}
let LiveDO: new (ctx: unknown, env: unknown) => LiveObject

beforeAll(async () => {
  LiveDO = ((await import('../src/live-do')) as unknown as { LiveDO: typeof LiveDO }).LiveDO
})

function made(sockets: FakeSocket[]) {
  const alarms: number[] = []
  const auto: unknown[] = []
  const ctx = {
    getWebSockets: () => sockets,
    setWebSocketAutoResponse: (pair: unknown) => void auto.push(pair),
    storage: { setAlarm: async (at: number) => void alarms.push(at) },
  }
  return { object: new LiveDO(ctx, {}), alarms, auto }
}

describe('the decisions', () => {
  const a = (person: string, endsAt: number): LiveAttachment => ({ person, endsAt })

  test('a message reaches the people it is for, and everyone when it is for everyone, and never a socket whose sign-in has ended', () => {
    const open = [a(TESSA, NOW + HOUR), a(TESSA, NOW + HOUR), a(ANA, NOW + HOUR), a('gone@northfield.example', NOW - 1)]
    expect(audience(open, { part: 'mail', people: [TESSA] }, NOW)).toHaveLength(2)
    expect(audience(open, { part: 'documents', people: [TESSA, ANA] }, NOW)).toHaveLength(3)
    expect(audience(open, { part: 'calls', people: EVERYONE }, NOW)).toHaveLength(3)
    expect(audience(open, { part: 'mail', people: ['gone@northfield.example'] }, NOW)).toEqual([])
  })

  test('who has the space open is each person once, on any number of tabs, and not one whose sign-in has ended', () => {
    expect(peopleOpen([a(TESSA, NOW + HOUR), a(TESSA, NOW + 2 * HOUR), a(ANA, NOW - 1)], NOW)).toEqual([TESSA])
    expect(peopleOpen([], NOW)).toEqual([])
  })

  test('the next sign-in to end is the earliest, and a sign-in ends exactly at its time', () => {
    expect(nextExpiry([a(TESSA, NOW + 2 * HOUR), a(ANA, NOW + HOUR)], NOW)).toBe(NOW + HOUR)
    // A sign-in that has ended is the alarm's to close and is not waited for again, so the alarm is never set for the past.
    expect(nextExpiry([a(TESSA, NOW - 1), a(ANA, NOW + HOUR)], NOW)).toBe(NOW + HOUR)
    expect(nextExpiry([a(TESSA, NOW - 1), a(ANA, NOW)], NOW)).toBeNull()
    expect(nextExpiry([], NOW)).toBeNull()
    expect(signInEnded(a(TESSA, NOW), NOW)).toBe(true)
    expect(signInEnded(a(TESSA, NOW + 1), NOW)).toBe(false)
  })

  test('the Worker’s two headers make the attachment; anything missing or wrong makes none', () => {
    const h = (o: Record<string, string>) => new Headers(o)
    expect(attachmentOf(h({ 'x-live-person': ' Tessa@Northfield.example ', 'x-live-ends': String(NOW) }))).toEqual({ person: TESSA, endsAt: NOW })
    for (const bad of [{} as Record<string, string>, { 'x-live-person': TESSA }, { 'x-live-ends': String(NOW) }, { 'x-live-person': TESSA, 'x-live-ends': 'soon' }, { 'x-live-person': TESSA, 'x-live-ends': '0' }]) {
      expect([bad, attachmentOf(h(bad))]).toEqual([bad, null])
    }
  })
})

describe('the object', () => {
  test('the page’s ping is answered by the runtime, without waking the object', () => {
    const { auto } = made([])
    expect(auto).toEqual([{ request: 'ping', response: 'pong' }])
  })

  test('tells the pages of the people a message names, a frame with the part and the conversation and nothing more', () => {
    const tessa = new FakeSocket({ person: TESSA, endsAt: Date.now() + HOUR })
    const ana = new FakeSocket({ person: ANA, endsAt: Date.now() + HOUR })
    const { object } = made([tessa, ana])
    expect(object.tell({ part: 'chat', people: [ANA], conversation: 'chat:channel:3' })).toBe(1)
    expect(tessa.sent).toEqual([])
    expect(JSON.parse(ana.sent[0] as string)).toEqual({ t: 'changed', part: 'chat', conversation: 'chat:channel:3' })
    expect(ana.sent[0]).not.toContain('northfield.example')
    expect(object.tell({ part: 'calls', people: EVERYONE })).toBe(2)
  })

  test('a message that is not one tells no one and never throws: the stores do not wait on it', () => {
    const tessa = new FakeSocket({ person: TESSA, endsAt: Date.now() + HOUR })
    const { object } = made([tessa])
    for (const bad of [null, 'mail', {}, { part: 'weather', people: [TESSA] }, { part: 'mail', people: 'all' }]) expect(object.tell(bad)).toBe(0)
    expect(tessa.sent).toEqual([])
  })

  test('a socket that is closing does not stop the others hearing', () => {
    const closing = new FakeSocket({ person: TESSA, endsAt: Date.now() + HOUR })
    closing.closed = { code: 1000, reason: 'bye' }
    const open = new FakeSocket({ person: TESSA, endsAt: Date.now() + HOUR })
    const { object } = made([closing, open])
    expect(object.tell({ part: 'mail', people: [TESSA] })).toBe(1)
    expect(open.sent).toHaveLength(1)
  })

  test('says who has the space open, for meet’s nudge rule', () => {
    const { object } = made([new FakeSocket({ person: TESSA, endsAt: Date.now() + HOUR }), new FakeSocket({ person: TESSA, endsAt: Date.now() + HOUR }), new FakeSocket({ person: ANA, endsAt: Date.now() + HOUR })])
    expect(object.openPeople().sort()).toEqual([ANA, TESSA])
  })

  test('the socket closes when the sign-in ends: the alarm cuts it off and a frame from it is answered the same way, and the others stay', async () => {
    const ended = new FakeSocket({ person: TESSA, endsAt: Date.now() - 1 })
    const live = new FakeSocket({ person: ANA, endsAt: Date.now() + HOUR })
    const { object, alarms } = made([ended, live])
    await object.alarm()
    expect(ended.closed).toEqual({ code: LIVE_CLOSE_SIGNED_OUT, reason: 'Your sign-in ended.' })
    expect(live.closed).toBeNull()
    // The alarm is set again for the next sign-in to end.
    expect(alarms).toHaveLength(1)
    const stale = new FakeSocket({ person: TESSA, endsAt: Date.now() - 1 })
    made([stale]).object.webSocketMessage(stale, 'anything')
    expect(stale.closed?.code).toBe(LIVE_CLOSE_SIGNED_OUT)
    const fresh = new FakeSocket({ person: TESSA, endsAt: Date.now() + HOUR })
    made([fresh]).object.webSocketMessage(fresh, 'anything')
    expect(fresh.closed).toBeNull()
  })

  test('a request that is not a socket upgrade, or that lacks the Worker’s headers, is refused', async () => {
    const { object } = made([])
    expect((await object.fetch(new Request('https://space.northfield.example/api/live'))).status).toBe(426)
    const noHeaders = new Request('https://space.northfield.example/api/live', { headers: { upgrade: 'websocket' } })
    expect((await object.fetch(noHeaders)).status).toBe(400)
    // A sign-in that has already ended opens nothing (the alarm only waits for ones that have not).
    const ended = new Request('https://space.northfield.example/api/live', { headers: { upgrade: 'websocket', 'x-live-person': TESSA, 'x-live-ends': String(Date.now() - 1000) } })
    expect((await object.fetch(ended)).status).toBe(401)
  })
})
