// The space's screens for Tessa's texts. The words of the bridge's state (one function, said on the menu's foot and on the Settings card alike), the Text row and its one pill, the menu's Texts entry, the history,
// the Settings card with the chats left out and Bring back, and Leave this chat out with the step that says what it does. Over the real merge and the real views over the stand-in inbox; the fixtures (src/stand-ins.ts) are
// the invented people the e2e photographs.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { InboxNav, InboxTexts } from '@space/workspace'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { renderToStaticMarkup } from 'react-dom/server'
import { northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { newCompose } from '../src/client/compose'
import { ConversationsScreen } from '../src/client/Conversations'
import { replyWays } from '../src/client/convo'
import { LEAVE_OUT_WORDS } from '../src/client/Conversation'
import { SettingsFoot, statusLines, treeOf } from '../src/client/nav'
import { TextsCard } from '../src/client/Settings'
import { textsWords } from '../src/client/texts'
import { MAIN } from '../src/conversations'
import { openConversation } from '../src/conversation'
import { fixtureViews } from '../src/fixture-views'
import { conversations } from '../src/list'
import { fixtureApps } from '../src/stand-ins'
import { type ReadName, readView, writeView } from '../src/views'
import { OWNER_SIGNED_IN } from './signed-in'

const ME = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, northfield())
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const MIN = 60_000
const NOW = Date.UTC(2026, 10, 5, 18, 0, 0)
const noop = () => undefined
const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>)

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const at = (minutesAgo: number) => NOW - minutesAgo * MIN

describe('what the page says of the texts bridge', () => {
  test('one sentence for each state, with the time in the person’s zone and amber only where something needs a look', () => {
    const words = (t: Parameters<typeof textsWords>[0]) => textsWords(t, NOW, 'UTC')
    expect(words({ state: 'live', checkedInAt: at(0.2), lastPushAt: at(6) })).toEqual({ text: 'Texts are live, last text 6 min ago.', amber: false })
    expect(words({ state: 'live', checkedInAt: at(0.2), lastPushAt: null })).toEqual({ text: 'Texts are live, no texts yet.', amber: false })
    expect(words({ state: 'catching-up', checkedInAt: at(0.2), lastPushAt: at(60) })).toEqual({ text: 'Texts are catching up.', amber: false })
    expect(words({ state: 'phone-not-answering', checkedInAt: at(0.2), lastPushAt: at(60), phoneSince: at(95) })).toEqual({
      text: 'Your phone is not answering since 4:25 PM. Texts will catch up when it is back.',
      amber: false,
    })
    expect(words({ state: 'session-taken', checkedInAt: at(0.2), lastPushAt: at(60) })).toEqual({ text: 'Another browser took the Messages for web session; the bridge is taking it back.', amber: false })
    expect(words({ state: 'signed-out', checkedInAt: at(180), lastPushAt: at(180) })).toEqual({ text: 'Google ended the texts bridge’s sign-in. Only you can sign in again.', amber: true })
    expect(words({ state: 'not-checked-in', checkedInAt: at(20), lastPushAt: at(60) })).toEqual({ text: 'The texts bridge has not checked in since 5:40 PM.', amber: true })
    expect(words({ state: 'not-checked-in', checkedInAt: null, lastPushAt: null })).toEqual({ text: 'The texts bridge has not checked in yet.', amber: true })
  })
})

describe('the menu', () => {
  const nav = (over: Partial<NonNullable<InboxNav['texts']>> | null): InboxNav => ({
    views: { inbox: { count: 3, unread: 1 }, unread: { count: 1, unread: 0 }, drafts: { count: 0, unread: 0 }, bulk: { count: 0, unread: 0 }, closed: { count: 0, unread: 0 } },
    mailboxes: [],
    clients: [],
    contacts: 3,
    gmailAccounts: [],
    ...(over !== null && { texts: { id: 'tx-1', name: 'Texts', address: 'phone-1', count: 2, unread: 1, state: 'live', checkedInAt: NOW - 30_000, lastPushAt: NOW - 6 * MIN, phoneSince: null, ...over } }),
  })

  test('Texts is in the Mailboxes tree with its rows, like a business mailbox, and not in the menu of an inbox that has none', () => {
    expect(treeOf(nav({}), 'all', true).mailboxes).toEqual([{ key: 'mailbox:tx-1', label: 'Texts', href: '/inbox?view=mailbox%3Atx-1', unread: 1, count: 2, active: false, title: 'phone-1' }])
    expect(treeOf(nav(null), 'all', true).mailboxes).toEqual([])
    expect(treeOf(nav({}), 'mailbox:tx-1', true).mailboxes[0]?.active).toBe(true)
  })

  const card = (t: NonNullable<InboxNav['texts']>, leftOut: InboxTexts['leftOut'] = []) => (
    <TextsCard
      texts={{ id: t.id, name: t.name, address: t.address, state: t.state, reportedAt: t.checkedInAt, checkedInAt: t.checkedInAt, lastPushAt: t.lastPushAt, phoneSince: t.phoneSince, messages: 58, conversations: 5, open: 3, unreadOpen: 2, leftOut }}
      now={NOW}
      zone="UTC"
    />
  )

  test('the foot says the bridge’s sentence, amber when signed out or silent for five minutes, and the card says the very same', () => {
    for (const [over, amber] of [
      [{}, false],
      [{ state: 'catching-up' as const }, false],
      [{ state: 'phone-not-answering' as const, phoneSince: NOW - 95 * MIN }, false],
      [{ state: 'session-taken' as const }, false],
      [{ state: 'signed-out' as const }, true],
      [{ state: 'not-checked-in' as const, checkedInAt: NOW - 20 * MIN }, true],
    ] as const) {
      const t = { ...(nav({}).texts as NonNullable<InboxNav['texts']>), ...over }
      const line = statusLines({ ...nav({}), texts: t }, NOW, 'UTC').find((l) => l.key === 'texts:tx-1')
      expect(line).toMatchObject({ key: 'texts:tx-1', amber })
      const sentence = textsWords(t, NOW, 'UTC').text
      expect(line?.text).toBe(sentence)
      const markup = html(card(t))
      expect(markup.replace(/&#x27;/g, "'")).toContain(sentence.replace(/’/g, '’'))
      expect(markup).toContain(`data-state="${t.state}"`)
      expect(markup.includes('s-card amber')).toBe(amber)
    }
    expect(statusLines(nav(null), NOW).filter((l) => l.key.startsWith('texts'))).toEqual([])
  })

  test('drawn at the foot of the rail: the amber line carries the amber dot after five minutes without a check-in', () => {
    const t = nav({ state: 'not-checked-in', checkedInAt: NOW - 6 * MIN })
    const markup = html(<SettingsFoot nav={{ kind: 'value', value: t }} now={NOW} active={false} go={noop} />)
    expect(markup).toContain('The texts bridge has not checked in since')
    expect(markup).toContain('data-amber="true"')
  })

  test('the card lists the chats left out, each with Bring back; one already brought back says its read is on its way and offers nothing', () => {
    const t = nav({}).texts as NonNullable<InboxNav['texts']>
    const none = html(card(t))
    expect(none).toContain('data-testid="texts-left-out"')
    expect(none).not.toContain('bring-back')
    const markup = html(
      card(t, [
        { chatId: 'c-8001', name: 'Mum', at: at(60 * 24 * 3), fillOwed: false },
        { chatId: 'c-8002', name: 'Pool club', at: at(60 * 24 * 9), fillOwed: true },
      ]),
    )
    expect(markup.match(/data-testid="texts-left-out-row"/g)).toHaveLength(2)
    expect(markup.match(/data-testid="bring-back"/g)).toHaveLength(1)
    expect(markup).toContain('Mum')
    expect(markup).toContain('Reading its last 30 days...')
  })
})

describe('Settings reads the card from the inbox’s answer', () => {
  const ask = (inbox: ReturnType<typeof fixtureApps>['inbox']) => ({ apps: { inbox, meet: undefined }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }) as never
  const view = async (inbox: ReturnType<typeof fixtureApps>['inbox'], name: string) => {
    const r = await readView(ask(inbox), name as ReadName, new URLSearchParams())
    if (!r.ok) throw new Error(r.message)
    return r.value as { result: string; value: { texts?: { state: string; name: string; leftOut: unknown[] } | null } }
  }

  test('the fixtures’ card is read whole, with its left-out list, and a card in a shape nobody promised is never half read', async () => {
    const apps = fixtureApps(NOW)
    const card = (await view(apps.inbox, 'mailboxes')).value.texts
    expect(card).toMatchObject({ state: 'live', name: 'Texts' })
    expect(card?.leftOut).toHaveLength(2)
    expect((await view(apps.inbox, 'navigation')).value.texts).toMatchObject({ name: 'Texts', state: 'live' })
    const bad = fixtureApps(NOW)
    const real = bad.inbox.mailboxes.bind(bad.inbox)
    bad.inbox.mailboxes = async (a) => {
      const r = await real(a)
      return r.ok ? ({ ...r, value: { ...r.value, texts: { ...(r.value.texts as object), state: 'on fire' } } } as never) : r
    }
    expect((await view(bad.inbox, 'mailboxes')).result).not.toBe('ok')
  })

  test('the fixtures show the states the e2e photographs', () => {
    expect(fixtureViews(NOW, 'live', 'live', 'late').texts).toMatchObject({ state: 'not-checked-in' })
    expect(fixtureViews(NOW, 'live', 'live', 'signed-out').texts).toMatchObject({ state: 'signed-out' })
    expect(fixtureViews(NOW, 'live', 'live', 'phone-off').texts).toMatchObject({ state: 'phone-not-answering' })
  })
})

describe('Bring back and Leave this chat out, written through the views', () => {
  const ask = (apps: ReturnType<typeof fixtureApps>) => ({ apps: { inbox: apps.inbox, meet: apps.meet }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }) as never

  test('a chat on the list is brought back and shows its read as owed; one not on it, and a malformed name, are refused', async () => {
    const apps = fixtureApps(NOW)
    expect((await writeView(ask(apps), 'text-bring-back', { chatId: 'c-8001' }, null)).ok).toBe(true)
    expect(apps.inbox.views.state.texts?.leftOut.find((l) => l.chatId === 'c-8001')?.fillOwed).toBe(true)
    expect(JSON.stringify(await writeView(ask(apps), 'text-bring-back', { chatId: 'c-8001' }, null))).toContain('not-found')
    expect((await writeView(ask(apps), 'text-bring-back', { chatId: 'a b' }, null)).ok).toBe(false)
    expect((await writeView(ask(apps), 'text-bring-back', {}, null)).ok).toBe(false)
  })

  test('leaving a chat out takes its conversation off the space and puts it on the list; a conversation that is not a text chat is refused', async () => {
    const apps = fixtureApps(NOW)
    const before = apps.inbox.views.state.texts?.leftOut.length ?? 0
    const done = await writeView(ask(apps), 'text-leave-out', { conversationId: 't-tx-eli' }, null)
    expect(done.ok).toBe(true)
    expect(apps.inbox.views.state.texts?.leftOut.length).toBe(before + 1)
    expect(apps.inbox.views.state.texts?.leftOut[0]?.name).toBe('Eli Park')
    expect(JSON.stringify(await writeView(ask(apps), 'text-leave-out', { conversationId: 't-tx-eli' }, null))).toContain('not-found')
    expect(JSON.stringify(await writeView(ask(apps), 'text-leave-out', { conversationId: 't-dana-1' }, null))).toContain('not-found')
    expect((await writeView(ask(apps), 'text-leave-out', {}, null)).ok).toBe(false)
  })
})

describe('the Inbox’s text rows', () => {
  const apps = () => {
    const { inbox, meet } = fixtureApps(NOW)
    return { apps: { inbox, meet }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }
  }
  const screen = (answer: Awaited<ReturnType<typeof conversations>>, view: Parameters<typeof ConversationsScreen>[0]['view'] = 'all') =>
    renderToStaticMarkup(<ConversationsScreen me={ME} now={NOW} answer={answer} loading={false} problem={null} view={view} who="all" onWho={noop} query="" onQuery={noop} results={null} live="off" selected={null} go={noop} />)
  const rowsOf = (markup: string) => [...markup.matchAll(/<a class="row[^"]*" href="([^"]+)"[^>]*data-key="([^"]+)".*?<\/a>/gs)].map((m) => ({ key: m[2]!, html: m[0] }))

  test('a person who only texts is a row opened by their contact, with one Text pill (the mailbox is not named again) and the last thing said', async () => {
    const rows = rowsOf(screen(await conversations(apps(), MAIN, 'mail')))
    const eli = rows.find((r) => r.key === 'mail:c-tx-eli')
    expect(eli?.html).toContain('Eli Park')
    expect(eli?.html).toContain('Are we still on for Saturday morning?')
    expect(eli?.html).toContain('data-testid="texts-pill"')
    expect(eli?.html).toContain('data-came="sms"')
    expect(eli?.html.match(/>Text</g)?.length).toBe(1)
    expect(eli?.html).not.toContain('data-testid="mailbox-tag"')
    expect(eli?.html).toContain('class="row unread"')
  })

  test('a business sender is in Bulk, never the Inbox, and its row is a Text too', async () => {
    expect(rowsOf(screen(await conversations(apps(), MAIN, 'mail'))).map((r) => r.key)).not.toContain('mail:c-tx-bank')
    const bulk = rowsOf(screen(await conversations(apps(), { kind: 'bulk' }, 'mail'), 'bulk'))
    const bank = bulk.find((r) => r.key === 'mail:c-tx-bank')
    expect(bank?.html).toContain('Example Bank')
    expect(bank?.html).toContain('Your Example Bank code is 481516')
    expect(bank?.html).toContain('data-testid="texts-pill"')
  })

  test('the Texts entry of the menu narrows the list to its rows', async () => {
    const answer = await conversations(apps(), MAIN, 'mail')
    expect(answer.mailboxes.map((m) => m.name)).toContain('Texts')
  })
})

describe('a text conversation', () => {
  async function open(key: string) {
    const { inbox, meet } = fixtureApps(NOW)
    const opened = await openConversation({ apps: { inbox, meet }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }, key)
    if (!opened.ok) throw new Error(opened.message)
    return opened.value
  }
  async function draw(key: string, extra: Record<string, unknown> = {}) {
    const answer = await open(key)
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { ConversationView } = await import('../src/client/Conversation')
    document.body.innerHTML = '<div id="root"></div>'
    const host = document.getElementById('root') as HTMLElement
    const root = createRoot(host)
    await act(async () => {
      root.render(
        createElement(ConversationView, {
          me: ME,
          now: NOW,
          answer,
          sources: answer.sources,
          loadingEarlier: false,
          onEarlier: noop,
          way: 'email' as const,
          onWay: noop,
          threadId: null,
          onThread: noop,
          compose: newCompose(),
          onText: noop,
          onSend: noop,
          onSendAndClose: noop,
          onClose: noop,
          onReopen: noop,
          reopen: null,
          changing: false,
          changed: null,
          onDismiss: noop,
          drafts: {},
          onSendDraft: noop,
          onDismissDraft: noop,
          onDraftChanged: noop,
          profileOpen: false,
          onProfile: noop,
          onBack: noop,
          timeZone: 'UTC',
          ...extra,
        } as never),
      )
      await sleep(10)
    })
    return { host, answer, act, done: () => act(async () => root.unmount()) }
  }

  test('draws every text as a bubble, mine on the right, under the heading Text messages, and its thread is a text chat', async () => {
    const { host, answer, done } = await draw('mail:c-tx-eli')
    const entries = [...host.querySelectorAll('[data-testid="entry"]')] as HTMLElement[]
    expect(entries).toHaveLength(3)
    expect(entries[1]?.className).toContain('mine')
    expect(entries[2]?.textContent).toContain('Are we still on for Saturday morning?')
    expect(host.querySelector('[data-testid="heading"]')?.textContent).toContain('Text messages')
    expect(answer.threads[0]?.textChat).toBe(true)
    // Until sending comes a text is answered by hand: no thread to send on.
    expect(answer.threads[0]?.canReply).toBe(false)
    expect(replyWays(answer).email).toEqual([])
    await done()
  })

  test('a person who writes by email and by text is one conversation with both histories, each under its own heading', async () => {
    const { host, done } = await draw('dana@harbordental.example')
    const headings = [...host.querySelectorAll('[data-testid="heading"]')].map((h) => h.textContent ?? '')
    expect(headings.some((h) => h.includes('Text messages'))).toBe(true)
    expect(headings.some((h) => h.includes('Email: '))).toBe(true)
    await done()
  })

  test('Leave this chat out is on a text chat and not on an email thread; it says what it does before it does it, and then leaves it out', async () => {
    const left: string[] = []
    const { host, act, done } = await draw('mail:c-tx-eli', { onLeaveOut: (id: string) => left.push(id) })
    expect(host.querySelectorAll('[data-testid="leave-out"]')).toHaveLength(1)
    expect(host.querySelector('[data-testid="leave-out-confirm"]')).toBeNull()
    await act(async () => {
      ;(host.querySelector('[data-testid="leave-out"]') as HTMLElement).click()
      await sleep(5)
    })
    expect(host.querySelector('[data-testid="leave-out-confirm"]')?.textContent).toContain(LEAVE_OUT_WORDS)
    expect(left).toEqual([])
    await act(async () => {
      ;(host.querySelector('[data-testid="leave-out-no"]') as HTMLElement).click()
      await sleep(5)
    })
    expect(host.querySelector('[data-testid="leave-out-confirm"]')).toBeNull()
    await act(async () => {
      ;(host.querySelector('[data-testid="leave-out"]') as HTMLElement).click()
      await sleep(5)
    })
    await act(async () => {
      ;(host.querySelector('[data-testid="leave-out-yes"]') as HTMLElement).click()
      await sleep(5)
    })
    expect(left).toEqual(['t-tx-eli'])
    await done()
    const plain = await draw('marcus@harbordental.example', { onLeaveOut: noop })
    expect(plain.host.querySelector('[data-testid="leave-out"]')).toBeNull()
    await plain.done()
  })
})
