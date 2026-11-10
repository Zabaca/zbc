// Seam 2: the workspace page's pure logic. No page, no socket: literal changes in, the state out.
import { describe, expect, test } from 'bun:test'
import { type Bootstrap, type Change, type ConversationView, type WMessage, newCode, readCode } from '../src/workspace-model'
import { afterTicketFailure, backoffMs } from '../src/web/workspace/connection'
import { callOf, messageParts } from '../src/web/workspace/links'
import {
  type WState,
  applyChanges,
  conversationName,
  firstNewId,
  fromBootstrap,
  personTag,
  sidebar,
  tabTitle,
  totalUnread,
  withHistory,
  withOwnMessage,
  withRead,
} from '../src/web/workspace/store'

const ME = 'me'
const msg = (id: number, conv: number, person: string, text = `m${id}`, at = id * 1000): WMessage => ({ id, conv, person, name: person, text, at, editedAt: null })
const conv = (id: number, o: Partial<ConversationView> = {}): ConversationView => ({
  id,
  kind: 'channel',
  name: `c${id}`,
  privacy: 'private',
  createdBy: ME,
  members: [ME, 'ana'],
  unread: 0,
  lastRead: 0,
  last: null,
  ...o,
})
const boot = (convs: ConversationView[], seq = 10): Bootstrap => ({
  me: { id: ME, name: 'Me', email: 'me@northfield.example', kind: 'teammate', owner: false, nudgesOff: false, privacyAcked: true },
  people: [
    { id: ME, name: 'Me', kind: 'teammate', status: 'active', invited: false },
    { id: 'ana', name: 'Ana', kind: 'teammate', status: 'active', invited: false },
  ],
  conversations: convs,
  browse: [],
  seq,
  site: { company: 'Northfield Works', owner: { name: 'Tessa', address: 'tessa@northfield.example' } },
})
const change = <K extends Change['kind']>(seq: number, kind: K, data: Extract<Change, { kind: K }>['data']): Change => ({ seq, at: seq, kind, data }) as Change

const start = (convs: ConversationView[] = [conv(1)], seq = 10): WState => fromBootstrap(boot(convs, seq))
const texts = (s: WState, c = 1) => (s.messages[c] ?? []).map((m) => m.text)

describe('applying changes', () => {
  test('a change at or below the number already applied does nothing, so one that arrives twice is applied once', () => {
    let s = start()
    const m = change(11, 'message', { conv: 1, message: msg(1, 1, 'ana') })
    s = applyChanges(s, [m])
    s = applyChanges(s, [m])
    s = applyChanges(s, [change(5, 'message', { conv: 1, message: msg(0, 1, 'ana') })])
    expect(texts(s)).toEqual(['m1'])
    expect(s.convs[1]?.unread).toBe(1)
    expect(s.seq).toBe(11)
  })

  test('changes are applied in order whatever order they arrive in, and messages stay oldest first', () => {
    const s = applyChanges(start(), [
      change(13, 'message', { conv: 1, message: msg(3, 1, 'ana') }),
      change(11, 'message', { conv: 1, message: msg(1, 1, 'ana') }),
      change(12, 'message', { conv: 1, message: msg(2, 1, 'ana') }),
    ])
    expect(texts(s)).toEqual(['m1', 'm2', 'm3'])
    expect(s.seq).toBe(13)
  })

  test('an edit is applied to a message already shown, and a delete removes it', () => {
    let s = applyChanges(start(), [change(11, 'message', { conv: 1, message: msg(1, 1, 'ana') }), change(12, 'message', { conv: 1, message: msg(2, 1, 'ana') })])
    s = applyChanges(s, [change(13, 'edit', { conv: 1, id: 1, text: 'fixed', editedAt: 99 })])
    expect(s.messages[1]?.[0]).toMatchObject({ text: 'fixed', editedAt: 99 })
    s = applyChanges(s, [change(14, 'delete', { conv: 1, id: 2, author: 'ana' })])
    expect(texts(s)).toEqual(['fixed'])
    // An edit or delete of one it does not hold changes nothing.
    expect(texts(applyChanges(s, [change(15, 'edit', { conv: 1, id: 77, text: 'x', editedAt: 1 })]))).toEqual(['fixed'])
  })

  test('a message for a conversation not yet opened is held, so one that lands while its history is on the way is not lost', () => {
    let s = applyChanges(start(), [change(11, 'message', { conv: 1, message: msg(5, 1, 'ana') })])
    expect(s.loaded[1]).toBeUndefined()
    s = withHistory(s, 1, { messages: [msg(3, 1, 'ana'), msg(4, 1, 'ana')], more: false })
    expect(texts(s)).toEqual(['m3', 'm4', 'm5'])
    expect(s.loaded[1]).toBe(true)
    // Older history goes in front, each id once.
    s = withHistory(s, 1, { messages: [msg(1, 1, 'ana'), msg(2, 1, 'ana'), msg(3, 1, 'ana')], more: true })
    expect(texts(s)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
    expect(s.more[1]).toBe(true)
  })

  test('a structure change, a message for a conversation it does not know, and a delete of something unread ask for a fresh picture', () => {
    expect(applyChanges(start(), [change(11, 'structure', { conv: 2, why: 'added' })]).refresh).toBe(true)
    expect(applyChanges(start(), [change(11, 'message', { conv: 99, message: msg(1, 99, 'ana') })]).refresh).toBe(true)
    expect(applyChanges(start([conv(1, { unread: 1, lastRead: 0 })]), [change(11, 'delete', { conv: 1, id: 4, author: 'ana' })]).refresh).toBe(true)
    // Not a delete of one already read, or of your own.
    expect(applyChanges(start([conv(1, { lastRead: 9 })]), [change(11, 'delete', { conv: 1, id: 4, author: 'ana' })]).refresh).toBe(false)
    expect(applyChanges(start([conv(1, { lastRead: 0 })]), [change(11, 'delete', { conv: 1, id: 4, author: ME })]).refresh).toBe(false)
  })
})

describe('unread', () => {
  test('others’ messages count, your own do not, and what you had already read does not', () => {
    let s = start([conv(1, { lastRead: 5, last: { id: 5, at: 5000 } })])
    s = applyChanges(s, [
      change(11, 'message', { conv: 1, message: msg(6, 1, 'ana') }),
      change(12, 'message', { conv: 1, message: msg(7, 1, ME) }),
      change(13, 'message', { conv: 1, message: msg(8, 1, 'ana') }),
    ])
    expect(s.convs[1]?.unread).toBe(2)
    expect(totalUnread(s)).toBe(2)
    expect(tabTitle(s)).toBe('(2) meet')
    expect(tabTitle(start())).toBe('meet')
  })

  test('a message the picture already holds is not counted again when its change arrives after a refresh', () => {
    // The Bootstrap says the conversation holds up to message 9 with 3 unread; the change for 9 still comes over the socket.
    let s = start([conv(1, { unread: 3, lastRead: 5, last: { id: 9, at: 9000 } })])
    s = applyChanges(s, [change(11, 'message', { conv: 1, message: msg(9, 1, 'ana') })])
    expect(s.convs[1]?.unread).toBe(3)
    s = applyChanges(s, [change(12, 'message', { conv: 1, message: msg(10, 1, 'ana') })])
    expect(s.convs[1]?.unread).toBe(4)
  })

  test('a read mark from another device sets the count; reading here clears it at once', () => {
    let s = start([conv(1, { unread: 4, lastRead: 2 })])
    s = applyChanges(s, [change(11, 'read', { conv: 1, upTo: 6, unread: 1 })])
    expect(s.convs[1]).toMatchObject({ lastRead: 6, unread: 1 })
    // Never backwards.
    s = applyChanges(s, [change(12, 'read', { conv: 1, upTo: 3, unread: 1 })])
    expect(s.convs[1]?.lastRead).toBe(6)
    // Here, with the messages loaded: exact.
    s = withHistory(s, 1, { messages: [msg(5, 1, 'ana'), msg(6, 1, 'ana'), msg(7, 1, 'ana'), msg(8, 1, ME)], more: false })
    expect(withRead(s, 1, 7).convs[1]).toMatchObject({ lastRead: 7, unread: 0 })
    expect(withRead(s, 1, 6)).toBe(s)
  })

  test('a Bootstrap keeps what was loaded and where the changes had got to, and a reset starts over', () => {
    let s = start()
    s = withHistory(applyChanges(s, [change(11, 'message', { conv: 1, message: msg(1, 1, 'ana') })]), 1, { messages: [msg(1, 1, 'ana')], more: false })
    const again = fromBootstrap(boot([conv(1), conv(2)], 20), s)
    expect(again.seq).toBe(11)
    expect(texts(again)).toEqual(['m1'])
    expect(again.loaded[1]).toBe(true)
    expect(Object.keys(again.convs)).toEqual(['1', '2'])
    const reset = fromBootstrap(boot([conv(1)], 20), s, true)
    expect(reset.seq).toBe(20)
    expect(reset.messages[1]).toBeUndefined()
    // A conversation that went away takes its messages with it.
    expect(fromBootstrap(boot([conv(2)], 20), s).messages[1]).toBeUndefined()
  })

  test('a privacy note answered on this page stays answered when an older Bootstrap arrives', () => {
    const answered = { ...start(), me: { ...(start().me as NonNullable<WState['me']>), privacyAcked: true } }
    expect(fromBootstrap(boot([conv(1)], 20), answered).me?.privacyAcked).toBe(true)
    // A first Bootstrap, with nothing answered yet, shows the note.
    const unseen = boot([conv(1)], 20)
    unseen.me.privacyAcked = false
    expect(fromBootstrap(unseen).me?.privacyAcked).toBe(false)
  })

  test('your own sent message appears at once, and a duplicate of it from the change is ignored', () => {
    let s = start()
    s = withHistory(s, 1, { messages: [], more: false })
    s = withOwnMessage(s, msg(4, 1, ME))
    s = applyChanges(s, [change(11, 'message', { conv: 1, message: msg(4, 1, ME) })])
    expect(texts(s)).toEqual(['m4'])
    expect(s.convs[1]?.unread).toBe(0)
    expect(s.convs[1]?.last?.id).toBe(4)
  })

  test('the "New" line goes before the first message from someone else that was unread on opening, and does not move to one that arrives while reading', () => {
    const list = [msg(1, 1, 'ana'), msg(2, 1, ME), msg(3, 1, 'ana'), msg(4, 1, 'ana'), msg(5, 1, 'ana')]
    expect(firstNewId(list, ME, 2, 4)).toBe(3)
    expect(firstNewId(list, ME, 4, 4)).toBeNull()
    expect(firstNewId(list, ME, 4, 5)).toBe(5)
    expect(firstNewId(list, ME, 0, 5)).toBe(1)
    expect(firstNewId(list, ME, 2, 2)).toBeNull() // nothing unread when it was opened: 3, 4 and 5 came while reading
    expect(firstNewId([msg(5, 1, ME)], ME, 0, 5)).toBeNull()
  })
})

describe('the sidebar', () => {
  test('channels by name, direct messages by latest activity, a direct message named for the other person', () => {
    const s = start([
      conv(1, { name: 'zeta' }),
      conv(2, { name: 'Alpha' }),
      conv(3, { kind: 'dm', name: null, privacy: null, members: [ME, 'ana'], last: { id: 1, at: 1 } }),
      conv(4, { kind: 'dm', name: null, privacy: null, members: [ME, 'gone'], last: { id: 2, at: 5 } }),
    ])
    const { channels, dms } = sidebar(s)
    expect(channels.map((c) => c.name)).toEqual(['Alpha', 'zeta'])
    expect(dms.map((c) => c.id)).toEqual([4, 3])
    expect(conversationName(s, conv(3, { kind: 'dm', name: null, members: [ME, 'ana'] }))).toBe('Ana')
    expect(conversationName(s, conv(4, { kind: 'dm', name: null, members: [ME, 'gone'] }))).toBe('Deleted person')
  })

  test('the Phone conversation is named Phone, kept apart from channels and direct messages, and counts as unread like any other', () => {
    const s = start([conv(1), conv(9, { kind: 'phone', name: 'Phone', unread: 2, members: [ME, 'ana'] })])
    const { channels, dms, phone } = sidebar(s)
    expect(channels.map((c) => c.id)).toEqual([1])
    expect(dms).toEqual([])
    expect(phone.map((c) => c.id)).toEqual([9])
    expect(conversationName(s, phone[0] as ConversationView)).toBe('Phone')
    expect(totalUnread(s)).toBe(2)
  })

  test('a voicemail from the phone arrives as an unread message that carries what to play and whom to call back', () => {
    let s = start([conv(9, { kind: 'phone', name: 'Phone' })])
    const voicemail: WMessage = { ...msg(1, 9, 'phone', 'Voicemail from (213) 555-0199, 42 sec'), name: 'Phone', phone: { kind: 'voicemail', id: 3, number: '+12135550199', display: '(213) 555-0199', seconds: 42 } }
    s = applyChanges(s, [change(11, 'message', { conv: 9, message: voicemail })])
    expect(s.convs[9]?.unread).toBe(1)
    expect(s.messages[9]?.[0]?.phone).toMatchObject({ kind: 'voicemail', number: '+12135550199' })
    // A deleted voicemail leaves the list for everyone, and the count is asked for again.
    s = applyChanges(s, [change(12, 'delete', { conv: 9, id: 1, author: 'phone' })])
    expect(s.messages[9]).toEqual([])
    expect(s.refresh).toBe(true)
  })
})

describe('the connection', () => {
  test('a dropped socket tries again after 1 second, then backs off to 30', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
    expect(backoffMs(-3)).toBe(1000)
  })

  test('each try asks for a fresh ticket; a refused ticket shows the guest the sign-in; a network failure or a busy server retries', () => {
    expect(afterTicketFailure({ status: 401 })).toBe('signin')
    expect(afterTicketFailure({ status: 403 })).toBe('signin')
    expect(afterTicketFailure({ network: true })).toBe('retry')
    expect(afterTicketFailure({ status: 500 })).toBe('retry')
    expect(afterTicketFailure({ status: 429 })).toBe('retry')
  })
})

describe('what a person is called beside their name', () => {
  test('Northfield Works, Guest, or Invited for a guest who has not signed in: one word each, from one place', () => {
    const p = (kind: 'teammate' | 'guest', invited: boolean) => ({ id: 'x', name: 'X', kind, status: 'active' as const, invited })
    expect(personTag(p('teammate', false), 'Northfield Works')).toBe('Northfield Works')
    expect(personTag(p('teammate', false), 'Pinecrest')).toBe('Pinecrest')
    expect(personTag(p('teammate', false), '')).toBe('Team')
    expect(personTag(p('guest', false), 'Northfield Works')).toBe('Guest')
    expect(personTag(p('guest', true), 'Northfield Works')).toBe('Invited')
  })
})

describe('links', () => {
  const site = 'https://meet.northfield.example'
  const name = 'k7m2qx9frtn4w6hbc8jd'

  test('a link to one of this site’s calls reads "Join call", whichever way the name is written', () => {
    for (const href of [`${site}/r/${name}`, `${site}/r/k7m2q-x9frt-n4w6h-bc8jd`, `${site}/r/${name}/`]) {
      const parts = messageParts(`come to ${href} now`, site)
      expect(parts.map((p) => p.kind)).toEqual(['text', 'link', 'text'])
      expect(parts[1]).toMatchObject({ kind: 'link', label: 'Join call', href: `${site}/r/${href.split('/r/')[1]}` })
      expect(callOf(href, site)).toBe(name)
    }
  })

  test('any other link stays as written, a lookalike shows its real address, and joining the parts gives the message back', () => {
    const text = `see https://example.com/r/${name} and ${site}/start and https://аpple.example and https://bank.example@evil.test and javascript:alert(1)`
    const parts = messageParts(text, site)
    expect(parts.map((p) => p.text).join('')).toBe(text)
    expect(parts.filter((p) => p.kind === 'link').map((p) => (p.kind === 'link' ? p.label : ''))).toEqual([`https://example.com/r/${name}`, `${site}/start`, 'https://xn--pple-43d.example/'])
    expect(callOf(`https://example.com/r/${name}`, site)).toBeNull()
    expect(callOf(`${site}/r/short`, site)).toBeNull()
    expect(callOf(`${site}/other/${name}`, site)).toBeNull()
    expect(callOf('not a url', site)).toBeNull()
  })
})

describe('codes', () => {
  test('a code is six digits, every digit equally likely, and the unused top of the range is skipped', () => {
    const fixed = (...bytes: number[]) => () => Uint8Array.from(bytes)
    expect(newCode(fixed(0, 0, 0))).toBe('000000')
    expect(newCode(fixed(0, 1, 2))).toBe('000258')
    // 16,000,000 and above would make low codes likelier: it draws again.
    const draws = [Uint8Array.from([0xf4, 0x24, 0x00]), Uint8Array.from([0, 0, 7])]
    expect(newCode(() => draws.shift() as Uint8Array)).toBe('000007')
    expect(newCode(() => crypto.getRandomValues(new Uint8Array(3)))).toMatch(/^\d{6}$/)
  })

  test('a typed code may have spaces or a dash in it, and must be exactly six digits', () => {
    expect(readCode('123456')).toBe('123456')
    expect(readCode(' 123 456 ')).toBe('123456')
    expect(readCode('123-456')).toBe('123456')
    for (const bad of ['12345', '1234567', 'abcdef', '', 12345, null]) expect(readCode(bad)).toBeNull()
  })
})
