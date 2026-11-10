// Seam 2: the browser's pure logic. No page, no media.
import { describe, expect, test } from 'bun:test'
import { linkify, mergeMessages, rememberMine, unreadCount } from '../src/web/call/chat'
import { checkInFailure } from '../src/web/call/checkin'
import { SerialQueue } from '../src/web/call/queue'
import { sendPlan } from '../src/web/call/quality'
import { type Pub, keyOf, reconcile } from '../src/web/call/reconcile'
import { parseRoute } from '../src/web/route'
import { displayName, qualityFor } from '../src/model'
import type { ChatMessage, Snapshot } from '../src/model'

const snap = (members: Array<{ id: string; pub: Array<[Pub['kind'], number]> }>): Snapshot => ({
  revision: 1,
  count: members.length,
  cap: 8,
  quality: qualityFor(members.length),
  members: members.map((m) => ({
    id: m.id,
    name: m.id,
    muted: false,
    cameraOff: false,
    publishing: m.pub.map(([kind, v]) => ({ kind, v })),
  })),
})

describe('the reconciler', () => {
  test('subscribes to everything others publish, never to yourself, and lets go of what has gone', () => {
    const s = snap([
      {
        id: 'me',
        pub: [
          ['camera', 1],
          ['mic', 2],
        ],
      },
      {
        id: 'ana',
        pub: [
          ['camera', 1],
          ['mic', 2],
        ],
      },
      { id: 'ben', pub: [['mic', 1]] },
    ])
    const held: Pub[] = [
      { memberId: 'ana', kind: 'camera', v: 1 },
      { memberId: 'cy', kind: 'camera', v: 1 }, // cy has left
      { memberId: 'ben', kind: 'screen', v: 3 }, // ben stopped sharing
    ]
    const r = reconcile(s, 'me', held)
    expect(r.subscribe).toEqual([
      { memberId: 'ana', kind: 'mic', v: 2 },
      { memberId: 'ben', kind: 'mic', v: 1 },
    ])
    expect(r.unsubscribe).toEqual([
      { memberId: 'cy', kind: 'camera', v: 1 },
      { memberId: 'ben', kind: 'screen', v: 3 },
    ])
  })

  test('a share that stopped and started again is a new publication: the old one goes, the new one comes', () => {
    const r = reconcile(snap([{ id: 'ana', pub: [['screen', 7]] }]), 'me', [{ memberId: 'ana', kind: 'screen', v: 4 }])
    expect(r.subscribe).toEqual([{ memberId: 'ana', kind: 'screen', v: 7 }])
    expect(r.unsubscribe).toEqual([{ memberId: 'ana', kind: 'screen', v: 4 }])
  })

  test('nothing to do when the call is as pulled in, and duplicates in the list are asked for once', () => {
    const s = snap([
      {
        id: 'ana',
        pub: [
          ['camera', 1],
          ['camera', 1],
        ],
      },
    ])
    expect(reconcile(s, 'me', [{ memberId: 'ana', kind: 'camera', v: 1 }])).toEqual({ subscribe: [], unsubscribe: [] })
    expect(reconcile(s, 'me', []).subscribe).toHaveLength(1)
    expect(keyOf({ memberId: 'ana', kind: 'camera', v: 1 })).toBe('ana:camera:1')
  })
})

describe("a connection's queue", () => {
  test('holds the next request until the earlier one, answer and all, has finished', async () => {
    const q = new SerialQueue()
    const log: string[] = []
    let acceptAnswer!: () => void
    const answered = new Promise<void>((r) => (acceptAnswer = r))
    const first = q.run(async () => {
      log.push('subscribe sent')
      await answered // the SFU's offer is applied and our answer sent
      log.push('answer accepted')
    })
    const second = q.run(async () => {
      log.push('next request sent')
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(log).toEqual(['subscribe sent'])
    acceptAnswer()
    await Promise.all([first, second])
    expect(log).toEqual(['subscribe sent', 'answer accepted', 'next request sent'])
  })

  test('a failed job does not stop the queue and still reports its own failure', async () => {
    const q = new SerialQueue()
    const bad = q.run(async () => {
      throw new Error('406')
    })
    const good = q.run(async () => 'ok')
    await expect(bad).rejects.toThrow('406')
    expect(await good).toBe('ok')
    await q.idle()
    expect(q.size).toBe(0)
  })
})

describe('the quality step', () => {
  test('is full up to 4 people and low from 5, and the sender is told to match', () => {
    expect([1, 4, 5, 8].map(qualityFor)).toEqual(['full', 'full', 'low', 'low'])
    expect(sendPlan('camera', 'full', { width: 1280, height: 720 })).toEqual({
      maxBitrate: 1_000_000,
      maxFramerate: 30,
      scaleResolutionDownBy: 1,
    })
    expect(sendPlan('camera', 'low', { width: 1280, height: 720 })).toEqual({
      maxBitrate: 400_000,
      maxFramerate: 24,
      scaleResolutionDownBy: 2,
    })
    // A camera that cannot reach 720p is never scaled up.
    expect(sendPlan('camera', 'full', { width: 640, height: 480 })?.scaleResolutionDownBy).toBe(1)
  })

  test('a share is capped at 1.5 Mbps and 15 frames a second, and sound is left alone', () => {
    expect(sendPlan('screen', 'low', { width: 2560, height: 1440 })).toEqual({
      maxBitrate: 1_500_000,
      maxFramerate: 15,
      scaleResolutionDownBy: 1,
    })
    expect(sendPlan('mic', 'full', { width: 0, height: 0 })).toBeNull()
  })
})

describe('the link', () => {
  const name = 'k7m2qx9frtn4w6hbc8jd'
  test('a call link parses whatever its grouping or case', () => {
    expect(parseRoute(`/r/${name}`, '')).toMatchObject({ view: 'call', name, forceRelay: false })
    expect(parseRoute(`/r/${displayName(name).toUpperCase()}`, '')).toMatchObject({ view: 'call', name })
    expect(parseRoute(`/r/${displayName(name)}/`, '?relay=1')).toMatchObject({ view: 'call', name, forceRelay: true })
  })
  test('?debug=1 turns the diagnostics panel on, and nothing else does', () => {
    expect(parseRoute(`/r/${name}`, '?debug=1')).toMatchObject({ view: 'call', debug: true })
    expect(parseRoute(`/r/${name}`, '?relay=1&debug=1')).toMatchObject({ forceRelay: true, debug: true })
    expect(parseRoute(`/r/${name}`, '')).toMatchObject({ debug: false })
    expect(parseRoute(`/r/${name}`, '?debug=true')).toMatchObject({ debug: false })
  })
  test('anything else is the home page, and /start is no page of meet’s (the Worker redirects it before the page is asked for)', () => {
    expect(parseRoute('/r/short', '').view).toBe('home')
    expect(parseRoute('/r/%E0%A4%A', '').view).toBe('home')
    expect(parseRoute('/', '').view).toBe('home')
    expect(parseRoute('/start', '').view).toBe('home')
    expect(parseRoute('/start/', '').view).toBe('home')
    expect(parseRoute('/w', '').view).toBe('guest')
  })
})

describe('a failed check-in', () => {
  test("one sent before the tab's own reconnect is stale, also while the join reply has not come back and the generation has not moved", () => {
    // The server has bumped the generation, the tab has not heard yet: sent and current are still equal.
    expect(checkInFailure(409, 1, 1, true)).toBe('ignore')
    expect(checkInFailure(401, 1, 1, true)).toBe('ignore')
    expect(checkInFailure(null, 1, 1, true)).toBe('ignore')
    // And after the reply, when the generation has moved.
    expect(checkInFailure(409, 1, 2, false)).toBe('ignore')
  })

  test('on the current connection: 409 ends the call, 401 takes the seat again, anything else is counted', () => {
    expect(checkInFailure(409, 3, 3, false)).toBe('end')
    expect(checkInFailure(401, 3, 3, false)).toBe('reconnect')
    expect(checkInFailure(500, 3, 3, false)).toBe('count')
    expect(checkInFailure(null, 3, 3, false)).toBe('count')
  })
})

describe('links in chat', () => {
  const joined = (text: string) =>
    linkify(text)
      .map((p) => p.text)
      .join('')
  const links = (text: string) => linkify(text).flatMap((p) => (p.kind === 'link' ? [p.href] : []))

  test('an http or https address becomes a link, and the parts always add back up to the message', () => {
    const text = 'see https://example.com/a?b=1&c=2#d and http://localhost:4812/r/x ok'
    expect(links(text)).toEqual(['https://example.com/a?b=1&c=2#d', 'http://localhost:4812/r/x'])
    expect(joined(text)).toBe(text)
    expect(linkify('no links here')).toEqual([{ kind: 'text', text: 'no links here' }])
    expect(linkify('')).toEqual([])
  })

  test('the full stop, comma or bracket around an address in a sentence is not part of it', () => {
    expect(links('go to https://example.com.')).toEqual(['https://example.com/'])
    expect(links('(see https://example.com/a)')).toEqual(['https://example.com/a'])
    expect(links('"https://example.com/x", then https://b.test/y!')).toEqual(['https://example.com/x', 'https://b.test/y'])
    // A bracket that belongs to the address stays.
    expect(links('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)'])
    expect(joined('(see https://example.com/a).')).toBe('(see https://example.com/a).')
  })

  test('anything that is not plainly a web address stays text: other schemes, no host, an embedded sign-in', () => {
    for (const text of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'ftp://example.com/file',
      'https://',
      'https://user:pw@example.com',
      'https://bank.example@evil.test/login',
      'www.example.com',
      '<a href="https://example.com">x</a>',
    ]) {
      const kinds = linkify(text).map((p) => p.kind)
      expect([text, kinds.includes('link')]).toEqual([text, text.startsWith('<a ')])
    }
    // Markup is never interpreted: the one address inside it is a link, the tags around it are plain text.
    expect(joined('<a href="https://example.com">x</a>')).toBe('<a href="https://example.com">x</a>')
  })
})

describe('lookalike links', () => {
  test('a host with letters outside ASCII shows the address it really opens, so a Cyrillic "а" cannot pass for apple.com', () => {
    const [, link] = linkify('see https://\u0430pple.example/login now') as Array<{ kind: string; text: string; href: string; label: string }>
    expect(link?.text).toBe('https://\u0430pple.example/login')
    expect(link?.href).toBe('https://xn--pple-43d.example/login')
    expect(link?.label).toBe('https://xn--pple-43d.example/login')
    // The parts still add back up to what was typed.
    expect(
      linkify('see https://\u0430pple.example/login now')
        .map((p) => p.text)
        .join(''),
    ).toBe('see https://\u0430pple.example/login now')
  })

  test('a plain ASCII host, a non-ASCII path or query, and an address already typed as punycode show as typed', () => {
    for (const typed of ['https://apple.com/', 'https://example.com/caf\u00e9?q=\u00fc', 'https://xn--pple-43d.example/']) {
      const link = linkify(typed)[0] as { label: string; text: string }
      expect([typed, link.label]).toEqual([typed, link.text])
    }
  })
})

describe('chat messages held and unread', () => {
  const msg = (id: number, memberId = 'ben'): ChatMessage => ({ id, memberId, name: memberId, text: `m${id}`, at: id })

  test('new messages join the held ones in order, each id once; nothing new returns the same array', () => {
    const held = [msg(1), msg(2)]
    expect(mergeMessages(held, [msg(2), msg(3)]).map((m) => m.id)).toEqual([1, 2, 3])
    expect(mergeMessages(held, [msg(2)])).toBe(held)
    expect(mergeMessages(held, [])).toBe(held)
    // Your own message may arrive before history that is still on its way, and ends up in its place.
    expect(mergeMessages([msg(1), msg(9, 'me')], [msg(2), msg(3)]).map((m) => m.id)).toEqual([1, 2, 3, 9])
  })

  test('unread is what others sent since you arrived or last had the panel open, never history and never your own', () => {
    const all = [msg(1), msg(2), msg(3, 'me'), msg(4), msg(5)]
    // Arrived when the call's newest was 2: 4 and 5 are new, your own 3 is not.
    expect(unreadCount(all, new Set(['me']), 2, 0)).toBe(2)
    // Opened the panel when 4 was the newest.
    expect(unreadCount(all, new Set(['me']), 2, 4)).toBe(1)
    expect(unreadCount(all, new Set(['me']), 2, 5)).toBe(0)
    // Before the first check-in says what is history, nothing is unread.
    expect(unreadCount(all, new Set(['me']), Number.MAX_SAFE_INTEGER, 0)).toBe(0)
  })

  test('after a drop and a rejoin under a new member id, messages sent under the old one are still yours and never unread', () => {
    const all = [msg(3, 'me-before'), msg(4, 'ben'), msg(5, 'me-now')]
    expect(unreadCount(all, new Set(['me-now']), 2, 0)).toBe(2) // the old id is a stranger without the memory
    expect(unreadCount(all, new Set(['me-before', 'me-now']), 2, 0)).toBe(1) // only Ben's
  })

  test('the ids a tab has had are kept in session storage per call, newest last, so a refresh remembers them', () => {
    const store = new Map<string, string>()
    ;(globalThis as any).sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    expect([...rememberMine('callA', 'm1')]).toEqual(['m1'])
    expect([...rememberMine('callA', 'm2')]).toEqual(['m1', 'm2'])
    expect([...rememberMine('callA', 'm2')]).toEqual(['m1', 'm2'])
    expect([...rememberMine('callB', 'x')]).toEqual(['x'])
    store.set('meet.ids.callC', 'not json')
    expect([...rememberMine('callC', 'y')]).toEqual(['y'])
    ;(globalThis as any).sessionStorage = undefined
    expect([...rememberMine('callD', 'z')]).toEqual(['z']) // storage blocked: this page load's ids only
  })
})
