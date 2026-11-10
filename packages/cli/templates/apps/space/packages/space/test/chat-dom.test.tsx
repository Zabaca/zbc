// Chat in the page, as a browser runs it in a stand-in DOM, over the Worker's own functions and a stand-in meet: links in a message and a call link reading
// "Join call", Edit and Delete only where meet says the person may (Delete asks first, in /start's words), meet's refusals shown under the message, "New" before the first unread message from
// someone else, New message (a first message is one press and one direct message, however often it is pressed), and Settings, Chat (the name, the nudge, the privacy note). The DOM is registered
// for this file only. The router, the sign-in and the POST guard are test/chat.test.ts's: a DOM's Request drops the Origin header a browser sets for itself.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { renderToStaticMarkup } from 'react-dom/server'
import { T0, northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { acknowledgePrivacy, deleteMessage, editMessage, me as chatMe, parseDelete, parseEdit, parseMeUpdate, people, updateMe } from '../src/chat'
import { newCompose } from '../src/client/compose'
import { ConversationView, type ViewProps } from '../src/client/Conversation'
import { ChatMessageRow, ChatText, meetOrigin } from '../src/client/ChatMessage'
import { privacyNote, ChatSettingsPanel } from '../src/client/ChatSettings'
import { NORTHFIELD_ME, inNorthfield } from './northfield-shell'
import { NewMessageView, conversationWith, matching } from '../src/client/NewMessage'
import { changeChat } from '../src/history'
import { parseChat, openConversation, postChat } from '../src/conversation'
import { titleWith } from '../src/client/unread'
import { type StandInChatMessage, standInInbox, standInMeet } from '../src/stand-ins'
import { ago, channel, contact, dm, person } from './world'
import { OWNER_SIGNED_IN } from './signed-in'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const realFetch = globalThis.fetch
const ORIGIN = 'https://space.northfield.example'
const ME = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, northfield())

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  globalThis.fetch = realFetch
})

const priya = person('p-priya', 'Priya Natarajan', 'priya@northfield.example', 'teammate')
const msg = (id: number, who: 'tessa' | 'priya', text: string, at = ago(10)): StandInChatMessage => ({ id, at, authorId: `p-${who}`, authorName: who === 'tessa' ? 'Tessa' : 'Priya', text, mine: who === 'tessa' })

/** The real Worker functions with a stand-in meet behind them; the page's `fetch` is routed to them. */
async function setup(o: { owner?: boolean; writeWithinMs?: number } = {}) {
  const meet = standInMeet(
    { direct: [dm(11, priya, ago(5), 2, 'Third'), dm(12, person('p-dana', 'Dana Reyes', 'dana@harbor.example'), null)], channels: [channel(21, 'launch', ago(60), 0)] },
    {
      history: {
        11: [
          msg(110, 'priya', 'First', ago(30)),
          msg(111, 'tessa', 'Reply with a link https://example.com/page.', ago(20)),
          msg(112, 'priya', 'Join: https://meet.northfield.example/r/jh4n8qw2xkzr7tbp5mcd please', ago(10)),
          msg(113, 'priya', 'Third', ago(5)),
        ],
      },
      channels: {
        owner: o.owner ?? true,
        people: [{ ...priya, direct: true }, { id: 'p-ben', name: 'Ben Walker', kind: 'teammate', address: 'ben@northfield.example' }, { id: 'p-dana', name: 'Dana Reyes', kind: 'guest', address: 'dana@harbor.example' }],
        rooms: { 21: { createdByMe: false, members: ['p-priya', 'p-dana'] } },
      },
    },
  )
  const inbox = standInInbox([contact('c-dana', 'Dana Reyes', 'dana@harbor.example')], [])
  const ask = { apps: { inbox, meet }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 200, writeWithinMs: o.writeWithinMs ?? 500 }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const asked: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), ORIGIN)
    asked.push(`${init?.method ?? 'GET'} ${url.pathname}`)
    const body = init?.method === 'POST' ? JSON.parse(String(init.body)) : null
    const bad = (m: string) => json({ error: m }, 400)
    switch (url.pathname) {
      case '/api/meet/people':
        return json(await people(ask))
      case '/api/meet/me':
        return json(await chatMe(ask))
      case '/api/meet/message-edit': {
        const p = parseEdit(body)
        return p.ok ? json(await editMessage(ask, p.value)) : bad(p.message)
      }
      case '/api/meet/message-delete': {
        const p = parseDelete(body)
        return p.ok ? json(await deleteMessage(ask, p.value)) : bad(p.message)
      }
      case '/api/meet/me-update': {
        const p = parseMeUpdate(body)
        return p.ok ? json(await updateMe(ask, p.value)) : bad(p.message)
      }
      case '/api/meet/privacy-ack':
        return json(await acknowledgePrivacy(ask))
      case '/api/chat': {
        const p = parseChat(body)
        return p.ok ? json(await postChat(ask, p.value)) : bad(p.message)
      }
    }
    return json({ error: 'Not found' }, 404)
  }) as typeof fetch
  return { meet, ask, asked }
}

async function mount(node: (h: typeof import('react').createElement) => React.ReactElement) {
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  document.body.innerHTML = '<div id="root"></div>'
  const root = createRoot(document.getElementById('root') as HTMLElement)
  await act(async () => {
    root.render(inNorthfield(node(createElement)))
    await sleep(120)
  })
  const q = <T extends Element = HTMLElement>(testid: string) => document.querySelector(`[data-testid="${testid}"]`) as T | null
  const all = (testid: string) => [...document.querySelectorAll(`[data-testid="${testid}"]`)] as HTMLElement[]
  const click = async (el: Element | null) => {
    if (!el) throw new Error('nothing to click')
    await act(async () => {
      ;(el as HTMLElement).click()
      await sleep(120)
    })
  }
  const type = async (el: Element | null, value: string) => {
    if (!el) throw new Error('nothing to type in')
    await act(async () => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(10)
    })
  }
  const submit = async (el: Element | null) => {
    await act(async () => {
      el?.closest('form')?.requestSubmit()
      await sleep(150)
    })
  }
  return { q, all, click, type, submit, text: () => document.body.textContent ?? '', unmount: () => act(async () => root.unmount()), createElement }
}

// ── Links ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('links in a chat message', () => {
  const origin = 'https://meet.northfield.example'
  const links = (text: string, o: string | null = origin) =>
    [...document.createRange().createContextualFragment(renderToStaticMarkup(<ChatText text={text} origin={o} />)).querySelectorAll('a')].map((a) => ({ href: a.getAttribute('href'), label: a.textContent, rel: a.getAttribute('rel'), target: a.getAttribute('target'), id: a.getAttribute('data-testid') }))

  test('an address is a link that opens in a new tab and leaks nothing; a call link on meet’s address reads "Join call"', () => {
    expect(links('See https://example.com/a?b=1, and https://meet.northfield.example/r/jh4n8qw2xkzr7tbp5mcd.')).toEqual([
      { href: 'https://example.com/a?b=1', label: 'https://example.com/a?b=1', rel: 'noopener noreferrer nofollow', target: '_blank', id: 'chat-link' },
      { href: 'https://meet.northfield.example/r/jh4n8qw2xkzr7tbp5mcd', label: 'Join call', rel: 'noopener noreferrer nofollow', target: '_blank', id: 'join-call' },
    ])
  })

  test('only http and https, nothing with a sign-in in it, a look-alike host shown as what it opens, and another site’s /r/ path is no call', () => {
    expect(links('javascript:alert(1) and ftp://x.example/f and mailto:a@b.example')).toEqual([])
    expect(links('https://bank.example@evil.test/login')).toEqual([])
    expect(links('https://аpple.example/x')[0]?.label).toBe('https://xn--pple-43d.example/x')
    expect(links('https://evil.example/r/jh4n8qw2xkzr7tbp5mcd')[0]?.label).toBe('https://evil.example/r/jh4n8qw2xkzr7tbp5mcd')
  })

  test('the words are text, never markup, and the parts add up to the message', () => {
    const html = renderToStaticMarkup(<ChatText text={'<img src=x onerror=alert(1)> https://example.com <b>bold</b>'} origin={origin} />)
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>')
    expect(html.replace(/<[^>]+>/g, '')).toBe('&lt;img src=x onerror=alert(1)&gt; https://example.com &lt;b&gt;bold&lt;/b&gt;')
  })

  test('without meet’s address a link is an ordinary one, never a call; meetOrigin reads one out of an address', () => {
    expect(links('https://meet.northfield.example/r/jh4n8qw2xkzr7tbp5mcd', null)[0]?.label).toBe('https://meet.northfield.example/r/jh4n8qw2xkzr7tbp5mcd')
    expect(meetOrigin('https://meet.northfield.example/start')).toBe('https://meet.northfield.example')
    expect(meetOrigin(undefined)).toBeNull()
    expect(meetOrigin('not an address')).toBeNull()
  })
})

// ── Edit and Delete ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Edit and Delete', () => {
  const message = (over: Partial<Parameters<typeof ChatMessageRow>[0]['message']> = {}) => ({ id: 111, conversationId: 11, authorName: 'Tessa', mine: true, at: T0, text: 'Reply', edited: false, may: { edit: true, delete: true }, ...over })
  const row = (tools: Parameters<typeof ChatMessageRow>[0]['tools'], over: Parameters<typeof message>[0] = {}) => (h: typeof import('react').createElement) =>
    h(ChatMessageRow, { message: message(over), name: 'You', at: h('time', { className: 'sub' }, 'now'), ...(tools && { tools }) })

  test('a button is drawn only where meet says the person may: neither for a message with no `may`, none without the page’s tools', async () => {
    const tools = { origin: null, edit: async () => null, remove: async () => null }
    for (const [over, t, edit, del] of [
      [{}, tools, true, true],
      [{ may: { edit: false, delete: true } }, tools, false, true],
      [{ may: { edit: false, delete: false } }, tools, false, false],
      [{ may: undefined }, tools, false, false],
      [{}, undefined, false, false],
    ] as const) {
      const m = await mount(row(t, over))
      expect([!!m.q('msg-edit'), !!m.q('msg-delete')]).toEqual([edit, del])
      await m.unmount()
    }
  })

  test('Edit shows the words in a box; Save sends them once and the box closes; a refusal keeps the box and says meet’s words', async () => {
    const seen: Array<[number, string]> = []
    let answer: string | null = 'You can edit only your own messages.'
    const m = await mount(row({ origin: null, edit: async (id, text) => (seen.push([id, text]), answer), remove: async () => null }))
    await m.click(m.q('msg-edit'))
    expect((m.q<HTMLTextAreaElement>('msg-edit-input'))?.value).toBe('Reply')
    await m.type(m.q('msg-edit-input'), 'Reply, better')
    await m.submit(m.q('msg-edit-input'))
    expect(seen).toEqual([[111, 'Reply, better']])
    expect(m.q('msg-error')?.textContent).toBe('You can edit only your own messages.')
    expect(m.q('msg-edit-input')).not.toBeNull()
    answer = null
    await m.click(m.q('msg-edit-save'))
    expect(seen).toHaveLength(2)
    expect(m.q('msg-edit-input')).toBeNull()
    await m.unmount()
  })

  test('Save is not offered for nothing, and Cancel changes nothing', async () => {
    const seen: string[] = []
    const m = await mount(row({ origin: null, edit: async (_id, text) => (seen.push(text), null), remove: async () => null }))
    await m.click(m.q('msg-edit'))
    await m.type(m.q('msg-edit-input'), '   ')
    expect(m.q<HTMLButtonElement>('msg-edit-save')?.disabled).toBe(true)
    await m.click(m.q('msg-edit-cancel'))
    expect(m.q('msg-edit-input')).toBeNull()
    expect(seen).toEqual([])
    await m.unmount()
  })

  test('Delete asks first, in /start’s words; Keep it deletes nothing; Delete deletes once; a refusal is said under the message', async () => {
    const seen: number[] = []
    let answer: string | null = null
    const m = await mount(row({ origin: null, edit: async () => null, remove: async (id) => (seen.push(id), answer) }))
    await m.click(m.q('msg-delete'))
    expect(m.text()).toContain('Delete this message for everyone?')
    expect(seen).toEqual([])
    await m.click(m.q('ask-no'))
    expect(m.q('ask')).toBeNull()
    expect(seen).toEqual([])
    answer = 'There is no such message.'
    await m.click(m.q('msg-delete'))
    await m.click(m.q('ask-yes'))
    expect(seen).toEqual([111])
    expect(m.q('msg-error')?.textContent).toBe('There is no such message.')
    await m.unmount()
  })

  test('an edited message says so', async () => {
    const m = await mount(row({ origin: null, edit: async () => null, remove: async () => null }, { edited: true }))
    expect(m.q('edited')?.textContent).toBe('edited')
    await m.unmount()
  })

  test('the held history is changed where the message is, and a message gone is gone', () => {
    const src = (ids: number[]) => ({ kind: 'chat' as const, conversationId: 11, more: false, messages: ids.map((id) => message({ id, text: `m${id}` })) })
    const [edited] = changeChat([src([1, 2, 3])], 2, (m) => ({ ...m, text: 'new', edited: true }))
    expect(edited?.kind === 'chat' ? edited.messages.map((m) => [m.id, m.text]) : null).toEqual([[1, 'm1'], [2, 'new'], [3, 'm3']])
    const [gone] = changeChat([src([1, 2, 3])], 2, () => null)
    expect(gone?.kind === 'chat' ? gone.messages.map((m) => m.id) : null).toEqual([1, 3])
    const kept = [src([1])]
    expect(changeChat(kept, 9, () => null)).toEqual(kept)
  })
})

// ── The "New" line ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('where "New" begins', () => {
  async function opened() {
    const { meet } = await setup()
    const answer = await openConversation(
      { apps: { inbox: standInInbox([], []), meet }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 100 },
      'priya@northfield.example',
    )
    if (!answer.ok) throw new Error(answer.message)
    return answer.value
  }
  const idle = (answer: Awaited<ReturnType<typeof opened>>, newFrom: number | null): ViewProps => ({
    me: ME,
    now: T0,
    answer,
    sources: answer.sources,
    loadingEarlier: false,
    onEarlier: () => undefined,
    way: 'chat',
    onWay: () => undefined,
    threadId: null,
    onThread: () => undefined,
    compose: newCompose(),
    onText: () => undefined,
    onSend: () => undefined,
    onSendAndClose: () => undefined,
    onClose: () => undefined,
    onReopen: () => undefined,
    reopen: null,
    changing: false,
    changed: null,
    onDismiss: () => undefined,
    drafts: {},
    onSendDraft: () => undefined,
    onDismissDraft: () => undefined,
    onDraftChanged: () => undefined,
    profileOpen: false,
    onProfile: () => undefined,
    onBack: () => undefined,
    timeZone: 'UTC',
    chat: { origin: 'https://meet.northfield.example', newFrom, edit: async () => null, remove: async () => null },
  })
  /** The messages in the order drawn, with "NEW" where the line is. */
  const order = (html: string) => [...html.matchAll(/data-testid="new-line"|data-testid="entry" data-kind="chat" data-id="(\d+)"/g)].map((m) => (m[1] ? m[1] : 'NEW'))

  test('the line is before the first message from someone else that was unread, and nowhere else', async () => {
    const answer = await opened()
    expect(answer.newFrom).toBe(112)
    expect(order(renderToStaticMarkup(<ConversationView {...idle(answer, answer.newFrom ?? null)} />))).toEqual(['110', '111', 'NEW', '112', '113'])
  })

  test('with nothing unread there is no line; the line does not move to a message that arrived while the conversation was open', async () => {
    const answer = await opened()
    expect(order(renderToStaticMarkup(<ConversationView {...idle(answer, null)} />))).toEqual(['110', '111', '112', '113'])
    expect(order(renderToStaticMarkup(<ConversationView {...idle(answer, 112)} />))).toEqual(['110', '111', 'NEW', '112', '113'])
  })

  test('a line that falls on the person’s own message is moved to the next one from someone else', async () => {
    const answer = await opened()
    expect(order(renderToStaticMarkup(<ConversationView {...idle(answer, 111)} />))).toEqual(['110', '111', 'NEW', '112', '113'])
  })

  test('a huddle’s announcement drawn as its card is not the message the line sits before: with 112 a huddle and 113 a message, the line is before 113', async () => {
    const huddle = 'k7m2qx9frtn4w6hbc8jd'
    const call = {
      name: huddle,
      link: `https://meet.northfield.example/r/${huddle}`,
      kind: 'huddle' as const,
      title: null,
      madeBy: { name: 'Priya', mine: false },
      madeAt: ago(10),
      conversationId: 11,
      home: null,
      startsAt: null,
      invitees: [],
      present: 0,
      people: 2,
      messages: 0,
      endedAt: ago(5),
      openedAt: ago(10),
    }
    const meet = standInMeet(
      { direct: [dm(11, priya, ago(5), 2, 'Third')], channels: [] },
      { callsHeld: [call], history: { 11: [msg(110, 'priya', 'First', ago(30)), msg(111, 'tessa', 'Reply', ago(20)), { ...msg(112, 'priya', `Started a huddle: ${call.link}`, ago(10)), huddle }, msg(113, 'priya', 'Third', ago(5))] } },
    )
    const got = await openConversation({ apps: { inbox: standInInbox([], []), meet }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 100 }, 'priya@northfield.example')
    if (!got.ok) throw new Error(got.message)
    // Unread is 2: the huddle's announcement and the message after it.
    expect(got.value.newFrom).toBe(112)
    const html = renderToStaticMarkup(<ConversationView {...idle(got.value, got.value.newFrom ?? null)} />)
    expect(order(html)).toEqual(['110', '111', 'NEW', '113'])
    expect(html.indexOf('data-testid="new-line"')).toBeGreaterThan(html.indexOf('data-testid="call-card"'))
  })

  test('links in the conversation: the call link is a button-like "Join call", an ordinary link is a link', async () => {
    const answer = await opened()
    const html = renderToStaticMarkup(<ConversationView {...idle(answer, null)} />)
    expect(html).toContain('data-testid="join-call"')
    expect(html).toContain('>Join call<')
    expect(html).toContain('href="https://example.com/page"')
  })

  test('drawn without the page’s tools a chat message is plain text, as it was', async () => {
    const answer = await opened()
    const { chat: _chat, ...bare } = idle(answer, 112)
    const html = renderToStaticMarkup(<ConversationView {...bare} />)
    expect(html).not.toContain('data-testid="new-line"')
    expect(html).not.toContain('data-testid="msg-edit"')
    expect(html).not.toContain('Join call')
  })
})

describe('the title', () => {
  test('the count goes in front of it, 99 and over is 99+, none draws nothing', () => {
    expect(titleWith('Conversations | Northfield Works', 0)).toBe('Conversations | Northfield Works')
    expect(titleWith('Conversations | Northfield Works', 3)).toBe('(3) Conversations | Northfield Works')
    expect(titleWith('Conversations | Northfield Works', 99)).toBe('(99) Conversations | Northfield Works')
    expect(titleWith('Conversations | Northfield Works', 100)).toBe('(99+) Conversations | Northfield Works')
  })
})

// ── New message ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('New message', () => {
  const reachable = [
    { person: { id: 'p-ben', name: 'Ben Walker', kind: 'teammate' as const, address: 'ben@northfield.example' }, direct: false },
    { person: { id: 'p-priya', name: 'Priya Natarajan', kind: 'teammate' as const, address: 'priya@northfield.example' }, direct: true },
  ]

  test('the list is searched by name or address, and says so when no one is there or no one is found', () => {
    expect(matching(reachable, 'ben').map((p) => p.person.id)).toEqual(['p-ben'])
    expect(matching(reachable, 'PRIYA@').map((p) => p.person.id)).toEqual(['p-priya'])
    expect(matching(reachable, '  ')).toHaveLength(2)
    expect(matching(reachable, 'zzz')).toEqual([])
    expect(conversationWith(reachable[0]?.person as never)).toBe('/meet/ben%40northfield.example')
    expect(conversationWith({ id: 'p-x', name: 'X', kind: 'guest', address: null })).toBe('/meet/chat%3Ap-x')
    const draw = (people: typeof reachable, q = '') =>
      renderToStaticMarkup(<NewMessageView people={people} q={q} onQ={() => undefined} to={null} onPick={() => undefined} compose={newCompose()} onText={() => undefined} onSend={() => undefined} onClose={() => undefined} />)
    expect(draw([])).toContain('There is no one to message yet.')
    expect(draw(reachable, 'zzz')).toContain('No one by that name.')
    expect(draw(reachable)).toContain('Ben Walker')
  })

  test('over the real Worker: a person with a conversation is opened; anyone else gets a box, and the first message is one press and one direct message', async () => {
    const s = await setup()
    const { NewMessagePanel } = await import('../src/client/NewMessage')
    const went: string[] = []
    let changed = 0
    const m = await mount((h) => h(NewMessagePanel, { go: (p: string) => went.push(p), onChanged: () => void (changed += 1), onClose: () => undefined }))
    expect(m.all('dm-person').map((b) => [b.dataset.person, b.dataset.direct])).toEqual([
      ['p-ben', 'false'],
      ['p-dana', 'false'],
      ['p-priya', 'true'],
    ])
    // A conversation with something in it is opened as it is; nothing is written.
    await m.click(m.all('dm-person').find((b) => b.dataset.person === 'p-priya') ?? null)
    expect(went).toEqual(['/meet/priya%40northfield.example'])
    expect(s.meet.posted).toEqual([])
    await m.unmount()

    went.length = 0
    const n = await mount((h) => h(NewMessagePanel, { go: (p: string) => went.push(p), onChanged: () => void (changed += 1), onClose: () => undefined }))
    await n.click(n.all('dm-person').find((b) => b.dataset.person === 'p-ben') ?? null)
    expect(n.q('dm-to')?.textContent).toContain('Ben Walker')
    expect(n.q<HTMLButtonElement>('dm-send')?.disabled).toBe(true)
    await n.type(n.q('dm-text'), 'Welcome aboard, Ben')
    // Two presses in quick succession: the box waits for the answer, and the key is the same anyway.
    const send = n.q<HTMLButtonElement>('dm-send')
    await n.submit(send)
    await n.submit(send)
    expect(s.meet.posted).toHaveLength(1)
    expect(s.meet.posted[0]).toMatchObject({ target: { personId: 'p-ben' }, text: 'Welcome aboard, Ben' })
    expect(went).toEqual(['/meet/ben%40northfield.example'])
    expect(changed).toBeGreaterThan(0)
    await n.unmount()
  })

  test('a message meet refuses opens nothing, keeps the words and the key, and the second press sends it once', async () => {
    const s = await setup()
    const { NewMessagePanel } = await import('../src/client/NewMessage')
    const went: string[] = []
    s.meet.script.post.push('limit')
    const m = await mount((h) => h(NewMessagePanel, { go: (p: string) => went.push(p), onChanged: () => undefined, onClose: () => undefined }))
    await m.click(m.all('dm-person').find((b) => b.dataset.person === 'p-ben') ?? null)
    await m.type(m.q('dm-text'), 'hello Ben')
    await m.submit(m.q('dm-text'))
    expect(m.q('dm-notice')?.textContent).toContain('You are sending messages too fast. Wait a moment.')
    expect(m.q<HTMLTextAreaElement>('dm-text')?.value).toBe('hello Ben')
    expect(went).toEqual([])
    expect(s.meet.posted).toEqual([])
    await m.submit(m.q('dm-text'))
    expect(s.meet.posted).toHaveLength(1)
    expect(s.meet.asked.posts.map((p) => p.key)[0]).toBe(s.meet.asked.posts.map((p) => p.key)[1])
    expect(went).toEqual(['/meet/ben%40northfield.example'])
    await m.unmount()
  })

  test('an outcome the space lost track of offers no second try', async () => {
    const s = await setup({ writeWithinMs: 40 })
    const { NewMessagePanel } = await import('../src/client/NewMessage')
    s.meet.script.post.push('throw')
    const went: string[] = []
    const m = await mount((h) => h(NewMessagePanel, { go: (p: string) => went.push(p), onChanged: () => undefined, onClose: () => undefined }))
    await m.click(m.all('dm-person').find((b) => b.dataset.person === 'p-ben') ?? null)
    await m.type(m.q('dm-text'), 'hello Ben')
    await m.submit(m.q('dm-text'))
    expect(m.q('dm-notice')?.textContent).toContain('cannot tell whether it went out')
    expect(m.q('dm-send')).toBeNull()
    expect(went).toEqual([])
    expect(s.meet.asked.posts).toHaveLength(1)
    await m.unmount()
  })
})

// ── Settings ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Settings, Chat', () => {
  const settings = { person: { id: 'p-tessa', name: 'Tessa', kind: 'teammate' as const, address: 'tessa@northfield.example' }, owner: true, nudgesOff: false, privacyAcked: false }

  test('the privacy note is /start’s, word for word, with its acknowledgement until it has been given', async () => {
    const m = await mount((h) => h(ChatSettingsPanel, { me: settings, busy: false, say: null, done: null, onName: () => undefined, onNudges: () => undefined, onAcknowledge: () => undefined }))
    const note = m.q('privacy-note')?.textContent ?? ''
    for (const p of privacyNote(NORTHFIELD_ME.company.name, NORTHFIELD_ME.owner)) expect(note).toContain(`${p.lead} ${p.body}`)
    expect(note).toContain('Your messages are seen by the people in the channel or direct message you wrote them in, and by no one else in the workspace.')
    expect(note).toContain('To have your account and everything you wrote deleted, ask Tessa at tessa@northfield.example.')
    expect(m.q('privacy-ok')).not.toBeNull()
    await m.unmount()
    const acked = await mount((h) => h(ChatSettingsPanel, { me: { ...settings, privacyAcked: true }, busy: false, say: null, done: null, onName: () => undefined, onNudges: () => undefined, onAcknowledge: () => undefined }))
    expect(acked.q('privacy-ok')).toBeNull()
    expect(acked.q('privacy-acked')?.textContent).toContain('acknowledged')
    await acked.unmount()
  })

  test('the name is saved only when it is something else; the switch says the email is wanted when it is on', async () => {
    const names: string[] = []
    const nudges: boolean[] = []
    const m = await mount((h) => h(ChatSettingsPanel, { me: settings, busy: false, say: null, done: null, onName: (n: string) => names.push(n), onNudges: (w: boolean) => nudges.push(w), onAcknowledge: () => undefined }))
    expect(m.q<HTMLButtonElement>('chat-name-save')?.disabled).toBe(true)
    await m.type(m.q('chat-name'), '   ')
    expect(m.q<HTMLButtonElement>('chat-name-save')?.disabled).toBe(true)
    await m.type(m.q('chat-name'), 'Tessa Y')
    await m.submit(m.q('chat-name'))
    expect(names).toEqual(['Tessa Y'])
    expect(m.q('chat-nudges')?.getAttribute('aria-checked')).toBe('true')
    await m.click(m.q('chat-nudges'))
    expect(nudges).toEqual([false])
    await m.unmount()
  })

  test('over the real Worker: a name, the nudge and the note are meet’s, changed one call each', async () => {
    const s = await setup()
    const { ChatSection } = await import('../src/client/ChatSettings')
    const m = await mount((h) => h(ChatSection, {}))
    expect((m.q<HTMLInputElement>('chat-name'))?.value).toBe('Tessa')
    await m.type(m.q('chat-name'), 'Tessa Y')
    await m.submit(m.q('chat-name'))
    await sleep(120)
    expect(s.meet.settings.person.name).toBe('Tessa Y')
    await m.click(m.q('chat-nudges'))
    expect(s.meet.settings.nudgesOff).toBe(true)
    await m.click(m.q('privacy-ok'))
    expect(s.meet.settings.privacyAcked).toBe(true)
    expect(s.meet.changes.updates).toEqual([{ name: 'Tessa Y' }, { nudgesOff: true }])
    expect(s.meet.changes.acknowledged).toBe(1)
    await sleep(120)
    expect(m.q('privacy-ok')).toBeNull()
    await m.unmount()
  })

  test('an empty name is refused in meet’s words and the screen says so', async () => {
    const s = await setup()
    const { ChatSection } = await import('../src/client/ChatSettings')
    const m = await mount((h) => h(ChatSection, {}))
    s.meet.script.write.push('limit')
    await m.type(m.q('chat-name'), 'Someone')
    await m.submit(m.q('chat-name'))
    expect(m.q('say')?.textContent).toContain('You are sending messages too fast.')
    expect(s.meet.settings.person.name).toBe('Tessa')
    await m.unmount()
  })
})
