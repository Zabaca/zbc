// The page's one live connection: a fake socket and fake timers stand in for the browser's, so what is asserted is what the screens are told
// (a part moved, or the connection came back after a gap) and what the connection sends. That the real socket reaches the real live object through the real Worker is a live check after a deploy,
// which no test runtime can make.
import { describe, expect, test } from 'bun:test'
import type { LivePart } from '@space/workspace'
import { CLOSE_SIGNED_OUT, DEBOUNCE_MS, KEEPALIVE_MS, LiveHub, type LiveEvent, LiveLink, type LiveStatus, type SocketLike, backoffMs, readsOpen, socketUrl } from '../src/client/live'

class FakeSocket implements SocketLike {
  readyState = 0
  sent: string[] = []
  closed: { code?: number } | null = null
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data)
  }
  close(code?: number) {
    this.closed = { code }
    this.readyState = 3
  }
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  say(frame: unknown) {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) })
  }
  drop(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

function rig() {
  const sockets: FakeSocket[] = []
  const timers: { fn: () => void; ms: number; live: boolean }[] = []
  const statuses: LiveStatus[] = []
  const told: { part: LivePart; conversation?: string }[] = []
  let reconnected = 0
  const link = new LiveLink({
    open: (url) => {
      const s = new FakeSocket(url)
      sockets.push(s)
      return s
    },
    page: { protocol: 'https:', host: 'space.northfield.example' },
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      ;(t as { live: boolean }).live = false
    },
    told: (f) => void told.push(f),
    reconnected: () => void reconnected++,
    status: (s) => void statuses.push(s),
  })
  const fire = (ms: number) => {
    const t = timers.find((x) => x.live && x.ms === ms)
    if (!t) throw new Error(`no timer of ${ms}ms`)
    t.live = false
    t.fn()
  }
  return { link, sockets, timers, statuses, told, reconnected: () => reconnected, fire }
}

const CHAT = { t: 'changed', part: 'chat', conversation: 'chat:channel:3' }

describe('the address the socket is opened at', () => {
  test('is the page’s own host at the live socket’s path, wss on https', () => {
    expect(socketUrl({ protocol: 'https:', host: 'space.northfield.example' })).toBe('wss://space.northfield.example/api/live')
    expect(socketUrl({ protocol: 'http:', host: 'localhost:4838' })).toBe('ws://localhost:4838/api/live')
  })

  test('a dropped socket tries again after 1, 2, 4, 8, 16 seconds, then every 30', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000])
  })
})

describe('the connection', () => {
  test('opens at once with no ticket (the Worker checks the person on this request), and passes on what a frame says', () => {
    const r = rig()
    r.link.start()
    expect(r.sockets).toHaveLength(1)
    expect(r.sockets[0]!.url).toBe('wss://space.northfield.example/api/live')
    r.sockets[0]!.open()
    expect(r.statuses).toEqual(['connecting', 'open'])
    r.sockets[0]!.say(CHAT)
    r.sockets[0]!.say({ t: 'changed', part: 'mail' })
    expect(r.told).toEqual([{ part: 'chat', conversation: 'chat:channel:3' }, { part: 'mail' }])
  })

  test('the first time it opens is not a gap: nothing is read again for it', () => {
    const r = rig()
    r.link.start()
    r.sockets[0]!.open()
    expect(r.reconnected()).toBe(0)
  })

  test('a pong, a stray string, a part this build does not know and a frame that is not one tell no one', () => {
    const r = rig()
    r.link.start()
    r.sockets[0]!.open()
    for (const other of ['pong', 'not json', { t: 'changed', part: 'weather' }, { t: 'hello' }, null]) r.sockets[0]!.say(other)
    expect(r.told).toEqual([])
  })

  test('a drop is retried after the backoff, and when it is open again the screens are told to read everything on view, because a message may have been missed', () => {
    const r = rig()
    r.link.start()
    r.sockets[0]!.open()
    r.sockets[0]!.drop(1006)
    expect(r.statuses.at(-1)).toBe('reconnecting')
    r.fire(1000)
    expect(r.sockets).toHaveLength(2)
    expect(r.reconnected()).toBe(0)
    r.sockets[1]!.open()
    expect(r.reconnected()).toBe(1)
    expect(r.statuses.at(-1)).toBe('open')
    // A later quiet stretch is not a gap.
    r.sockets[1]!.say(CHAT)
    expect(r.reconnected()).toBe(1)
  })

  test('a connection that failed to open at all, then opens, reads everything too', () => {
    const r = rig()
    r.link.start()
    r.sockets[0]!.drop(1006) // never opened
    r.fire(1000)
    r.sockets[1]!.open()
    expect(r.reconnected()).toBe(1)
  })

  test('before it has ever opened (no live object here) it stays quiet: not "reconnecting", and no read for each try', () => {
    const r = rig()
    r.link.start()
    r.sockets[0]!.drop(1006)
    expect(r.statuses).toEqual(['connecting', 'off'])
    r.fire(1000)
    r.sockets[1]!.drop(1006)
    expect(r.statuses.every((s) => s !== 'reconnecting')).toBe(true)
    expect(r.reconnected()).toBe(0)
  })

  test('a sign-in that ended goes quiet and does not retry', () => {
    const r = rig()
    r.link.start()
    r.sockets[0]!.open()
    r.sockets[0]!.drop(CLOSE_SIGNED_OUT)
    expect(r.statuses.at(-1)).toBe('off')
    expect(r.timers.some((t) => t.live && t.ms !== KEEPALIVE_MS)).toBe(false)
  })

  test('coming back to the page while a socket is open or connecting makes no second one; while it is down, tries now rather than wait out the backoff', () => {
    const r = rig()
    r.link.start()
    r.link.wake()
    r.link.wake()
    expect(r.sockets).toHaveLength(1)
    r.sockets[0]!.open()
    r.link.wake()
    expect(r.sockets).toHaveLength(1)
    expect(r.timers.filter((t) => t.live && t.ms === KEEPALIVE_MS)).toHaveLength(1)
    r.sockets[0]!.drop(1006)
    r.link.wake()
    expect(r.sockets).toHaveLength(2)
    // the backoff timer that was waiting is cancelled, so it does not make a third
    expect(r.timers.filter((t) => t.live && t.ms === 1000)).toHaveLength(0)
  })

  test('an older socket closing does not stop the newer one’s ping, and a late frame from a socket let go says nothing', () => {
    const r = rig()
    r.link.start()
    r.sockets[0]!.open()
    r.sockets[0]!.drop(1006)
    r.fire(1000)
    r.sockets[1]!.open()
    r.sockets[0]!.onclose?.({ code: 1006 })
    expect(r.timers.filter((t) => t.live && t.ms === KEEPALIVE_MS)).toHaveLength(1)
    r.sockets[0]!.say(CHAT)
    expect(r.told).toEqual([])
  })

  test('it keeps the connection from going quiet with a ping every thirty seconds, and stops everything when the page leaves', () => {
    const r = rig()
    r.link.start()
    r.sockets[0]!.open()
    r.fire(KEEPALIVE_MS)
    expect(r.sockets[0]!.sent.at(-1)).toBe('ping')
    r.link.stop()
    expect(r.sockets[0]!.closed?.code).toBe(1000)
    expect(r.timers.some((t) => t.live)).toBe(false)
    r.sockets[0]!.say(CHAT)
    expect(r.told).toEqual([])
  })
})

describe('which screens a frame is for', () => {
  function hubRig() {
    const timers: { fn: () => void; ms: number; live: boolean }[] = []
    const hub = new LiveHub({
      setTimer: (fn, ms) => {
        const t = { fn, ms, live: true }
        timers.push(t)
        return t
      },
      clearTimer: (t) => {
        ;(t as { live: boolean }).live = false
      },
    })
    const calls = (parts: LivePart[]) => {
      const got: LiveEvent[] = []
      const stop = hub.subscribe(parts, (e) => void got.push(e))
      return { got, stop }
    }
    const settle = () => {
      for (const t of timers.filter((x) => x.live)) {
        t.live = false
        t.fn()
      }
    }
    return { hub, calls, settle, timers }
  }

  test('only the screens that draw the part are called, and the ones that do not are not read at all', () => {
    const { hub, calls, settle } = hubRig()
    const list = calls(['mail'])
    const today = calls(['mail', 'chat', 'calls', 'documents'])
    const knowledge = calls(['knowledge'])
    const forms = calls(['documents'])
    hub.told({ part: 'mail' })
    settle()
    expect(list.got).toEqual([{ part: 'mail', named: null }])
    expect(today.got).toEqual([{ part: 'mail', named: null }])
    expect(knowledge.got).toEqual([])
    expect(forms.got).toEqual([])
    hub.told({ part: 'knowledge' })
    settle()
    expect(knowledge.got).toEqual([{ part: 'knowledge', named: null }])
    expect(list.got).toHaveLength(1)
  })

  test('a screen is told what the message named, and reads its open conversation again only if that is it or if none was named', () => {
    const { hub, calls, settle } = hubRig()
    const chat = calls(['chat'])
    hub.told({ part: 'chat', conversation: 'chat:channel:3' })
    settle()
    const named = chat.got.at(-1)!
    expect(named.named).toEqual(new Set(['chat:channel:3']))
    expect(readsOpen(named, 'chat:channel:3')).toBe(true)
    expect(readsOpen(named, 'chat:channel:4')).toBe(false)
    expect(readsOpen(named, null)).toBe(false)
    hub.told({ part: 'chat' })
    settle()
    const none = chat.got.at(-1)!
    expect(none.named).toBeNull()
    expect(readsOpen(none, 'chat:channel:4')).toBe(true)
    expect(readsOpen(none, null)).toBe(false) // nothing open, nothing to read
  })

  test('a burst is one call: two conversations named and one that names none within the wait is a call that names none', () => {
    const { hub, calls, settle } = hubRig()
    const chat = calls(['chat'])
    hub.told({ part: 'chat', conversation: 'chat:channel:3' })
    hub.told({ part: 'chat', conversation: 'chat:channel:4' })
    settle()
    expect(chat.got).toHaveLength(1)
    expect(chat.got[0]!.named).toEqual(new Set(['chat:channel:3', 'chat:channel:4']))
    hub.told({ part: 'chat', conversation: 'chat:channel:3' })
    hub.told({ part: 'chat' })
    settle()
    expect(chat.got).toHaveLength(2)
    expect(chat.got[1]!.named).toBeNull()
  })

  test('the wait is short, and a message that arrives inside it does not start another', () => {
    const { hub, calls, timers } = hubRig()
    calls(['mail'])
    hub.told({ part: 'mail' })
    hub.told({ part: 'mail' })
    expect(timers.filter((t) => t.live)).toHaveLength(1)
    expect(timers[0]!.ms).toBe(DEBOUNCE_MS)
  })

  test('when the connection comes back every screen is called, whatever it draws, with nothing named', () => {
    const { hub, calls, settle } = hubRig()
    const list = calls(['mail'])
    const knowledge = calls(['knowledge'])
    hub.everything()
    settle()
    expect(list.got).toEqual([{ part: null, named: null }])
    expect(knowledge.got).toEqual([{ part: null, named: null }])
  })

  test('a screen that has gone is not called, even by a message already waiting', () => {
    const { hub, calls, settle } = hubRig()
    const list = calls(['mail'])
    hub.told({ part: 'mail' })
    list.stop()
    settle()
    expect(list.got).toEqual([])
  })

  test('the status is held for the screen that says whether chat is live, and it is told when it changes', () => {
    const { hub } = hubRig()
    let heard = 0
    const stop = hub.onStatus(() => void heard++)
    hub.setStatus('open')
    hub.setStatus('open')
    hub.setStatus('reconnecting')
    expect([hub.status, heard]).toEqual(['reconnecting', 2])
    stop()
    hub.setStatus('off')
    expect(heard).toBe(2)
  })
})
