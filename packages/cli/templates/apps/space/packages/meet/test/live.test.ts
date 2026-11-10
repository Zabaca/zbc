// What meet tells the space's live object: which teammates are told of a change and under which conversation key, that guests are not told this
// way, who counts as having the space open for the nudge rule, and when a call's object tells. The core is the real one over a real SQLite (test/helpers.ts); the recorded effects are what the object's adapter
// would be handed after each call, and `chatMessages` is what it turns them into.
import { Database } from 'bun:sqlite'
import { describe, expect, mock, test } from 'bun:test'
import { EVERYONE } from '@space/workspace'
import { shouldTell } from '../src/room-live'
import { chatMessages } from '../src/workspace-live'
import { ANA, BEN, OWNER, harness } from './helpers'
import { actors } from './workspace.helpers'

async function setup() {
  const h = await harness({ devBypass: false })
  const a = actors(h)
  const idOf = async (email: string): Promise<string> => (await a.tm(email, 'GET', '/bootstrap')).json.me.id
  const channel = async (by: string, name: string, privacy: 'open' | 'private' = 'private'): Promise<number> => (await a.tm(by, 'POST', '/channels', { name, privacy })).json.conversation.id
  const say = async (by: string, conv: number, text: string): Promise<number> => (await a.tm(by, 'POST', `/conversations/${conv}/messages`, { text })).json.message.id
  const messages = () =>
    chatMessages(
      h.delivered.map((d) => ({ t: 'deliver', people: d.people, change: d.change })),
      (people, conv) => h.workspaceCore.liveTargets(people, conv),
    )
  return { h, a, idOf, channel, say, messages }
}

describe('what a change tells', () => {
  test('a message in a private channel tells the channel’s teammates, under the channel’s key, and no one else', async () => {
    const s = await setup()
    const ops = await s.channel(OWNER, 'ops')
    const ana = await s.idOf(ANA)
    expect((await s.a.tm(OWNER, 'POST', `/channels/${ops}/members`, { person: ana })).status).toBeLessThan(300)
    s.h.delivered.length = 0
    await s.say(OWNER, ops, 'hello')
    const told = s.messages()
    expect(told).toEqual([{ part: 'chat', people: expect.arrayContaining([OWNER, ANA]), conversation: `chat:channel:${ops}` }])
    expect(told[0]?.people).not.toContain(BEN)
    // Nothing of the message rides in it.
    expect(JSON.stringify(told)).not.toContain('hello')
  })

  test('a direct message tells each of its two people under the key of the OTHER person, as their page opens it', async () => {
    const s = await setup()
    const ana = await s.idOf(ANA)
    const owner = await s.idOf(OWNER)
    const dm = (await s.a.tm(OWNER, 'POST', '/dms', { person: ana })).json.conversation.id as number
    s.h.delivered.length = 0
    await s.say(OWNER, dm, 'a word')
    const told = s.messages()
    expect(told).toHaveLength(2)
    expect(told).toContainEqual({ part: 'chat', people: [OWNER], conversation: `chat:${ana}` })
    expect(told).toContainEqual({ part: 'chat', people: [ANA], conversation: `chat:${owner}` })
  })

  test('a channel guest is not told this way: they keep their own socket, and only teammates are named', async () => {
    const s = await setup()
    const ops = await s.channel(OWNER, 'ops')
    const invited = await s.a.tm(OWNER, 'POST', `/channels/${ops}/invite`, { email: 'dana@harbordental.example', name: 'Dana Reyes' })
    expect(invited.status).toBeLessThan(300)
    s.h.delivered.length = 0
    await s.say(OWNER, ops, 'hello Dana')
    // The guest is among the people the adapter pushes to on their socket...
    expect(s.h.delivered.flatMap((d) => d.people).length).toBeGreaterThan(1)
    // ...and not among those the live object is told.
    const people = s.messages().flatMap((m) => (m.people === EVERYONE ? [] : [...m.people]))
    expect(people).toEqual([OWNER])
  })

  test('a burst in one conversation is one message to each person, not one each', async () => {
    const s = await setup()
    const ops = await s.channel(OWNER, 'ops')
    s.h.delivered.length = 0
    await s.say(OWNER, ops, 'one')
    await s.say(OWNER, ops, 'two')
    await s.say(OWNER, ops, 'three')
    expect(s.messages()).toEqual([{ part: 'chat', people: [OWNER], conversation: `chat:channel:${ops}` }])
  })
})

describe('the nudge rule asks who has the space open', () => {
  /** Tessa writes Ana a direct message that waits 16 minutes unread. */
  async function waiting() {
    const s = await setup()
    const ana = await s.idOf(ANA)
    const dm = (await s.a.tm(OWNER, 'POST', '/dms', { person: ana })).json.conversation.id as number
    await s.say(OWNER, dm, 'a very private sentence')
    s.h.clock.now += 16 * 60_000
    return { s, ana }
  }

  test('a teammate with the space open on any tab is not nudged, and is again when they close it', async () => {
    const { s } = await waiting()
    expect(s.h.workspaceCore.dueNudges(s.h.clock.now, [])).toHaveLength(1)
    expect(s.h.workspaceCore.dueNudges(s.h.clock.now, [], [ANA])).toEqual([])
    expect(s.h.workspaceCore.dueNudges(s.h.clock.now, [], [ANA.toUpperCase()])).toEqual([])
    expect(s.h.workspaceCore.dueNudges(s.h.clock.now, [], [BEN])).toHaveLength(1)
    expect(s.h.workspaceCore.dueNudges(s.h.clock.now, [], [])).toHaveLength(1)
  })

  test('the sweep asks the same question, and a guest’s own socket still counts as before', async () => {
    const { s, ana } = await waiting()
    expect(s.h.workspaceCore.sweep(s.h.clock.now, [], [ANA])).toEqual([])
    expect(s.h.workspaceCore.sweep(s.h.clock.now, [ana], [])).toEqual([])
    expect(s.h.workspaceCore.sweep(s.h.clock.now, [], [])).toHaveLength(1)
  })
})

describe('the objects, as the runtime holds them', () => {
  // `cloudflare:workers` and the socket auto-response exist only in the Workers runtime: stood in for here, with the real classes over a real SQLite.
  mock.module('cloudflare:workers', () => ({
    DurableObject: class {
      constructor(
        readonly ctx: unknown,
        readonly env: unknown,
      ) {}
    },
  }))
  ;(globalThis as Record<string, unknown>).WebSocketRequestResponsePair = class {}

  type Told = { part: string; people: unknown; conversation?: string }
  const settle = () => new Promise((r) => setTimeout(r, 0))

  /** An object's storage over bun:sqlite, as `ctx.storage.sql.exec(...).toArray()`. */
  function storage(alarms: number[] = []) {
    const db = new Database(':memory:')
    return {
      sql: {
        exec: (q: string, ...p: unknown[]) => {
          // The schema is several statements in one call, which the real storage runs whole; a query is one.
          if (p.length === 0 && /;\s*\S/.test(q)) {
            db.exec(q)
            return { toArray: () => [] }
          }
          const rows = db.query(q).all(...(p as never[]))
          return { toArray: () => rows }
        },
      },
      getAlarm: async () => null,
      setAlarm: async (at: number) => void alarms.push(at),
    }
  }
  /** A live object that records what it is told and answers who has the space open. */
  function live(open: string[] = []) {
    const told: Told[] = []
    const asked = { n: 0 }
    return { told, asked, ns: { idFromName: (n: string) => n, get: () => ({ tell: (m: Told) => void told.push(m), openPeople: async () => (asked.n++, open) }) } }
  }

  test('the Workspace object tells the live object after a change, and asks it who is on the space before it says who is owed a nudge', async () => {
    const { WorkspaceDO } = (await import('../src/workspace-do')) as unknown as { WorkspaceDO: new (ctx: unknown, env: unknown) => { invoke(m: string, a: unknown[]): Promise<{ ok: boolean; value?: any }>; ctx: unknown } }
    const l = live([OWNER, ANA])
    const object = new WorkspaceDO({ storage: storage(), setWebSocketAutoResponse: () => {}, getWebSockets: () => [] }, { LIVE: l.ns })
    // An empty workspace has nobody to be owed a nudge; the question is answered, with the live object consulted and nothing told.
    const swept = await object.invoke('sweep', [Date.now()])
    expect(swept.ok).toBe(true)
    expect(swept.value).toEqual([])
    expect(l.asked.n).toBe(1)
    await settle()
    expect(l.told).toEqual([])
  })

  test('a Workspace object with no live object bound answers as it did, and a live object that is down or slow does not hold it up', async () => {
    const { WorkspaceDO } = (await import('../src/workspace-do')) as unknown as { WorkspaceDO: new (ctx: unknown, env: unknown) => { invoke(m: string, a: unknown[]): Promise<{ ok: boolean; value?: any }> } }
    const ctx = { storage: storage(), setWebSocketAutoResponse: () => {}, getWebSockets: () => [] }
    expect((await new WorkspaceDO(ctx, {}).invoke('sweep', [Date.now()])).ok).toBe(true)
    const quiet = console.warn
    console.warn = () => {}
    try {
      const down = { idFromName: () => 'live', get: () => ({ tell: () => { throw new Error('down') }, openPeople: () => Promise.reject(new Error('down')) }) }
      const started = Date.now()
      expect((await new WorkspaceDO(ctx, { LIVE: down }).invoke('sweep', [Date.now()])).ok).toBe(true)
      expect(Date.now() - started).toBeLessThan(1000)
    } finally {
      console.warn = quiet
    }
  })

  type Room = { invoke(m: string, a: unknown[]): { ok: boolean; value?: any }; alarm(): Promise<void> }
  const CALL = 'k7m2qx9frtn4w6hbc8jd'
  const flags = { muted: false, cameraOff: false }
  async function call() {
    const { RoomDO } = (await import('../src/do')) as unknown as { RoomDO: new (ctx: unknown, env: unknown) => Room }
    const l = live()
    const alarms: number[] = []
    const object = new RoomDO({ storage: storage(alarms), id: { name: CALL } }, { LIVE: l.ns })
    return { object, l, alarms }
  }

  test('a call’s object tells that calls moved when it is made, when someone joins and when they leave, and not for a read or a heartbeat that changed nothing', async () => {
    const { object, l } = await call()
    const now = Date.now()
    expect(object.invoke('create', [CALL, now]).ok).toBe(true)
    await settle()
    expect(l.told).toEqual([{ part: 'calls', people: EVERYONE }])
    // The call's name (its link) is nowhere in what was told.
    expect(JSON.stringify(l.told)).not.toContain('k7m2')
    l.told.length = 0
    object.invoke('info', [now])
    const ana = object.invoke('join', ['ha', 'ma', 'Ana', now, null])
    await settle()
    expect(l.told).toHaveLength(1) // the join; the read told nothing
    l.told.length = 0
    object.invoke('checkIn', ['ha', ana.value.generation, flags, now + 5000])
    await settle()
    expect(l.told).toEqual([])
    object.invoke('leave', ['ha', ana.value.generation, now + 6000])
    await settle()
    expect(l.told).toHaveLength(1)
  })

  test('a person who drops out of a call by going quiet is reported when the next call to the object drops them', async () => {
    const { object, l } = await call()
    const now = Date.now()
    object.invoke('create', [CALL, now])
    const ana = object.invoke('join', ['ha', 'ma', 'Ana', now, null])
    const ben = object.invoke('join', ['hb', 'mb', 'Ben', now, null])
    await settle()
    l.told.length = 0
    // Ana goes quiet; Ben's heartbeat 40 seconds on is what drops her (the call reaps), and that is a change.
    object.invoke('checkIn', ['hb', ben.value.generation, flags, now + 20_000])
    object.invoke('checkIn', ['hb', ben.value.generation, flags, now + 40_000])
    await settle()
    expect(l.told).toEqual([{ part: 'calls', people: EVERYONE }])
    expect(ana.ok).toBe(true)
  })

  test('the last person to go quiet is dropped and reported by the alarm, since no call to the object follows', async () => {
    const { object, l, alarms } = await call()
    const quiet = Date.now() - 60_000 // last heard of a minute ago
    object.invoke('create', [CALL, quiet])
    object.invoke('join', ['ha', 'ma', 'Ana', quiet, null])
    await settle()
    // Joining set the alarm for when she would be dropped, and not before the soonest the runtime allows.
    expect(alarms).toHaveLength(1)
    expect(alarms[0]).toBeGreaterThanOrEqual(Date.now())
    l.told.length = 0
    await object.alarm()
    await settle()
    expect(l.told).toEqual([{ part: 'calls', people: EVERYONE }])
    // Nobody is left: the alarm does not set itself again.
    expect(alarms).toHaveLength(1)
    // And a second alarm finds nothing to change and tells no one.
    l.told.length = 0
    await object.alarm()
    await settle()
    expect(l.told).toEqual([])
  })

  test('the alarm for a person still present sets itself again, and drops and tells no one', async () => {
    const { object, l, alarms } = await call()
    const now = Date.now()
    object.invoke('create', [CALL, now])
    object.invoke('join', ['ha', 'ma', 'Ana', now, null])
    await settle()
    l.told.length = 0
    await object.alarm()
    await settle()
    expect(l.told).toEqual([])
    expect(alarms).toHaveLength(2)
  })
})

describe('when a call tells', () => {
  test('a new call always does; a join or leave does when the count moved; a heartbeat only when it dropped someone; nothing else does', () => {
    expect(shouldTell('create', null, 0)).toBe(true)
    expect(shouldTell('join', 0, 1)).toBe(true)
    expect(shouldTell('join', 1, 1)).toBe(false) // the same person coming back
    expect(shouldTell('leave', 2, 1)).toBe(true)
    expect(shouldTell('checkIn', 2, 2)).toBe(false)
    expect(shouldTell('checkIn', 2, 1)).toBe(true) // someone reaped as gone
    for (const m of ['chat', 'summary', 'history', 'recordCall', 'planPublish', 'addUsage']) expect(shouldTell(m, 1, 0), m).toBe(false)
  })
})
