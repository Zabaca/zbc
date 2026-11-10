// The space's screens for Tessa's one-to-one Telegram chats. The words of the bridge's state (one function, said on the menu's foot and on
// the Settings card alike), the Telegram row and its one pill, the menu's Telegram entry, the history with an edited and a deleted message, the conversation that is answered through the bridge (its reply box, its draft with Send, a refusal and a send nobody confirmed), and the
// notification that opens a person with no email. Over the real merge and the real views over the stand-in inbox; the fixtures (src/stand-ins.ts) are the invented people the e2e photographs.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { InboxNav } from '@space/workspace'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { renderToStaticMarkup } from 'react-dom/server'
import { northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { describe as describeOutcome, newCompose } from '../src/client/compose'
import { ConversationsScreen } from '../src/client/Conversations'
import { replyLine, replyTarget, replyWays } from '../src/client/convo'
import { SettingsFoot, statusLines, treeOf } from '../src/client/nav'
import { MESSAGES, notificationFor, readPayload, stayQuiet, tapPath } from '../src/client/sw-push'
import { TelegramCard } from '../src/client/Settings'
import { telegramWords } from '../src/client/telegram'
import { MAIN } from '../src/conversations'
import { openConversation } from '../src/conversation'
import { draftViewOf } from '../src/drafts'
import { byHand } from '../src/guards'
import { fixtureViews } from '../src/fixture-views'
import { conversations } from '../src/list'
import { fixtureApps } from '../src/stand-ins'
import { type ReadName, readView } from '../src/views'
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

describe('what the page says of the bridge', () => {
  const at = (minutesAgo: number) => NOW - minutesAgo * MIN
  test('one sentence for each state, with the time in the person’s zone and amber only where something needs a look', () => {
    const words = (t: Parameters<typeof telegramWords>[0]) => telegramWords(t, NOW, 'UTC')
    expect(words({ state: 'live', checkedInAt: at(0.2), lastPushAt: at(6) })).toEqual({ text: 'Telegram is live, last message 6 min ago.', amber: false })
    expect(words({ state: 'live', checkedInAt: at(0.2), lastPushAt: null })).toEqual({ text: 'Telegram is live, no messages yet.', amber: false })
    expect(words({ state: 'catching-up', checkedInAt: at(0.2), lastPushAt: at(60) })).toEqual({ text: 'Telegram is catching up on messages.', amber: false })
    expect(words({ state: 'signed-out', checkedInAt: at(180), lastPushAt: at(180) })).toEqual({ text: 'Telegram ended the saved login for the bridge. Only you can sign in again.', amber: true })
    expect(words({ state: 'not-checked-in', checkedInAt: at(20), lastPushAt: at(60) })).toEqual({ text: 'The Telegram bridge has not checked in since 5:40 PM.', amber: true })
    expect(words({ state: 'not-checked-in', checkedInAt: null, lastPushAt: null })).toEqual({ text: 'The Telegram bridge has not checked in yet.', amber: true })
  })
})

describe('the menu', () => {
  const nav = (over: Partial<NonNullable<InboxNav['telegram']>> | null): InboxNav => ({
    views: { inbox: { count: 3, unread: 1 }, unread: { count: 1, unread: 0 }, drafts: { count: 0, unread: 0 }, bulk: { count: 0, unread: 0 }, closed: { count: 0, unread: 0 } },
    mailboxes: [],
    clients: [],
    contacts: 3,
    gmailAccounts: [],
    ...(over !== null && { telegram: { id: 'tg-1', name: 'Telegram', address: '7000000001', count: 2, unread: 1, state: 'live', checkedInAt: NOW - 30_000, lastPushAt: NOW - 6 * MIN, ...over } }),
  })

  test('Telegram is in the Mailboxes tree with its rows, like a business mailbox, and not in the menu of an inbox that has none', () => {
    expect(treeOf(nav({}), 'all', true).mailboxes).toEqual([{ key: 'mailbox:tg-1', label: 'Telegram', href: '/inbox?view=mailbox%3Atg-1', unread: 1, count: 2, active: false, title: '7000000001' }])
    expect(treeOf(nav(null), 'all', true).mailboxes).toEqual([])
    expect(treeOf(nav({}), 'mailbox:tg-1', true).mailboxes[0]?.active).toBe(true)
  })

  test('the foot says the bridge’s sentence, amber when signed out or silent for five minutes, and the card says the very same', () => {
    for (const [over, amber] of [
      [{}, false],
      [{ state: 'catching-up' as const }, false],
      [{ state: 'signed-out' as const }, true],
      [{ state: 'not-checked-in' as const, checkedInAt: NOW - 20 * MIN }, true],
    ] as const) {
      const t = { ...(nav({}).telegram as NonNullable<InboxNav['telegram']>), ...over }
      const line = statusLines({ ...nav({}), telegram: t }, NOW, 'UTC').find((l) => l.key === 'telegram:tg-1')
      expect(line).toMatchObject({ key: 'telegram:tg-1', amber })
      const sentence = telegramWords(t, NOW, 'UTC').text
      expect(line?.text).toBe(sentence)
      const card = html(
        <TelegramCard
          telegram={{ id: 'tg-1', name: 'Telegram', address: t.address, state: t.state, reportedAt: t.checkedInAt, checkedInAt: t.checkedInAt, lastPushAt: t.lastPushAt, filled: true, messages: 83, conversations: 5, open: 3, unreadOpen: 2 }}
          now={NOW}
          zone="UTC"
        />,
      )
      expect(card.replace(/&#x27;/g, "'")).toContain(sentence)
      expect(card).toContain(`data-state="${t.state}"`)
      expect(card.includes('s-card amber')).toBe(amber)
    }
    // Before the bridge has said anything there is no line at all.
    expect(statusLines(nav(null), NOW).filter((l) => l.key.startsWith('telegram'))).toEqual([])
  })

  test('drawn at the foot of the rail: a line that is amber carries the amber dot', () => {
    const t = nav({ state: 'signed-out' })
    const markup = html(<SettingsFoot nav={{ kind: 'value', value: t }} now={NOW} active={false} go={noop} />)
    expect(markup).toContain('Telegram ended the saved login for the bridge. Only you can sign in again.')
    expect(markup).toContain('data-amber="true"')
  })
})

describe('Settings reads the card from the inbox’s answer', () => {
  test('the fixtures’ card is read whole, and a card in a shape nobody promised is never half read', async () => {
    const ask = (inbox: ReturnType<typeof fixtureApps>['inbox']) => ({ apps: { inbox, meet: undefined }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 })
    const view = async (inbox: ReturnType<typeof fixtureApps>['inbox'], name: string) => {
      const r = await readView(ask(inbox), name as ReadName, new URLSearchParams())
      if (!r.ok) throw new Error(r.message)
      return r.value as { result: string; value: { telegram?: { state: string; name: string } | null } }
    }
    const apps = fixtureApps(NOW)
    expect((await view(apps.inbox, 'mailboxes')).value.telegram?.state).toBe('live')
    expect((await view(apps.inbox, 'navigation')).value.telegram).toMatchObject({ name: 'Telegram', state: 'live' })

    const bad = fixtureApps(NOW)
    const real = bad.inbox.mailboxes.bind(bad.inbox)
    bad.inbox.mailboxes = async (a) => {
      const r = await real(a)
      return r.ok ? ({ ...r, value: { ...r.value, telegram: { ...(r.value.telegram as object), state: 'on fire' } } } as never) : r
    }
    expect((await view(bad.inbox, 'mailboxes')).result).not.toBe('ok')
    expect(fixtureViews(NOW).telegram?.state).toBe('live')
  })

  test('the fixtures show the amber states the e2e photographs', () => {
    expect(fixtureViews(NOW, 'late').telegram).toMatchObject({ state: 'not-checked-in' })
    expect(fixtureViews(NOW, 'signed-out').telegram).toMatchObject({ state: 'signed-out' })
  })
})

describe('the Inbox’s Telegram rows', () => {
  const ask = async () => {
    const { inbox, meet } = fixtureApps(NOW)
    return conversations({ apps: { inbox, meet }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }, MAIN, 'mail')
  }
  const screen = (answer: Awaited<ReturnType<typeof ask>>, view: Parameters<typeof ConversationsScreen>[0]['view'] = 'all') =>
    renderToStaticMarkup(<ConversationsScreen me={ME} now={NOW} answer={answer} loading={false} problem={null} view={view} who="all" onWho={noop} query="" onQuery={noop} results={null} live="off" selected={null} go={noop} />)
  const rowsOf = (markup: string) => [...markup.matchAll(/<a class="row[^"]*" href="([^"]+)"[^>]*data-key="([^"]+)".*?<\/a>/gs)].map((m) => ({ key: m[2]!, html: m[0] }))

  test('a person who writes on Telegram alone is a row opened by their contact, with one Telegram pill and the last thing said', async () => {
    const rows = rowsOf(screen(await ask()))
    const maria = rows.find((r) => r.key === 'mail:c-tg-maria')
    expect(maria?.html).toContain('Maria Lopez')
    expect(maria?.html).toContain('Can you come by Friday instead?')
    expect(maria?.html.match(/>Telegram</g)?.length).toBe(1)
    expect(maria?.html).toContain('data-testid="telegram-pill"')
    expect(maria?.html).toContain('data-came="telegram"')
    // No Telegram bot in the Inbox (Bulk), and an archived chat is under Closed, not here.
    expect(rows.map((r) => r.key)).not.toContain('mail:c-tg-bot')
    expect(rows.map((r) => r.key)).not.toContain('mail:c-tg-sam')
  })

  test('the Telegram entry of the menu narrows the list to Telegram’s rows; the bot is in Bulk and the archived chat in Closed', async () => {
    const answer = await ask()
    expect(answer.mailboxes.map((m) => m.name)).toContain('Telegram')
    const { inbox, meet } = fixtureApps(NOW)
    const asked = (view: 'bulk' | 'closed') => conversations({ apps: { inbox, meet }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }, { kind: view }, 'mail')
    expect(rowsOf(screen(await asked('bulk'), 'bulk')).map((r) => r.key)).toContain('mail:c-tg-bot')
    expect(rowsOf(screen(await asked('closed'), 'closed')).map((r) => r.key)).toContain('mail:c-tg-sam')
  })
})

describe('a Telegram conversation', () => {
  async function open(key: string) {
    const { inbox, meet } = fixtureApps(NOW)
    const opened = await openConversation({ apps: { inbox, meet }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }, key)
    if (!opened.ok) throw new Error(opened.message)
    return opened.value
  }
  async function draw(key: string) {
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
        } as never),
      )
      await sleep(10)
    })
    return { host, answer, done: () => act(async () => root.unmount()) }
  }

  test('draws every message as a bubble: mine on the right, an edited one marked, a deleted one a line that says so and holds no words; and it is headed Telegram', async () => {
    const { host, done } = await draw('mail:c-tg-maria')
    const entries = [...host.querySelectorAll('[data-testid="entry"]')] as HTMLElement[]
    expect(entries).toHaveLength(6)
    expect(entries[1]?.className).toBe('msg email mine')
    // Tessa's own video message that the inbox holds no file for: its bracketed words are a bubble that is never broken across lines.
    expect(entries[4]?.querySelector('.msg-text')?.className).toContain('placeholder')
    expect(entries[4]?.querySelector('.msg-text')?.textContent).toBe('[Video]')
    expect(entries[2]?.querySelector('.msg-text')?.className).not.toContain('placeholder')
    expect(entries[2]?.textContent).toContain('the phone number on the contact page is wrong')
    expect(entries[2]?.querySelector('[data-testid="edited"]')?.textContent).toBe('edited')
    expect(entries[3]?.querySelector('[data-testid="deleted-message"]')?.textContent).toBe('This message was deleted in Telegram.')
    expect(entries[3]?.querySelector('[data-testid="edited"]')).toBeNull()
    expect(entries[0]?.querySelector('[data-testid="edited"]')).toBeNull()
    expect(host.querySelector('[data-testid="heading"]')?.textContent).toContain('Telegram')
    await done()
  })

  test('has a reply box to write in: a Telegram thread is a way to reply, headed by who it goes to, and copies no one', async () => {
    const answer = await open('mail:c-tg-maria')
    const ways = replyWays(answer)
    expect(ways.email.map((t) => t.kind)).toEqual(['telegram'])
    expect(ways.preferred).toBe('email')
    const thread = ways.email[0] as (typeof ways.email)[number]
    expect(replyLine('Maria Lopez', thread)).toEqual({ all: false, text: 'Telegram message to Maria Lopez' })
    expect(replyTarget(answer, 'email', null)?.target).toMatchObject({ via: 'email', copyEveryone: false })
  })

  test('Claude’s draft in it is sent by the inbox: Send as it stands, and no Copy words or Mark sent', async () => {
    const { host, done } = await draw('mail:c-tg-maria')
    const draft = host.querySelector('[data-testid="draft"]')
    expect(draft?.textContent).toContain('Friday works. I will be there at ten')
    expect(host.querySelector('[data-testid="send-draft"]')?.textContent).toBe('Send as it stands')
    expect(host.querySelector('[data-testid="draft-notice"]')).toBeNull()
    expect(host.querySelector('[data-testid="copy-words"]')).toBeNull()
    // Named, not addressed: a Telegram user id is not something to read or paste. And no "From": a Telegram message goes as him, from the chat it answers.
    expect(host.querySelector('[data-testid="draft-from"]')).toBeNull()
    expect(host.querySelector('[data-testid="draft-to"]')?.textContent).toBe('To Maria Lopez on Telegram')
    expect(host.querySelector('[data-testid="copy-address"]')).toBeNull()
    expect(host.querySelector('[data-testid="draft"]')?.textContent).not.toContain('4001')
    await done()
  })

  test('a draft Telegram would not take is a draft again, says why, and can be sent again; one nobody confirmed says to check Telegram and offers the two answers', async () => {
    const dana = await draw('dana@harbordental.example')
    expect(dana.host.querySelector('[data-testid="draft-refusal"]')?.textContent).toContain('Telegram would not take this, so nothing was sent. You cannot write in this chat.')
    expect(dana.host.querySelector('[data-testid="send-draft"]')).not.toBeNull()
    await dana.done()
    const garden = await draw('mail:c-tg-garden')
    expect(garden.host.querySelector('[data-testid="stuck-send"]')?.textContent).toContain('Sending on Telegram, or the send never finished. The bridge has not said whether this went out')
    expect(garden.host.querySelector('[data-testid="stuck-send"]')?.textContent).toContain('Check Telegram, then say which it was.')
    expect(garden.host.querySelector('[data-testid="send-draft"]')).toBeNull()
    expect(garden.host.querySelector('[data-testid="stuck-out"]')).not.toBeNull()
    expect(garden.host.querySelector('[data-testid="stuck-not"]')).not.toBeNull()
    await garden.done()
  })

  test('a group is answered by its name', async () => {
    const group = await open('mail:c-tg-merchants')
    const ways = replyWays(group)
    expect(ways.preferred).toBe('email')
    expect(replyLine('Main Street Merchants', ways.email[0] as (typeof ways.email)[number])).toEqual({ all: false, text: 'Telegram message to the group Main Street Merchants' })
  })

  test('the words of a Telegram send: sending is the ordinary answer, a repeat says it is on its way, an unknown outcome says check Telegram', () => {
    expect(describeOutcome({ result: 'done', status: 'sending' }, 'email', 'telegram')).toEqual({ notice: { tone: 'ok', text: 'Sending on Telegram. It shows in the conversation when Telegram has it.' }, then: 'next' })
    expect(describeOutcome({ result: 'done', status: 'sending' }, 'email').notice.text).toContain('Gmail did not say')
    expect(describeOutcome({ result: 'repeated', earlier: 'sending' }, 'email', 'telegram').notice.text).toBe('That is already on its way to Telegram. Nothing new went out.')
    expect(describeOutcome({ result: 'outcome-unknown', message: 'x' }, 'email', 'telegram').notice.text).toContain('Check Telegram before writing it again')
    expect(describeOutcome({ result: 'done', status: 'sent' }, 'email', 'telegram').notice.text).toBe('Sent.')
  })

  test('whether a Telegram draft is sent by the inbox: in a chat it can answer, yes; in a channel, on no conversation, or stuck, no (and the first two are by hand)', () => {
    const base = { id: 'd', conversationId: 't', contactId: 'c', toName: 'X', to: '1', cc: [], subject: '', text: 'hi', rev: 1, author: 'claude' as const, stuck: false, at: NOW, kind: 'telegram' as const }
    const chat = { through: 3, canReply: true }
    expect(draftViewOf(base, chat).sendable).toBe(true)
    expect(draftViewOf(base, { through: 3, canReply: false }).sendable).toBe(false)
    expect(draftViewOf({ ...base, conversationId: null }, null).sendable).toBe(false)
    expect(draftViewOf({ ...base, stuck: true }, chat).sendable).toBe(false)
    expect(byHand(draftViewOf(base, chat))).toBe(false)
    expect(byHand(draftViewOf(base, { through: 3, canReply: false }))).toBe(true)
    expect(byHand(draftViewOf({ ...base, conversationId: null }, null))).toBe(true)
    expect(byHand(draftViewOf({ ...base, stuck: true }, chat))).toBe(false)
    expect(byHand(draftViewOf({ ...base, kind: 'sms' }, chat))).toBe(true)
  })

  test('a Telegram send that is still going out is Sending on Telegram: not stuck, not sendable, not by hand, no Edit and no answers to give; once it cannot land it is the check Telegram card', async () => {
    const base = { id: 'd', conversationId: 't', contactId: 'c', toName: 'Maria Lopez', to: '4001', cc: [], subject: '', text: 'Friday works.', rev: 1, author: 'owner' as const, stuck: false, at: NOW, kind: 'telegram' as const }
    const going = draftViewOf({ ...base, sending: true }, { through: 3, canReply: true })
    expect(going).toMatchObject({ sending: true, stuck: false, sendable: false })
    expect(byHand(going)).toBe(false)
    const { DraftCard } = await import('../src/client/Conversation')
    const card = html(<DraftCard draft={going} state={undefined} onSend={noop} onDismiss={noop} onChanged={noop} />)
    expect(card).toContain('data-testid="draft-sending"')
    expect(card).toContain('Sending on Telegram.')
    for (const absent of ['send-draft', 'edit-draft', 'stuck-send', 'stuck-out', 'copy-words', 'draft-notice']) expect(card, absent).not.toContain(`data-testid="${absent}"`)
    const unknown = draftViewOf({ ...base, stuck: true }, { through: 3, canReply: true })
    expect(unknown.sending).toBe(false)
    expect(html(<DraftCard draft={unknown} state={undefined} onSend={noop} onDismiss={noop} onChanged={noop} />)).toContain('data-testid="stuck-send"')
  })

  test('the box of a Telegram group is headed by the whole title, a person’s by their first name', async () => {
    const group = await open('mail:c-tg-merchants')
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { ConversationView } = await import('../src/client/Conversation')
    document.body.innerHTML = '<div id="root"></div>'
    const root = createRoot(document.getElementById('root') as HTMLElement)
    await act(async () => {
      root.render(createElement(ConversationView, { me: ME, now: NOW, answer: group, sources: group.sources, loadingEarlier: false, onEarlier: noop, way: 'email' as const, onWay: noop, threadId: null, onThread: noop, compose: newCompose(), onText: noop, onSend: noop, onSendAndClose: noop, onClose: noop, onReopen: noop, reopen: null, changing: false, changed: null, onDismiss: noop, drafts: {}, onSendDraft: noop, onDismissDraft: noop, onDraftChanged: noop, profileOpen: false, onProfile: noop, onBack: noop, timeZone: 'UTC' } as never))
      await sleep(10)
    })
    expect(document.querySelector('[data-testid="compose-text"]')?.getAttribute('placeholder')).toBe('Message Main Street Merchants')
    await act(async () => root.unmount())
  })

  test('a person who writes by email and on Telegram is one conversation with both histories, each under its own heading', async () => {
    const { host, answer, done } = await draw('dana@harbordental.example')
    const headings = [...host.querySelectorAll('[data-testid="heading"]')].map((h) => h.textContent ?? '')
    expect(headings.some((h) => h.includes('Telegram'))).toBe(true)
    expect(headings.some((h) => h.includes('Email: '))).toBe(true)
    // The email replies are still there to write in.
    expect(replyWays(answer).preferred).toBe('email')
    await done()
  })
})

describe('the notification for a Telegram message', () => {
  const payload = (person: string) =>
    JSON.stringify({ v: 1, kind: 'message', conversationId: 'c1', person, messageId: 'm1', title: 'Telegram: Maria Lopez', body: 'New Telegram message', at: new Date(NOW).toISOString() })

  test('a person with no email is opened by their contact key, and the open conversation keeps it quiet', () => {
    const read = readPayload(payload('mail:c-tg-maria'))
    expect(read?.person).toBe('mail:c-tg-maria')
    const shown = notificationFor(read)
    expect(shown.title).toBe('Telegram: Maria Lopez')
    expect(shown.options.body).toBe('New Telegram message')
    expect(tapPath(shown.options.data.person)).toBe('/inbox/mail%3Ac-tg-maria')
    // The page tells the worker the row's key as well as its addresses (Conversation.tsx), so the open conversation recognises it.
    expect(stayQuiet('mail:c-tg-maria', [['mail:c-tg-maria']])).toBe(true)
    expect(stayQuiet('mail:c-tg-maria', [['dana@harbordental.example', 'dana@harbordental.example']])).toBe(false)
    expect(MESSAGES.ask).toBe('space:which-conversation')
  })
})

// ── Groups and channels ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('a Telegram group and a channel in the Inbox', () => {
  const apps = () => {
    const { inbox, meet } = fixtureApps(NOW)
    return { apps: { inbox, meet }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }
  }
  const screen = (answer: Awaited<ReturnType<typeof conversations>>, view: Parameters<typeof ConversationsScreen>[0]['view'] = 'all') =>
    renderToStaticMarkup(<ConversationsScreen me={ME} now={NOW} answer={answer} loading={false} problem={null} view={view} who="all" onWho={noop} query="" onQuery={noop} results={null} live="off" selected={null} go={noop} />)
  const rowsOf = (markup: string) => [...markup.matchAll(/<a class="row[^"]*" href="([^"]+)"[^>]*data-key="([^"]+)".*?<\/a>/gs)].map((m) => ({ key: m[2]!, html: m[0] }))

  test('a group is one row under its own name, tagged Group, with the newest message named by who wrote it, and the quiet one beside it is an open unread row too', async () => {
    const rows = rowsOf(screen(await conversations(apps(), MAIN, 'mail')))
    const merchants = rows.find((r) => r.key === 'mail:c-tg-merchants')
    expect(merchants?.html).toContain('Main Street Merchants')
    expect(merchants?.html).toContain('Tomas: @tessa could you look at our site this week?')
    expect(merchants?.html).toContain('data-testid="telegram-pill"')
    expect(merchants?.html).toContain('data-testid="telegram-chat-tag"')
    expect(merchants?.html).toContain('>Group<')
    // No row is made for a member of a group by what they wrote there.
    expect(rows.map((r) => r.key)).not.toContain('mail:c-tg-tomas')
    expect(rows.map((r) => r.key)).not.toContain('mail:c-tg-priti')
    const garden = rows.find((r) => r.key === 'mail:c-tg-garden')
    expect(garden?.html).toContain('Tomas: Seed swap is moved to the 14th.')
    expect(garden?.html).toContain('class="row unread"')
    expect(garden?.html).toContain('unread messages in the group')
  })

  test('a channel is never in the Inbox: it is in Bulk, tagged Channel', async () => {
    expect(rowsOf(screen(await conversations(apps(), MAIN, 'mail'))).map((r) => r.key)).not.toContain('mail:c-tg-status')
    const bulk = rowsOf(screen(await conversations(apps(), { kind: 'bulk' }, 'mail'), 'bulk'))
    const status = bulk.find((r) => r.key === 'mail:c-tg-status')
    expect(status?.html).toContain('Cloudflare Status')
    expect(status?.html).toContain('>Channel<')
  })
})

describe('a Telegram group’s conversation', () => {
  async function open(key: string) {
    const { inbox, meet } = fixtureApps(NOW)
    const opened = await openConversation({ apps: { inbox, meet }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }, key)
    if (!opened.ok) throw new Error(opened.message)
    return opened.value
  }

  test('is headed Telegram group, every message names who wrote it, and what is beside it is a kind and not a person’s business and role', async () => {
    const answer = await open('mail:c-tg-merchants')
    expect(answer.row.name).toBe('Main Street Merchants')
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
          profileOpen: true,
          onProfile: noop,
          onBack: noop,
          timeZone: 'UTC',
        } as never),
      )
      await sleep(10)
    })
    const entries = [...host.querySelectorAll('[data-testid="entry"]')] as HTMLElement[]
    expect(entries.map((e) => e.querySelector('.msg-head b')?.textContent)).toEqual(['Tomas Vega', 'Priti Shah', 'Maria Lopez', 'You', 'Tomas Vega'])
    expect(host.querySelector('[data-testid="heading"]')?.textContent).toContain('Telegram group')
    const profile = host.querySelector('[data-testid="profile"]')
    expect(profile?.textContent).toContain('Telegram group')
    expect(profile?.querySelector('[data-testid="profile-beside"]')).toBeNull()
    expect(profile?.textContent).not.toContain('Not a client')
    await act(async () => root.unmount())
  })

  test('a channel has no reply box, and says why', async () => {
    const answer = await open('mail:c-tg-status')
    const ways = replyWays(answer)
    expect(ways.preferred).toBeNull()
    expect(ways.none).toBe('A Telegram channel is one you follow: there is nothing to reply to.')
  })
})

describe('Today, People and the member’s page', () => {
  test('Today holds a group only when it needs a reply; chatter alone is not Today’s business', async () => {
    const { inbox } = fixtureApps(NOW)
    const people = await inbox.people(OWNER_SIGNED_IN, undefined)
    if (!people.ok) throw new Error('no people')
    const lines = people.value.people.flatMap((p) => p.conversations).filter((l) => l.telegramChat === 'group')
    expect(lines.map((l) => [l.conversationId, l.needsReply])).toEqual(expect.arrayContaining([['t-tg-merchants', true], ['t-tg-garden', false]]))
  })

  test('the groups’ contacts are not people, and a member who writes in groups is, with the groups they write in', async () => {
    const { inbox } = fixtureApps(NOW)
    const listed = await inbox.contacts(OWNER_SIGNED_IN)
    if (!listed.ok) throw new Error('no contacts')
    const names = listed.value.contacts.map((c) => c.name)
    expect(names).not.toContain('Main Street Merchants')
    expect(names).not.toContain('Garden Club')
    expect(names).not.toContain('Cloudflare Status')
    expect(names).toEqual(expect.arrayContaining(['Tomas Vega', 'Priti Shah', 'Maria Lopez']))
    const tomas = listed.value.contacts.find((c) => c.name === 'Tomas Vega')
    expect(tomas?.groups?.map((g) => g.name)).toEqual(['Main Street Merchants', 'Garden Club'])
    expect(tomas?.conversations).toBe(0)
    // Maria is one person: her own chat and her group messages, her page lists the group.
    expect(listed.value.contacts.find((c) => c.name === 'Maria Lopez')?.groups?.map((g) => g.name)).toEqual(['Main Street Merchants'])
  })
})
