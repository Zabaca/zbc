// Close, Send and close and Reopen on a person's conversation: the words, the key, what is drawn, and the page as a browser runs it (in a stand-in DOM,
// registered for the second half of this file only, as refresh.test.tsx does). The Worker side (what is named, what is refused) is in conversation.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { renderToStaticMarkup } from 'react-dom/server'
import { T0, northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { newCompose, typed } from '../src/client/compose'
import { describeClose, describeReopen, isCloseKey, modalOpen, reopenOffer, typingIn, whyNotClosed, withPending } from '../src/client/close'
import { changes } from '../src/client/changes'
import { ConversationView, type ViewProps } from '../src/client/Conversation'
import { INBOX_MOST_MARKS } from '@space/workspace'
import { closeConversations, openConversation, parseClose, parseEmail, parseReopen, reopenConversations, sendEmail } from '../src/conversation'
import { conversations } from '../src/list'
import { parseView } from '../src/conversations'
import { type StandInThread, standInInbox, standInMeet } from '../src/stand-ins'
import { INBOX_HISTORY_PAGE } from '@space/workspace'
import { ago, contact, dm, person, thread } from './world'
import { OWNER_SIGNED_IN } from './signed-in'

const install = northfield()
const ME = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, install)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const subject = (id: string) => (id === 't1' ? 'Hours' : 'Invoice')
const ok = (body: unknown) => ({ status: 200, body })

describe('what the page says after Close', () => {
  test('all closed is "Closed."; after a send it is "Sent and closed."', () => {
    const got = ok({ state: 'ok', closed: ['t1'], notClosed: [] })
    expect(describeClose(got, { subject, notShown: 0, sent: false })).toEqual({ notice: { tone: 'ok', text: 'Closed.' }, done: ['t1'] })
    expect(describeClose(got, { subject, notShown: 0, sent: true }).notice).toEqual({ tone: 'ok', text: 'Sent and closed.' })
  })

  test('a thread with newer mail is not closed, and the page says which and that it is shown now', () => {
    const got = ok({ state: 'ok', closed: [], notClosed: [{ conversationId: 't1', reason: 'conflict', message: 'x' }] })
    expect(describeClose(got, { subject, notShown: 0, sent: false })).toEqual({ notice: { tone: 'warn', text: 'A new message arrived in "Hours", so it was not closed. It is shown now.' }, done: [], refused: ['t1'] })
    expect(describeClose(got, { subject, notShown: 0, sent: true }).notice.text).toStartWith('Sent, but not closed. A new message arrived')
  })

  test('some closed and some not says how many, and older threads that are not on screen are said to be left open', () => {
    const got = ok({ state: 'ok', closed: ['t2'], notClosed: [{ conversationId: 't1', reason: 'conflict', message: 'x' }] })
    const out = describeClose(got, { subject, notShown: 2, sent: false })
    expect(out.done).toEqual(['t2'])
    expect(out.refused).toEqual(['t1'])
    expect(out.notice.tone).toBe('warn')
    expect(out.notice.text).toContain('Closed 1 of 2.')
    expect(out.notice.text).toContain('2 older email conversations are not on screen, so they were left open.')
    expect(describeClose(ok({ state: 'ok', closed: ['t1'], notClosed: [] }), { subject, notShown: 1, sent: false }).notice.text).toBe('Closed. 1 older email conversation is not on screen, so it was left open.')
  })

  test('an inbox that did not answer, a lost connection and a lost sign-in are each said, and none is called closed', () => {
    expect(describeClose(ok({ state: 'unanswered', message: 'Email took too long to answer.' }), { subject, notShown: 0, sent: false })).toEqual({
      notice: { tone: 'error', text: 'Email took too long to answer. Whether it closed is not known: the conversation is shown as it stands.' },
      done: [],
    })
    expect(describeClose('network', { subject, notShown: 0, sent: false }).notice.text).toContain('not known')
    // None of those is a refusal: the close may have gone through.
    expect(describeClose('network', { subject, notShown: 0, sent: false }).refused).toBeUndefined()
    expect(describeClose(ok({ state: 'unanswered', message: 'x' }), { subject, notShown: 0, sent: false }).refused).toBeUndefined()
    expect(describeClose({ status: 401, body: null }, { subject, notShown: 0, sent: false }).notice.text).toContain('sign-in')
    expect(describeClose({ status: 200, body: { nonsense: true } }, { subject, notShown: 0, sent: false }).done).toEqual([])
  })

  test('Reopen says so, or why not', () => {
    expect(describeReopen(ok({ state: 'ok', reopened: ['t1'], notReopened: [] }), { subject }).notice).toEqual({ tone: 'ok', text: 'Reopened.' })
    expect(describeReopen(ok({ state: 'ok', reopened: [], notReopened: [{ conversationId: 't1', reason: 'conflict', message: 'Everything in it is in the trash.' }] }), { subject }).notice.text).toBe('"Hours" was not reopened. Everything in it is in the trash.')
  })
})

describe('which thread Reopen acts on', () => {
  // Six closed threads on screen, newest first by their `at`.
  const closedThreads = Array.from({ length: 6 }, (_, i) => ({ conversationId: `c${i}`, subject: `Closed ${i}`, at: 1000 - i, open: false }))
  const answer = (over: { open?: { conversationId: string; subject: string; at: number }[] } = {}) =>
    ({
      threads: [...(over.open ?? []).map((t) => ({ ...t, open: true })), ...closedThreads],
      change: { close: (over.open ?? []).map((t) => ({ conversationId: t.conversationId, through: 1 })), notShown: 0, reopen: closedThreads.map((t) => t.conversationId) },
    }) as never

  test('from the Closed view it is ONE thread: the newest closed one, and the button names it', () => {
    const offer = reopenOffer(answer(), { fromClosed: true, lastClosed: [], threadId: null })
    expect(offer).toEqual({ ids: ['c0'], label: 'Reopen "Closed 0"', title: 'Reopen "Closed 0"' })
  })

  test('from the Closed view it is the thread chosen in the reply picker, when that one is closed; an open choice falls back to the newest closed', () => {
    expect(reopenOffer(answer(), { fromClosed: true, lastClosed: [], threadId: 'c3' })?.ids).toEqual(['c3'])
    const withOpen = answer({ open: [{ conversationId: 'o1', subject: 'Open', at: 2000 }] })
    expect(reopenOffer(withOpen, { fromClosed: true, lastClosed: [], threadId: 'o1' })?.ids).toEqual(['c0'])
  })

  test('right after a close it is exactly the threads that close closed, and not the others that were closed before', () => {
    const offer = reopenOffer(answer(), { fromClosed: false, lastClosed: ['c4', 'c5'], threadId: null })
    expect(offer).toMatchObject({ ids: ['c4', 'c5'], label: 'Reopen 2' })
    expect(reopenOffer(answer(), { fromClosed: true, lastClosed: ['c4'], threadId: null })?.ids).toEqual(['c4'])
    expect(reopenOffer(answer(), { fromClosed: false, lastClosed: ['c4'], threadId: null })?.label).toBe('Reopen')
  })

  test('opened from the main list with nothing just closed, there is no Reopen', () => {
    expect(reopenOffer(answer(), { fromClosed: false, lastClosed: [], threadId: null })).toBeNull()
    // A thread that is no longer closed (reopened elsewhere) is not offered.
    expect(reopenOffer(answer(), { fromClosed: false, lastClosed: ['gone'], threadId: null })).toBeNull()
  })
})

describe('the conversation with its closes and reopens still out shown as done', () => {
  const thread2 = (id: string, open: boolean, through = 3) => ({ conversationId: id, subject: id, open, through })
  const base = {
    threads: [thread2('a', true), thread2('b', true, 5), thread2('c', false, 7)],
    change: { close: [{ conversationId: 'a', through: 3 }, { conversationId: 'b', through: 5 }], notShown: 1, reopen: ['c'] },
  } as never

  test('nothing pending is the same object', () => {
    expect(withPending(base, new Map())).toBe(base)
    // Pending that says what is already so changes nothing either.
    expect(withPending(base, new Map([['a', true]]))).toBe(base)
  })

  test('a close pending shows the threads closed, offers them to Reopen, and leaves the others and the count of those off screen', () => {
    const got = withPending(base, new Map([['a', false], ['b', false]])) as unknown as { threads: { conversationId: string; open: boolean }[]; change: { close: unknown[]; reopen: string[]; notShown: number } }
    expect(got.threads.map((t) => t.open)).toEqual([false, false, false])
    expect(got.change.close).toEqual([])
    expect([...got.change.reopen].sort()).toEqual(['a', 'b', 'c'])
    expect(got.change.notShown).toBe(1)
  })

  test('a reopen pending shows the thread open and closable again at the position it was read to', () => {
    const got = withPending(base, new Map([['c', true]])) as unknown as { change: { close: unknown[]; reopen: string[] } }
    expect(got.change.close).toEqual([{ conversationId: 'a', through: 3 }, { conversationId: 'b', through: 5 }, { conversationId: 'c', through: 7 }])
    expect(got.change.reopen).toEqual([])
  })
})

describe('why a Send and close closed nothing', () => {
  const answer = { threads: [{ conversationId: 'closed', open: false }, { conversationId: 'old', open: true }] } as never
  test('in words: a direct message, an already closed thread, a thread that is not on screen', () => {
    expect(whyNotClosed(answer, null)).toBe('A direct message has no Close.')
    expect(whyNotClosed(answer, 'closed')).toBe('That email thread is already closed.')
    expect(whyNotClosed(answer, 'old')).toBe('That email thread is not on screen, so it was left open.')
  })
})

describe('the key c', () => {
  test('is not Close behind a modal, such as the phone’s Views sheet', () => {
    expect(modalOpen({ querySelector: () => null })).toBe(false)
    expect(modalOpen({ querySelector: () => ({}) })).toBe(true)
  })
  test('is Close, for a plain c', () => {
    expect(isCloseKey({ key: 'c' }, false)).toBe(true)
  })
  test('is not Close while typing, held down, a capital, or with a command key', () => {
    expect(isCloseKey({ key: 'c' }, true)).toBe(false)
    expect(isCloseKey({ key: 'c', repeat: true }, false)).toBe(false)
    expect(isCloseKey({ key: 'C', shiftKey: true }, false)).toBe(false)
    for (const mod of ['metaKey', 'ctrlKey', 'altKey'] as const) expect(isCloseKey({ key: 'c', [mod]: true }, false)).toBe(false)
    expect(isCloseKey({ key: 'x' }, false)).toBe(false)
  })
  test('typing is a text box, a choice menu or anything editable', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) expect(typingIn({ tagName })).toBe(true)
    expect(typingIn({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(typingIn({ tagName: 'BUTTON' })).toBe(false)
    expect(typingIn(null)).toBe(false)
  })
})

describe('the bodies the Worker takes', () => {
  test('a close names each conversation and its position; a reopen names conversations', () => {
    expect(parseClose({ mail: [{ conversationId: 't1', through: 2 }] })).toEqual({ ok: true, value: [{ conversationId: 't1', through: 2 }] })
    expect(parseClose({ mail: [{ conversationId: 't1' }] }).ok).toBe(false)
    expect(parseClose({ mail: [] }).ok).toBe(false)
    expect(parseReopen({ mail: ['t1'] })).toEqual({ ok: true, value: ['t1'] })
    expect(parseReopen({ mail: [4] }).ok).toBe(false)
    expect(parseEmail({}).ok).toBe(false)
  })

  test('no more conversations than the inbox takes in one call, the contract’s limit', () => {
    const marks = (n: number) => Array.from({ length: n }, (_, i) => ({ conversationId: `t${i}`, through: 1 }))
    expect(parseClose({ mail: marks(INBOX_MOST_MARKS) }).ok).toBe(true)
    expect(parseClose({ mail: marks(INBOX_MOST_MARKS + 1) }).ok).toBe(false)
    expect(parseReopen({ mail: marks(INBOX_MOST_MARKS).map((m) => m.conversationId) }).ok).toBe(true)
    expect(parseReopen({ mail: marks(INBOX_MOST_MARKS + 1).map((m) => m.conversationId) }).ok).toBe(false)
  })
})

// ── What is drawn ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const ask = (inbox: ReturnType<typeof standInInbox>, meet = standInMeet({ direct: [], channels: [] }, {})) => ({ apps: { inbox, meet }, install, signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 })

const idle = (over: Partial<ViewProps> & Pick<ViewProps, 'answer'>): ViewProps => ({
  me: ME,
  now: T0,
  sources: over.answer.sources,
  loadingEarlier: false,
  onEarlier: () => undefined,
  way: 'email',
  onWay: () => undefined,
  threadId: null,
  onThread: () => undefined,
  compose: typed(newCompose(), 'Thanks'),
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
  ...over,
})
const drawn = (over: Partial<ViewProps> & Pick<ViewProps, 'answer'>) => renderToStaticMarkup(<ConversationView {...idle(over)} />)

const dana = person('p-dana', 'Dana Reyes', 'dana@harbor.example')

async function answerFor(key: string, opts: { open?: boolean; chat?: boolean; noMail?: boolean } = {}) {
  const inbox = standInInbox(
    opts.noMail ? [] : [contact('c-dana', 'Dana Reyes', 'dana@harbor.example')],
    opts.noMail ? [] : [thread('t1', ago(10), ['c-dana'], { subject: 'Hours', open: opts.open ?? true })],
  )
  const meet = standInMeet({ direct: opts.chat ? [dm(11, dana, ago(5), 0)] : [], channels: [] }, { history: { 11: [{ id: 1, at: ago(5), authorId: 'p-dana', authorName: 'Dana', text: 'Hello' }] } })
  const opened = await openConversation(ask(inbox, meet), key)
  if (!opened.ok) throw new Error(opened.message)
  return opened.value
}

describe('what is drawn', () => {
  test('an open email conversation has Close in the header and Send and close in the reply box', async () => {
    const html = drawn({ answer: await answerFor('dana@harbor.example') })
    expect(html).toContain('data-testid="close-conversation"')
    expect(html).toContain('data-testid="send-and-close"')
    expect(html).not.toContain('data-testid="reopen-conversation"')
  })

  test('a row that is only chat has no Close, and no Send and close', async () => {
    const html = drawn({ answer: await answerFor('dana@harbor.example', { chat: true, noMail: true }), way: 'chat' })
    expect(html).toContain('data-testid="composer"')
    expect(html).not.toContain('close-conversation')
    expect(html).not.toContain('send-and-close')
  })

  test('chat chosen on a row that also has email: the reply box has no Send and close', async () => {
    const html = drawn({ answer: await answerFor('dana@harbor.example', { chat: true }), way: 'chat' })
    expect(html).toContain('data-way="chat"')
    expect(html).not.toContain('send-and-close')
  })

  test('a closed conversation has no Close and no Send and close, and Reopen where it is offered', async () => {
    const answer = await answerFor('dana@harbor.example', { open: false })
    expect(answer.change).toMatchObject({ close: [], reopen: ['t1'] })
    const html = drawn({ answer, reopen: { label: 'Reopen "Hours"', title: 'Reopen "Hours"' } })
    expect(html).not.toContain('close-conversation')
    expect(html).not.toContain('send-and-close')
    expect(html).toContain('data-testid="reopen-conversation"')
    expect(html).toContain('Reopen &quot;Hours&quot;')
  })

  test('Send and close is not offered for a thread that is not on screen: an open thread older than the page has unread mail nobody saw', async () => {
    const history = { 11: Array.from({ length: INBOX_HISTORY_PAGE + 10 }, (_, i) => ({ id: i + 1, at: ago(300 - i), authorId: 'p-dana', authorName: 'Dana', text: `Hello ${i}` })) }
    const inbox = standInInbox([contact('c-dana', 'Dana Reyes', 'dana@harbor.example')], [thread('t-old', ago(900), ['c-dana'], { subject: 'Quote', unread: true, messages: [{ id: 'q1', at: ago(900), direction: 'in', from: 'Dana', text: 'Quote?' }] })])
    const meet = standInMeet({ direct: [dm(11, dana, ago(1), 0)], channels: [] }, { history })
    const opened = await openConversation(ask(inbox, meet), 'dana@harbor.example')
    if (!opened.ok) throw new Error(opened.message)
    expect(opened.value.change).toMatchObject({ close: [], notShown: 1 })
    const html = drawn({ answer: opened.value })
    // It is still the default reply thread, and plain Send is there; Close and Send and close are not.
    expect(html).toContain('data-testid="send"')
    expect(html).not.toContain('send-and-close')
    expect(html).not.toContain('close-conversation')
  })

  test('how the last close ended is under the header', async () => {
    const html = drawn({ answer: await answerFor('dana@harbor.example'), changed: { tone: 'warn', text: 'A new message arrived in "Hours", so it was not closed. It is shown now.' } })
    expect(html).toContain('data-testid="change-notice"')
    expect(html).toContain('so it was not closed')
  })
})

// ── The page, in a stand-in DOM ───────────────────────────────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch

describe('the page as a browser runs it', () => {
  beforeAll(() => {
    GlobalRegistrator.register()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterAll(async () => {
    await GlobalRegistrator.unregister()
    globalThis.fetch = realFetch
  })

  async function mount(opts: { search?: string; open?: boolean; threads?: StandInThread[]; slowFirst?: number; evan?: boolean }) {
    changes.reset()
    const inbox = standInInbox(
      [contact('c-dana', 'Dana Reyes', 'dana@harbor.example'), contact('c-evan', 'Evan Ortiz', 'evan@mill.example')],
      opts.threads ?? [thread('t1', ago(10), ['c-dana'], { subject: 'Hours', open: opts.open ?? true }), ...(opts.evan ? [thread('t2', ago(20), ['c-evan'], { subject: 'Invoice' })] : [])],
    )
    // Each close the page makes takes the next of these: held until `hold` is let go, and/or answered as the inbox failing to answer.
    const closes: { hold?: Promise<void>; fail?: boolean }[] = []
    const reopens: { hold?: Promise<void> }[] = []
    // The next read of the conversation is answered late: its answer is made when it is asked for and held back, as a slow network does.
    const slow = { next: opts.slowFirst ?? 0 }
    // The next read of the conversation fails, as a dropped connection does.
    const failing = { next: 0 }
    const a = ask(inbox)
    const wrote: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      const body = init?.body ? JSON.parse(String(init.body)) : null
      if (url.pathname === '/api/conversation') {
        const opened = await openConversation(a, url.searchParams.get('key') ?? '')
        const wait = slow.next
        slow.next = 0
        if (failing.next > 0) {
          failing.next--
          return json({ error: 'down' }, 500)
        }
        if (wait > 0) await sleep(wait)
        return opened.ok ? json(opened.value) : json({ error: opened.message }, opened.status)
      }
      if (url.pathname === '/api/conversations') return json(await conversations(a, parseView(url.searchParams.get('view') ?? undefined, url.searchParams.get('mailbox') ?? undefined) ?? { kind: 'main' }, 'mail'))
      if (url.pathname === '/api/close') {
        wrote.push('close')
        const turn = closes.shift()
        await turn?.hold
        if (turn?.fail) return json({ state: 'unanswered', message: 'Email took too long to answer.' })
        const p = parseClose(body)
        return p.ok ? json(await closeConversations(a, p.value)) : json({ error: p.message }, 400)
      }
      if (url.pathname === '/api/reopen') {
        wrote.push('reopen')
        await reopens.shift()?.hold
        const p = parseReopen(body)
        return p.ok ? json(await reopenConversations(a, p.value)) : json({ error: p.message }, 400)
      }
      if (url.pathname === '/api/email') {
        wrote.push('email')
        const p = parseEmail(body)
        return p.ok ? json(await sendEmail(a, p.value)) : json({ error: p.message }, 400)
      }
      return json({ error: 'no live chat here' }, 403)
    }) as typeof fetch
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { Conversations } = await import('../src/client/Conversations')
    document.body.innerHTML = '<div id="root"></div>'
    const host = document.getElementById('root') as HTMLElement
    const root = createRoot(host)
    const goto = async (pathname: string) =>
      act(async () => {
        root.render(createElement(Conversations, { scope: 'mail', me: ME, pathname, search: opts.search ?? '', go: () => undefined }))
        await sleep(60)
      })
    await goto('/inbox/dana%40harbor.example')
    const press = async (target: Element | Window, key: string) =>
      act(async () => {
        target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }))
        await sleep(60)
      })
    const click = async (testid: string) =>
      act(async () => {
        ;(host.querySelector(`[data-testid="${testid}"]`) as HTMLElement).click()
        await sleep(60)
      })
    const type = async (words: string) =>
      act(async () => {
        const box = host.querySelector('[data-testid="compose-text"]') as HTMLTextAreaElement
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(box, words)
        box.dispatchEvent(new window.Event('input', { bubbles: true }))
        await sleep(10)
      })
    const choose = async (value: string) =>
      act(async () => {
        const select = host.querySelector('[data-testid="thread-select"]') as unknown as HTMLSelectElement
        Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
        select.dispatchEvent(new window.Event('change', { bubbles: true }))
        await sleep(20)
      })
    return { host, inbox, wrote, slow, failing, closes, reopens, goto, press, click, type, choose, unmount: () => act(async () => root.unmount()) }
  }

  test('Close closes the thread, says so, and takes the Close button away; the key c does the same', async () => {
    const s = await mount({})
    expect(s.host.querySelector('[data-testid="close-conversation"]')).not.toBeNull()
    await s.click('close-conversation')
    expect(s.inbox.asked.closes).toEqual([[{ conversationId: 't1', through: 1 }]])
    expect(s.inbox.threads()[0]?.open).toBe(false)
    expect(s.host.querySelector('[data-testid="change-notice"]')?.textContent).toContain('Closed.')
    expect(s.host.querySelector('[data-testid="close-conversation"]')).toBeNull()
    // Closed here, so a mistaken Close can be undone here: Reopen brings it back.
    await sleep(450)
    await s.click('reopen-conversation')
    expect(s.inbox.threads()[0]?.open).toBe(true)
    expect(s.host.querySelector('[data-testid="change-notice"]')?.textContent).toContain('Reopened.')
    // The key.
    await s.press(document.body, 'c')
    expect(s.inbox.asked.closes).toHaveLength(2)
    expect(s.inbox.threads()[0]?.open).toBe(false)
    await s.unmount()
  })

  // ── Close and Reopen do not make the person wait for the inbox (changes.ts) ──
  const hold = () => {
    let go!: () => void
    const held = new Promise<void>((r) => (go = r))
    return { held, go }
  }
  const release = async (g: { go(): void }) => (await import('react')).act(async () => g.go())
  const settleFor = async (ms = 150) => (await import('react')).act(async () => void (await sleep(ms)))
  const texts = (host: HTMLElement) => [...host.querySelectorAll('[data-testid="change-notice"]')].map((n) => n.querySelector('span')?.textContent ?? null)
  const listText = (host: HTMLElement) => host.querySelector('.list')?.textContent ?? ''

  test('Close moves the screen on at once: closed, Reopen offered, the row gone from the list, while the inbox has not answered', async () => {
    const s = await mount({})
    expect(listText(s.host)).toContain('Dana Reyes')
    const gate = hold()
    s.closes.push({ hold: gate.held })
    await s.click('close-conversation')
    // The call is out and held: nothing is closed at the inbox yet.
    expect(s.wrote).toEqual(['close'])
    expect(s.inbox.threads()[0]?.open).toBe(true)
    expect(s.host.querySelector('[data-testid="close-conversation"]')).toBeNull()
    expect(s.host.querySelector('[data-testid="reopen-conversation"]')).not.toBeNull()
    expect(texts(s.host)).toEqual(['Closed.'])
    expect(listText(s.host)).not.toContain('Dana Reyes')
    await release(gate)
    await settleFor()
    expect(s.inbox.threads()[0]?.open).toBe(false)
    expect(s.host.querySelector('[data-testid="close-conversation"]')).toBeNull()
    expect(texts(s.host)).toEqual(['Closed.'])
    expect(listText(s.host)).not.toContain('Dana Reyes')
    await s.unmount()
  })

  test('a Close the inbox does not answer brings the conversation back, in the list and on screen, with the notice it always had', async () => {
    const s = await mount({})
    const gate = hold()
    s.closes.push({ hold: gate.held, fail: true })
    await s.click('close-conversation')
    expect(s.host.querySelector('[data-testid="close-conversation"]')).toBeNull()
    await release(gate)
    await settleFor()
    expect(s.inbox.threads()[0]?.open).toBe(true)
    expect(s.host.querySelector('[data-testid="close-conversation"]')).not.toBeNull()
    expect(s.host.querySelector('[data-testid="reopen-conversation"]')).toBeNull()
    expect(texts(s.host)).toEqual(['Email took too long to answer. Whether it closed is not known: the conversation is shown as it stands.'])
    expect(listText(s.host)).toContain('Dana Reyes')
    await s.unmount()
  })

  test('a Close refused for newer mail that arrived while it was out brings it back and says which', async () => {
    const s = await mount({})
    const gate = hold()
    s.closes.push({ hold: gate.held })
    await s.click('close-conversation')
    s.inbox.arrive('t1', { id: 'm-new', at: ago(1), direction: 'in', from: 'Dana', text: 'Wait.' })
    await release(gate)
    await settleFor()
    expect(s.inbox.threads()[0]?.open ?? true).toBe(true)
    expect(s.host.querySelector('[data-testid="close-conversation"]')).not.toBeNull()
    expect(texts(s.host)).toEqual(['A new message arrived in "Hours", so it was not closed. It is shown now.'])
    await s.unmount()
  })

  test('Closes in a row each go through, in order, and one failing does not hide the other', async () => {
    const s = await mount({ evan: true })
    const first = hold()
    s.closes.push({ hold: first.held, fail: true }, {})
    await s.click('close-conversation')
    // Moved on to the next conversation straight away and closed that one too, while the first is still out.
    await s.goto('/inbox/evan%40mill.example')
    await s.click('close-conversation')
    expect(texts(s.host)).toEqual(['Closed.'])
    expect(s.host.querySelector('[data-testid="reopen-conversation"]')).not.toBeNull()
    // The second waits its turn: the inbox has been asked once.
    expect(s.wrote).toEqual(['close'])
    await release(first)
    await settleFor(250)
    expect(s.wrote).toEqual(['close', 'close'])
    expect(s.inbox.asked.closes.map((c) => c.map((m) => m.conversationId))).toEqual([['t2']])
    expect(s.inbox.threads().map((t) => [t.id, t.open ?? true])).toEqual([['t1', true], ['t2', false]])
    // Evan's says it was closed; Dana's failure is told in Dana's conversation, where it is waiting.
    expect(texts(s.host)).toEqual(['Closed.'])
    await s.goto('/inbox/dana%40harbor.example')
    expect(s.host.querySelector('[data-testid="close-conversation"]')).not.toBeNull()
    expect(texts(s.host)).toEqual(['Email took too long to answer. Whether it closed is not known: the conversation is shown as it stands.'])
    await s.unmount()
  })

  test('the key c pressed twice quickly closes once: the second is not an undo', async () => {
    const s = await mount({})
    const gate = hold()
    s.closes.push({ hold: gate.held })
    await s.press(document.body, 'c')
    await s.press(document.body, 'c')
    expect(s.wrote).toEqual(['close'])
    await release(gate)
    await settleFor()
    expect(s.wrote).toEqual(['close'])
    expect(s.inbox.threads()[0]?.open).toBe(false)
    // Once the inbox has answered, c is the undo it always was.
    await s.press(document.body, 'c')
    expect(s.wrote).toEqual(['close', 'reopen'])
    expect(s.inbox.threads()[0]?.open).toBe(true)
    await s.unmount()
  })

  test('Reopen pressed while its Close is still out waits for it and goes after it', async () => {
    const s = await mount({})
    const gate = hold()
    s.closes.push({ hold: gate.held })
    await s.click('close-conversation')
    await sleep(450)
    await s.click('reopen-conversation')
    // On screen it is open again at once; the inbox has been asked to close it and has not been asked to reopen it.
    expect(s.host.querySelector('[data-testid="close-conversation"]')).not.toBeNull()
    expect(s.wrote).toEqual(['close'])
    await release(gate)
    await settleFor(250)
    expect(s.wrote).toEqual(['close', 'reopen'])
    expect(s.inbox.asked.reopens).toEqual([['t1']])
    expect(s.inbox.threads()[0]?.open).toBe(true)
    expect(s.host.querySelector('[data-testid="close-conversation"]')).not.toBeNull()
    expect(texts(s.host)).toEqual(['Reopened.'])
    expect(listText(s.host)).toContain('Dana Reyes')
    await s.unmount()
  })

  test('a Reopen waiting behind a Close the inbox REFUSED is not made: there is nothing to reopen, and the refusal stays told', async () => {
    const s = await mount({})
    const gate = hold()
    s.closes.push({ hold: gate.held })
    await s.click('close-conversation')
    await sleep(450)
    await s.click('reopen-conversation')
    s.inbox.arrive('t1', { id: 'm-new', at: ago(1), direction: 'in', from: 'Dana', text: 'Wait.' })
    await release(gate)
    await settleFor(250)
    expect(s.wrote).toEqual(['close'])
    expect(s.inbox.threads()[0]?.open ?? true).toBe(true)
    expect(s.host.querySelector('[data-testid="close-conversation"]')).not.toBeNull()
    expect(texts(s.host)).toEqual(['A new message arrived in "Hours", so it was not closed. It is shown now.'])
    await s.unmount()
  })

  test('a Reopen waiting behind a Close whose outcome is not known is still sent: the close may have gone through', async () => {
    const s = await mount({})
    const gate = hold()
    s.closes.push({ hold: gate.held, fail: true })
    await s.click('close-conversation')
    await sleep(450)
    await s.click('reopen-conversation')
    await release(gate)
    await settleFor(250)
    expect(s.wrote).toEqual(['close', 'reopen'])
    expect(s.inbox.threads()[0]?.open).toBe(true)
    await s.unmount()
  })

  test('the second click of a double click on Close does not land on Reopen and undo it', async () => {
    const s = await mount({})
    await s.click('close-conversation')
    // Right after: the Reopen that replaced Close, pressed again within the double-click window.
    await s.click('reopen-conversation')
    await settleFor()
    expect(s.wrote).toEqual(['close'])
    expect(s.inbox.threads()[0]?.open).toBe(false)
    // Later, a click that is the second of a double click is not an undo either; a single one is.
    await sleep(450)
    const act = (await import('react')).act
    await act(async () => {
      ;(s.host.querySelector('[data-testid="reopen-conversation"]') as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 2 }))
      await sleep(80)
    })
    expect(s.wrote).toEqual(['close'])
    await s.click('reopen-conversation')
    expect(s.wrote).toEqual(['close', 'reopen'])
    await s.unmount()
  })

  test('a failure is told in the conversation it is about and in no other, can be dismissed, and is put away when that conversation is left', async () => {
    const s = await mount({ evan: true })
    s.closes.push({ fail: true })
    await s.click('close-conversation')
    await settleFor()
    expect(texts(s.host)).toEqual(['Email took too long to answer. Whether it closed is not known: the conversation is shown as it stands.'])
    // Another conversation does not carry it.
    await s.goto('/inbox/evan%40mill.example')
    expect(texts(s.host)).toEqual([])
    // Left, it is put away; back in, there is nothing to dismiss.
    await s.goto('/inbox/dana%40harbor.example')
    expect(texts(s.host)).toEqual([])
    // A failure can be dismissed where it is shown.
    s.closes.push({ fail: true })
    await s.click('close-conversation')
    await settleFor()
    expect(texts(s.host)).toHaveLength(1)
    await s.click('change-dismiss')
    expect(texts(s.host)).toEqual([])
    await s.unmount()
  })

  test('a failure that arrives while the person is in another conversation is waiting when they come back', async () => {
    const s = await mount({ evan: true })
    const gate = hold()
    s.closes.push({ hold: gate.held, fail: true })
    await s.click('close-conversation')
    await s.goto('/inbox/evan%40mill.example')
    await release(gate)
    await settleFor()
    expect(texts(s.host)).toEqual([])
    await s.goto('/inbox/dana%40harbor.example')
    expect(texts(s.host)).toEqual(['Email took too long to answer. Whether it closed is not known: the conversation is shown as it stands.'])
    expect(s.host.querySelector('[data-testid="close-conversation"]')).not.toBeNull()
    await s.unmount()
  })

  test('the key c does nothing while a reply is being typed', async () => {
    const s = await mount({})
    const box = s.host.querySelector('[data-testid="compose-text"]') as HTMLTextAreaElement
    await s.press(box, 'c')
    expect(s.inbox.asked.closes).toEqual([])
    expect(s.inbox.threads()[0]?.open).toBe(true)
    await s.unmount()
  })

  test('a thread that got newer mail since it was drawn is not closed, and the page says so', async () => {
    const s = await mount({})
    s.inbox.arrive('t1', { id: 'm-new', at: ago(1), direction: 'in', from: 'Dana', text: 'Wait.' })
    await s.click('close-conversation')
    expect(s.inbox.threads()[0]?.open ?? true).toBe(true)
    expect(s.host.querySelector('[data-testid="change-notice"]')?.textContent).toContain('A new message arrived in "Hours", so it was not closed. It is shown now.')
    // It was read again: the button is still there, and now closes at the new position.
    await s.click('close-conversation')
    expect(s.inbox.threads()[0]?.open).toBe(false)
    await s.unmount()
  })

  test('Send and close sends the reply and then closes the thread it went in', async () => {
    const s = await mount({})
    await s.type('Thanks, we are open nine to five.')
    await s.click('send-and-close')
    expect(s.wrote).toEqual(['email', 'close'])
    expect(s.inbox.sent).toHaveLength(1)
    expect(s.inbox.threads()[0]?.open).toBe(false)
    expect(s.host.querySelector('[data-testid="change-notice"]')?.textContent).toContain('Sent and closed.')
    await s.unmount()
  })

  test('plain Send leaves it open', async () => {
    const s = await mount({})
    await s.type('Thanks.')
    await s.click('send')
    expect(s.wrote).toEqual(['email'])
    expect(s.inbox.threads()[0]?.open).toBe(true)
    await s.unmount()
  })

  test('a conversation opened from the Closed view offers Reopen, which brings it back', async () => {
    const s = await mount({ search: '?view=closed', open: false })
    expect(s.host.querySelector('[data-testid="close-conversation"]')).toBeNull()
    await s.click('reopen-conversation')
    expect(s.inbox.asked.reopens).toEqual([['t1']])
    expect(s.inbox.threads()[0]?.open).toBe(true)
    expect(s.host.querySelector('[data-testid="close-conversation"]')).not.toBeNull()
    await s.unmount()
  })

  const six = () => Array.from({ length: 6 }, (_, i) => thread(`t-closed-${i}`, ago(100 + i), ['c-dana'], { subject: `Closed ${i}`, open: false }))

  test('from the Closed view Reopen brings back ONE thread, the newest, and names it: the other five stay closed', async () => {
    const s = await mount({ search: '?view=closed', threads: six() })
    expect(s.host.querySelector('[data-testid="reopen-conversation"]')?.textContent).toBe('Reopen "Closed 0"')
    await s.click('reopen-conversation')
    expect(s.inbox.asked.reopens).toEqual([['t-closed-0']])
    expect(s.inbox.threads().filter((t) => t.open ?? true).map((t) => t.id)).toEqual(['t-closed-0'])
    await s.unmount()
  })

  test('from the Closed view Reopen follows the thread chosen in the reply picker', async () => {
    const s = await mount({ search: '?view=closed', threads: six() })
    await s.choose('t-closed-3')
    expect(s.host.querySelector('[data-testid="reopen-conversation"]')?.textContent).toBe('Reopen "Closed 3"')
    await s.click('reopen-conversation')
    expect(s.inbox.asked.reopens).toEqual([['t-closed-3']])
    await s.unmount()
  })

  test('the undo right after a Close brings back exactly the threads that Close closed, not the ones closed long ago', async () => {
    const threads = [thread('t-a', ago(10), ['c-dana'], { subject: 'A' }), thread('t-b', ago(20), ['c-dana'], { subject: 'B' }), ...six()]
    const s = await mount({ threads })
    await s.click('close-conversation')
    expect(s.inbox.asked.closes[0]?.map((m) => m.conversationId).sort()).toEqual(['t-a', 't-b'])
    expect(s.host.querySelector('[data-testid="reopen-conversation"]')?.textContent).toBe('Reopen 2')
    await sleep(450)
    await s.click('reopen-conversation')
    expect([...(s.inbox.asked.reopens[0] ?? [])].sort()).toEqual(['t-a', 't-b'])
    expect(s.inbox.threads().filter((t) => !(t.open ?? true)).map((t) => t.id).sort()).toEqual(six().map((t) => t.id).sort())
    await s.unmount()
  })

  test('the key c does nothing behind a modal, such as the phone’s Views sheet', async () => {
    const s = await mount({})
    const sheet = document.createElement('div')
    sheet.setAttribute('aria-modal', 'true')
    document.body.appendChild(sheet)
    await s.press(document.body, 'c')
    expect(s.inbox.asked.closes).toEqual([])
    sheet.remove()
    await s.press(document.body, 'c')
    expect(s.inbox.asked.closes).toHaveLength(1)
    await s.unmount()
  })

  test('a slow read that was started before a close does not land after it and put the thread back as open', async () => {
    const s = await mount({})
    // A refresh (the page shown again) is in flight and late when Close is pressed; its old, open answer must not be the last word.
    s.slow.next = 250
    const act = (await import('react')).act
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'))
      await sleep(30)
    })
    await s.click('close-conversation')
    expect(s.host.querySelector('[data-testid="close-conversation"]')).toBeNull()
    await act(async () => {
      await sleep(350)
    })
    expect(s.host.querySelector('[data-testid="close-conversation"]')).toBeNull()
    expect(s.host.querySelector('[data-testid="change-notice"]')?.textContent).toContain('Closed.')
    await s.unmount()
  })

  test('a slow first read that lands after a refresh that failed is shown: the pane is not left on "Opening the conversation"', async () => {
    const s = await mount({ slowFirst: 300 })
    expect(s.host.querySelector('[data-testid="convo-loading"]')).not.toBeNull()
    // The page is shown again while the first read is still out; that quiet read fails and sets nothing.
    s.failing.next = 1
    const act = (await import('react')).act
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'))
      await sleep(40)
    })
    await act(async () => {
      await sleep(350)
    })
    expect(s.host.querySelector('[data-testid="convo-loading"]')).toBeNull()
    expect(s.host.querySelector('[data-testid="close-conversation"]')).not.toBeNull()
    await s.unmount()
  })

  test('Cmd+Shift+Enter on a thread that cannot be closed sends, and says it was sent but not closed, and why', async () => {
    const s = await mount({ open: false })
    await s.type('Thanks.')
    const box = s.host.querySelector('[data-testid="compose-text"]') as HTMLTextAreaElement
    const act = (await import('react')).act
    await act(async () => {
      box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, shiftKey: true, bubbles: true }))
      await sleep(80)
    })
    expect(s.wrote).toEqual(['email'])
    expect(s.host.querySelector('[data-testid="change-notice"]')?.textContent).toBe('Sent, but not closed. That email thread is already closed.')
    await s.unmount()
  })

  test('Send and close reads the conversation once for the reply that went and once when the close ended, so the close’s is the last word', async () => {
    const s = await mount({})
    let reads = 0
    const through = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input), 'http://localhost').pathname === '/api/conversation') reads++
      return through(input, init)
    }) as typeof fetch
    await s.type('Thanks.')
    await s.click('send-and-close')
    expect(s.wrote).toEqual(['email', 'close'])
    // The reply is read in at once, and the close's end reads again: that one, begun after the close ended, is the last word.
    expect(reads).toBe(2)
    expect(s.host.querySelector('[data-testid="close-conversation"]')).toBeNull()
    await s.unmount()
  })

  test('Send and close when Gmail does not say whether the email went out: it says so, and closes nothing', async () => {
    const s = await mount({})
    s.inbox.script.send.push('sending')
    await s.type('Thanks.')
    await s.click('send-and-close')
    expect(s.wrote).toEqual(['email'])
    expect(s.inbox.threads()[0]?.open ?? true).toBe(true)
    expect(s.host.querySelector('[data-testid="change-notice"]')?.textContent).toBe('Not closed: Gmail did not say whether the email went out.')
    await s.unmount()
  })

  test('a conversation opened from the main list does not offer Reopen when it was closed before', async () => {
    const s = await mount({ open: false })
    expect(s.host.querySelector('[data-testid="reopen-conversation"]')).toBeNull()
    await s.unmount()
  })
})
