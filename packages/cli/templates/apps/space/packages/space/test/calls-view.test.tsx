// What a person sees of calls: the card of a huddle in a direct message, of a call link and a meeting in an email conversation, the buttons beside the reply box,
// the Calls list, a call's own screen, the Phone, and the month's usage. The cards are drawn from the answer the Worker gives (made by the real code over stand-in apps), so a
// change to the contract shows here as what changed on screen. Links are meet's own address in every one.
import type { MeetCall, MeetCallChat, MeetPhone, MeetUsage } from '@space/workspace'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { T0, northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { CallCard, stateOf } from '../src/client/CallCard'
import type { CallActions } from '../src/client/callActions'
import { CallPaneView } from '../src/client/CallPane'
import { CallsListView } from '../src/client/CallsList'
import { UsageView, usageWords } from '../src/client/CallsSettings'
import { newCompose } from '../src/client/compose'
import { ConversationView, type ViewProps } from '../src/client/Conversation'
import { blocksOf } from '../src/client/convo'
import { PhonePaneView } from '../src/client/PhonePane'
import { type Opened, openConversation } from '../src/conversation'
import { mergeHistory } from '../src/history'
import { type StandInChatMessage, standInInbox, standInMeet } from '../src/stand-ins'
import { ago, channel, contact, dm, person, thread } from './world'
import { OWNER_SIGNED_IN } from './signed-in'

const install = northfield()
const ME = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, install)
const MIN = 60_000
const NAME = 'k7m2qx9frtn4w6hbc8jd'
const LINK = `https://meet.northfield.example/r/${NAME}`

const call = (over: Partial<MeetCall> = {}): MeetCall => ({
  name: NAME,
  link: LINK,
  kind: 'huddle',
  title: null,
  madeBy: { name: 'Tessa', mine: true },
  madeAt: T0 - 20 * MIN,
  conversationId: null,
  home: null,
  startsAt: null,
  invitees: [],
  present: 0,
  people: 0,
  messages: 0,
  endedAt: null,
  openedAt: null,
  ...over,
})
const card = (c: MeetCall) => renderToStaticMarkup(<CallCard call={c} now={T0} zone="America/Los_Angeles" name="Tessa" />)
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

describe('a call as a card', () => {
  test('a call with people in it says how many and offers Join, with the person’s name carried to the lobby', () => {
    const html = card(call({ present: 2, people: 2, openedAt: T0 - 5 * MIN }))
    expect(html).toContain('data-state="live"')
    expect(text(html)).toContain('2 people are in it now')
    expect(html).toContain(`href="${LINK}?as=Tessa"`)
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('>Join<')
  })

  test('one person is "1 person is in it"; a huddle is called a huddle, a call link and a New call a call, a meeting a meeting', () => {
    expect(text(card(call({ present: 1, people: 1 })))).toContain('1 person is in it now')
    expect(text(card(call()))).toContain('Huddle')
    expect(text(card(call({ kind: 'link' })))).toMatch(/^Call /)
    expect(text(card(call({ kind: 'new', title: 'Weekly' })))).toContain('Call: Weekly')
    expect(text(card(call({ kind: 'meeting', title: 'Kickoff', startsAt: T0 + 3_600_000 })))).toContain('Meeting: Kickoff')
  })

  test('once everyone has left it reads "Call ended" with its length and how many joined, and Join becomes Join again', () => {
    const html = card(call({ present: 0, people: 3, messages: 4, openedAt: T0 - 30 * MIN, endedAt: T0 - 18 * MIN }))
    expect(html).toContain('data-state="ended"')
    expect(text(html)).toContain('Call ended, 12 min. 3 people joined, 4 chat messages saved')
    expect(html).toContain('>Join again<')
    // The chat is one tap away when there is a screen to open it on.
    expect(renderToStaticMarkup(<CallCard call={call({ messages: 4 })} now={T0} zone="UTC" name="J" chatHref={`/meet/call%3A${NAME}`} />)).toContain('data-testid="call-chat"')
  })

  test('a call that ended before meet kept the time says it ended without how long', () => {
    expect(stateOf(call({ people: 2, endedAt: T0 - MIN }), T0, undefined).line).toBe('Call ended. 2 people joined')
  })

  test('a call nobody has joined says so; a meeting says when it starts, on the company’s clock with the zone', () => {
    expect(text(card(call()))).toContain('Nobody has joined yet')
    const html = card(call({ kind: 'meeting', title: 'Kickoff', startsAt: Date.UTC(2026, 10, 3, 22, 0), invitees: [{ name: 'Corin Pike', address: 'corin@client.test' }, { name: 'Dana', address: null }] }))
    expect(text(html)).toContain('Starts Tue, Nov 3, 2:00 PM PST')
    expect(text(html)).toContain('With Corin Pike, Dana')
  })

  test('every link on the card is meet’s own address; Copy link is a button that copies exactly call.link, and the page’s address is nowhere', () => {
    const html = card(call({ present: 1, people: 1 }))
    expect(html).toContain('data-testid="call-copy"')
    expect([...html.matchAll(/href="([^"]+)"/g)].map((m) => new URL(m[1] as string).origin)).toEqual(['https://meet.northfield.example'])
    expect(html).not.toContain('space.northfield.example')
    expect(html).not.toContain('localhost')
  })

  test('who made it is said as you or by name', () => {
    expect(text(card(call()))).toContain('You started it')
    expect(text(card(call({ madeBy: { name: 'Priya', mine: false } })))).toContain('Priya started it')
    expect(text(card(call({ kind: 'link' })))).toContain('You made this call link')
    expect(text(card(call({ kind: 'meeting', title: 'T', startsAt: T0 + MIN })))).toContain('You booked it')
  })
})

// ── In a conversation ───────────────────────────────────────────────────────────────────────────────────────────────────

const chat = (id: number, at: number, text: string, extra: Partial<StandInChatMessage> = {}): StandInChatMessage => ({ id, at, authorId: 'p-priya', authorName: 'Priya', text, mine: false, ...extra })
const priya = person('p-priya', 'Priya Natarajan', 'priya@northfield.example', 'teammate')

async function open(key: string, held: MeetCall[]): Promise<Extract<Opened, { ok: true }>['value']> {
  const inbox = standInInbox([contact('c-corin', 'Corin Pike', 'corin@client.test')], [thread('t-1', ago(50), ['c-corin'], { subject: 'Kickoff', direction: 'in' })])
  const meet = standInMeet(
    { direct: [dm(12, priya, ago(30))], channels: [channel(21, 'launch', ago(5), 2)] },
    {
      callsHeld: held,
      history: {
        12: [chat(3, ago(60), 'Lunch?'), chat(4, ago(25), `Started a huddle: ${LINK}`, { mine: true, authorId: 'p-tessa', authorName: 'Tessa', huddle: NAME }), chat(5, ago(10), 'Be right there')],
        21: [chat(6, ago(5), 'Staging is up')],
      },
    },
  )
  const opened = await openConversation({ apps: { inbox, meet }, install, signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }, key)
  if (!opened.ok) throw new Error(opened.message)
  return opened.value
}

const actions = (over: Partial<CallActions> = {}): CallActions => ({
  busy: false,
  notice: null,
  canHuddle: true,
  canLink: true,
  canSchedule: true,
  scheduleOpen: false,
  invitable: [{ key: 'corin@client.test', name: 'Corin Pike', address: 'corin@client.test' }],
  startHuddle: () => undefined,
  addLink: () => undefined,
  openSchedule: () => undefined,
  closeSchedule: () => undefined,
  schedule: () => undefined,
  ...over,
})

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
  ...over,
})
const view = (over: Partial<ViewProps> & Pick<ViewProps, 'answer'>) => renderToStaticMarkup(<ConversationView {...idle(over)} />)

describe('a huddle in a direct message', () => {
  test('the message that announced it is its card, in place among the chat, with who is in it now; the link is not printed as words', async () => {
    const answer = await open('priya@northfield.example', [call({ conversationId: 12, present: 2, people: 2 })])
    const html = view({ answer, way: 'chat' })
    expect(html).toContain('data-testid="call-card"')
    expect(html).toContain('data-kind="huddle"')
    expect(text(html)).toContain('2 people are in it now')
    expect(html).not.toContain('Started a huddle')
    // It stands between the chat before it and after it.
    const order = [html.indexOf('Lunch?'), html.indexOf('data-testid="call-card"'), html.indexOf('Be right there')]
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order.every((i) => i > 0)).toBe(true)
  })

  test('a huddle the answer carries no card for is the message it was, words and link', async () => {
    const answer = await open('priya@northfield.example', [])
    const html = view({ answer, way: 'chat' })
    expect(html).not.toContain('data-testid="call-card"')
    expect(html).toContain(`Started a huddle: ${LINK}`)
  })

  test('in a channel the card carries no “Direct message” heading, and Start huddle is on offer where the reply goes by chat', async () => {
    const answer = await open('chat:channel:21', [call({ conversationId: 21 })])
    expect(blocksOf(answer, mergeHistory(answer.sources).entries).map((b) => b.heading)).toEqual([null])
    const html = view({ answer, way: 'chat', calls: actions() })
    expect(html).toContain('data-testid="start-huddle"')
    expect(html).not.toContain('data-testid="add-call-link"')
  })
})

describe('the buttons beside the reply box', () => {
  test('by chat: Start huddle and Schedule; by email: Add call link and Schedule; nothing where the page offers none', async () => {
    const dmAnswer = await open('priya@northfield.example', [])
    const chatHtml = view({ answer: dmAnswer, way: 'chat', calls: actions() })
    expect(chatHtml).toContain('data-testid="start-huddle"')
    expect(chatHtml).toContain('data-testid="open-schedule"')
    expect(chatHtml).not.toContain('data-testid="add-call-link"')
    const mailAnswer = await open('corin@client.test', [])
    const mailHtml = view({ answer: mailAnswer, way: 'email', calls: actions() })
    expect(mailHtml).toContain('data-testid="add-call-link"')
    expect(mailHtml).toContain('data-testid="open-schedule"')
    expect(mailHtml).not.toContain('data-testid="start-huddle"')
    expect(view({ answer: mailAnswer, way: 'email' })).not.toContain('data-testid="add-call-link"')
  })

  test('a button waits while a call is being made, and what the last press came to is said under the box', async () => {
    const html = view({ answer: await open('corin@client.test', []), calls: actions({ busy: true, notice: { tone: 'ok', text: 'The call link is in your email below. Nothing is sent until you press Send.' } }) })
    expect(html).toMatch(/data-testid="add-call-link"[^>]*disabled|disabled[^>]*data-testid="add-call-link"/)
    expect(html).toContain('Nothing is sent until you press Send.')
  })

  test('the booking form asks for a title, a day and a time on the company’s clock, who is invited, and says the invitation is only text in the email until Send', async () => {
    const html = view({ answer: await open('corin@client.test', []), way: 'email', calls: actions({ scheduleOpen: true }) })
    expect(html).toContain('data-testid="schedule"')
    // Beside the reply box's form, a form of its own (test/schedule-dom.test.tsx proves Enter in it books and sends nothing).
    expect(html.match(/<form/g)).toHaveLength(2)
    expect(html).toMatch(/<button type="submit"[^>]*data-testid="schedule-book"/)
    expect(html).toContain('type="datetime-local"')
    expect(html).toContain('America/Los Angeles time, the company&#x27;s clock.')
    // Who is invited is who the email goes to: named, not ticked.
    expect(html).not.toContain('type="checkbox"')
    expect(text(html)).toContain('Invited, and who the email goes to: Corin Pike')
    expect(text(html)).toContain('It is sent only when you press Send there')
  })

  test('in a direct message the form invites everyone in it and says the meeting shows as a card, with no email', async () => {
    const html = view({ answer: await open('priya@northfield.example', []), way: 'chat', calls: actions({ scheduleOpen: true }) })
    expect(html).not.toContain('data-testid="schedule-with"')
    expect(text(html)).toContain('Everyone in this conversation is invited.')
    expect(text(html)).not.toContain('goes into the email')
  })
})

describe('a call link and a meeting in an email conversation', () => {
  test('each is a card of its own, in order of when it was made, with the meeting’s time and who is invited', async () => {
    const link = call({ name: 'a'.repeat(20), link: `https://meet.northfield.example/r/${'a'.repeat(20)}`, kind: 'link', home: 'corin@client.test', madeAt: ago(40) })
    const meeting = call({ name: 'b'.repeat(20), link: `https://meet.northfield.example/r/${'b'.repeat(20)}`, kind: 'meeting', title: 'Kickoff', home: 'corin@client.test', madeAt: ago(5), startsAt: T0 + 26 * 60 * MIN, invitees: [{ name: 'Corin Pike', address: 'corin@client.test' }] })
    const html = view({ answer: await open('corin@client.test', [meeting, link]) })
    expect(html.match(/data-testid="call-card"/g)).toHaveLength(2)
    expect(html.indexOf('data-kind="link"')).toBeLessThan(html.indexOf('data-kind="meeting"'))
    expect(text(html)).toContain('Meeting: Kickoff')
    expect(text(html)).toContain('With Corin Pike')
  })
})

// ── The lists and screens ───────────────────────────────────────────────────────────────────────────────────────────────

describe('the Calls list', () => {
  const go = () => undefined
  test('each past call is a card with its chat one tap away, and more are asked for by the button', () => {
    const calls = [call({ messages: 2, people: 2, endedAt: T0 - MIN, openedAt: T0 - 9 * MIN }), call({ name: 'c'.repeat(20), link: `https://meet.northfield.example/r/${'c'.repeat(20)}`, kind: 'new', title: 'Weekly' })]
    const html = renderToStaticMarkup(<CallsListView calls={calls} now={T0} me={ME} go={go} more onMore={() => undefined} loadingMore={false} />)
    expect(html.match(/data-testid="call-card"/g)).toHaveLength(2)
    expect(html).toContain(`href="/meet/call%3A${NAME}"`)
    expect(html).toContain('data-testid="calls-more"')
    expect(html).toContain('Call ended, 8 min')
  })

  test('with none it says so and what is listed', () => {
    const html = renderToStaticMarkup(<CallsListView calls={[]} now={T0} me={ME} go={go} more={false} onMore={() => undefined} loadingMore={false} />)
    expect(html).toContain('data-testid="empty-calls"')
    expect(html).not.toContain('calls-more')
  })
})

describe('a call’s own screen', () => {
  const chatOf = (c: MeetCall, messages: MeetCallChat['messages']): MeetCallChat => ({ call: c, messages })
  const screen = (c: MeetCallChat, over: { deleted?: string | null } = {}) => renderToStaticMarkup(<CallPaneView chat={c} now={T0} me={ME} onDelete={() => undefined} deleting={false} deleted={over.deleted ?? null} />)

  test('it shows the card and the saved chat to read, with no way to write in it', () => {
    const html = screen(chatOf(call({ kind: 'new', title: 'Weekly', messages: 2, people: 2, endedAt: T0 - MIN, openedAt: T0 - 11 * MIN }), [{ id: 1, name: 'Dana', text: 'can you hear me', at: T0 - 9 * MIN }, { id: 2, name: 'Tessa', text: 'yes', at: T0 - 8 * MIN }]))
    expect(html).toContain('data-testid="call-card"')
    expect(html.match(/data-testid="call-chat-message"/g)).toHaveLength(2)
    expect(html).toContain('can you hear me')
    expect(html).not.toContain('<textarea')
    expect(html).toContain('data-testid="call-chat-delete"')
  })

  test('the chat cannot be deleted while someone is in the call, and a call with no chat says so', () => {
    const live = screen(chatOf(call({ present: 1, people: 1, messages: 1 }), [{ id: 1, name: 'Dana', text: 'hi', at: T0 }]))
    expect(live).toMatch(/data-testid="call-chat-delete"[^>]*disabled|disabled[^>]*data-testid="call-chat-delete"/)
    expect(screen(chatOf(call(), []))).toContain('data-testid="call-chat-empty"')
    expect(screen(chatOf(call(), []), { deleted: 'The chat was deleted.' })).toContain('The chat was deleted.')
  })
})

describe('the Phone conversation', () => {
  const phone = (items: MeetPhone['items']): MeetPhone => ({ conversationId: 90, unread: 0, items, more: false })
  const draw = (p: MeetPhone | null, canCall: boolean) => renderToStaticMarkup(<PhonePaneView phone={p} now={T0} canCall={canCall} onCallBack={() => undefined} onDelete={async () => null} />)
  const items: MeetPhone['items'] = [
    { id: 7, at: T0 - 50 * MIN, kind: 'voicemail', text: 'Voicemail', number: '+16265550100', display: '(626) 555-0100', seconds: 42 },
    { id: 8, at: T0 - 10 * MIN, kind: 'missed', text: 'Missed', number: '+16265550111', display: '(626) 555-0111', seconds: null },
    { id: 9, at: T0 - 5 * MIN, kind: 'emergency', text: 'Someone dialed 911 from meet.', number: null, display: null, seconds: null },
  ]

  test('a voicemail plays from this Worker’s own path, never an address of Telnyx’s, and each has Call back and Delete', () => {
    const html = draw(phone(items), true)
    expect(html).toContain('src="/api/phone/voicemail/7/audio"')
    expect(html).not.toContain('telnyx')
    expect(html.match(/data-testid="call-back"/g)).toHaveLength(2)
    expect(text(html)).toContain('Voicemail from (626) 555-0100 , 0:42')
    expect(text(html)).toContain('Missed call from (626) 555-0111')
    // Newest first; a notice of 911 is kept, not deleted from the page.
    expect(html.indexOf('data-id="9"')).toBeLessThan(html.indexOf('data-id="7"'))
    expect(html.match(/data-testid="phone-delete"/g)).toHaveLength(2)
  })

  test('with no phone for the person there is no Call back, and with nothing yet it says so', () => {
    expect(draw(phone(items), false)).not.toContain('data-testid="call-back"')
    expect(draw(phone([]), false)).toContain('data-testid="phone-empty"')
  })
})

describe('the month’s usage in Settings', () => {
  const usage = (over: Partial<MeetUsage> = {}): MeetUsage => ({ usedGb: 312.4, freeGb: 1000, tripGb: 800, paused: false, pausedUntil: null, ...over })

  test('it says how much of the allowance is used and where new calls stop', () => {
    const html = renderToStaticMarkup(<UsageView usage={usage()} />)
    expect(usageWords(usage())).toBe('312.4 of 1,000 GB')
    expect(text(html)).toContain('312.4 of 1,000 GB used this month')
    expect(text(html)).toContain('New joins and new calls stop at 800 GB')
    expect(html).toContain('data-paused="false"')
  })

  test('past the trip it says calls are paused, until when, and that people already in a call carry on', () => {
    const html = renderToStaticMarkup(<UsageView usage={usage({ usedGb: 812, paused: true, pausedUntil: '2026-12-01' })} />)
    expect(text(html)).toContain('Calls are paused until 2026-12-01.')
    expect(text(html)).toContain('People already in a call carry on.')
    expect(html).toContain('data-paused="true"')
  })
})
