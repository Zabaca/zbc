// What a person sees on the Inbox and Meet tabs, drawn from the answer the Worker gives the page. The answers are made by the real
// merge over stand-in apps (not written by hand), so a change to the merge shows here as what changed on screen.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PartStatus } from '@space/workspace'
import { T0, northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { ConversationsScreen, type ScreenProps } from '../src/client/Conversations'
import { ago, cameGlyph, filterRows, initials, markFor, MEET_REQUEST, noticesFor, requestFor } from '../src/client/format'
import { conversationKey, conversationPath } from '../src/client/route'
import { MAIN, type ConversationsAnswer, type Scope } from '../src/conversations'
import { type SearchAnswer, conversations, search } from '../src/list'
import { type StandInContact, type StandInThread, standInInbox, standInMeet } from '../src/stand-ins'
import { RIDGEWAY, ago as minutesAgo, channel, contact, dm, person, thread } from './world'
import { OWNER_SIGNED_IN } from './signed-in'

const install = northfield()
const ME = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, install)

const dana = person('p-dana', 'Dana Reyes', 'dana@harbor.example')
const contacts: StandInContact[] = [
  { ...contact('c-dana', 'Dana Reyes', 'dana@harbor.example'), client: { id: 7, name: 'Harbor Dental' } },
  contact('c-marcus', 'Marcus Chen', 'marcus@harbor.example'),
  contact('c-lead', 'Tomas Alvarez', 'tomas@mail.example'),
]
const threads: StandInThread[] = [
  thread('t-old', minutesAgo(300), ['c-dana'], { subject: 'Invoice 1042', snippet: 'Paid, thank you.' }),
  thread('t-new', minutesAgo(90), ['c-dana', 'c-marcus'], { subject: 'Homepage copy', snippet: 'Can the hours line say Saturdays?', unread: true }),
  thread('t-lead', minutesAgo(40), ['c-lead'], { subject: 'Winter service', snippet: 'Lights off?', unread: true, mailbox: RIDGEWAY }),
]

async function answerFor(opts: { meet?: ReturnType<typeof standInMeet> | null; inbox?: ReturnType<typeof standInInbox> | null } = {}, scope?: Scope): Promise<ConversationsAnswer> {
  const meet = opts.meet === undefined ? standInMeet({ direct: [dm(11, dana, minutesAgo(5), 3, 'Also, can we move Thursday?'), dm(12, person('p-pri', 'Priya', 'priya@northfield.example', 'teammate'), minutesAgo(200))], channels: [channel(21, 'launch', minutesAgo(20), 2)] }) : opts.meet
  const inbox = opts.inbox === undefined ? standInInbox(contacts, threads) : opts.inbox
  return conversations({ apps: { inbox: inbox ?? undefined, meet: meet ?? undefined }, install, signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }, MAIN, scope)
}

const screen = (answer: ConversationsAnswer | null, over: Partial<ScreenProps> = {}) =>
  renderToStaticMarkup(
    <ConversationsScreen me={ME} now={T0} answer={answer} loading={false} problem={null} view="all" who="all" onWho={() => undefined} query="" onQuery={() => undefined} results={null} live="off" selected={null} go={() => undefined} {...over} />,
  )

const rowsOf = (html: string) => [...html.matchAll(/<a class="row[^"]*" href="([^"]+)"[^>]*data-key="([^"]+)".*?<\/a>/gs)].map((m) => ({ href: m[1]!.replace(/&amp;/g, '&'), key: m[2]!, html: m[0] }))

describe('the list as drawn', () => {
  test('the Inbox is one row per person with email, newest first, each with its name, the last thing said, when, and how it came, and no chat in it', async () => {
    const html = screen(await answerFor({}, 'mail'))
    const rows = rowsOf(html)
    // The shared thread is listed once, under Dana, who wrote it: Marcus is on it and has no row of his own for it.
    expect(rows.map((r) => r.key)).toEqual(['tomas@mail.example', 'dana@harbor.example'])
    const dana = rows[1]!.html
    expect(dana).toContain('Dana Reyes')
    expect(dana).toContain('Harbor Dental') // the business, from the inbox's Client
    expect(dana).toContain('Can the hours line say Saturdays?')
    expect(dana).toContain('data-came="email"')
    expect(dana).toContain('<b class="subject">Homepage copy</b>') // an email shows its subject
    // A business mailbox's customer sits in the same list, beside everyone else, and says which mailbox it came to.
    expect(rows[0]!.html).toContain('Tomas Alvarez')
    expect(rows[0]!.html).toContain('<span class="kindtag" data-testid="mailbox-tag">Ridgeway Cycles</span>')
    expect(rows[1]!.html).not.toContain('mailbox-tag')
    expect(html).not.toContain('Invoice 1042') // only the newest thread of a person is on the row
    // Not a channel, not a direct message, not a word of chat: the Inbox is email.
    for (const word of ['launch', 'Priya', 'Also, can we move Thursday?', 'data-came="chat"', 'Chat is live', 'new-call']) expect(html).not.toContain(word)
    expect(html).toContain('<h1 id="h-conv">Inbox</h1>')
    expect(html).toContain('data-scope="mail"')
  })

  test('Meet is one row per channel and direct message, newest first, and no email in it', async () => {
    const html = screen(await answerFor({}, 'chat'), { scope: 'chat' })
    const rows = rowsOf(html)
    expect(rows.map((r) => r.key)).toEqual(['dana@harbor.example', 'chat:channel:21', 'priya@northfield.example'])
    expect(rows.map((r) => r.href)).toEqual(['/meet/dana%40harbor.example', '/meet/chat%3Achannel%3A21', '/meet/priya%40northfield.example'])
    expect(rows[0]!.html).toContain('Also, can we move Thursday?')
    expect(rows[0]!.html).toContain('>5m<')
    expect(rows[0]!.html).toContain('data-came="chat"')
    expect(rows[1]!.html).toContain('Channel, 4 people')
    for (const word of ['Homepage copy', 'Winter service', 'Harbor Dental', 'mailbox-tag', 'client-pill', 'Tomas', 'data-came="email"']) expect(html).not.toContain(word)
    expect(html).toContain('<h1 id="h-conv">Meet</h1>')
    expect(html).toContain('data-scope="chat"')
  })

  test('the Inbox has New email, search and the chips; Meet has New call and chat’s live state, and neither has the other’s', async () => {
    const mail = screen(await answerFor({}, 'mail'), { onNewEmail: () => undefined, onNewCall: () => undefined })
    expect(mail).toContain('data-testid="new-email-button"')
    expect(mail).toContain('data-testid="search"')
    expect(mail).toContain('data-testid="filter-all"')
    expect(mail).not.toContain('data-testid="new-call"')
    const meet = screen(await answerFor({}, 'chat'), { scope: 'chat', onNewEmail: () => undefined, onNewCall: () => undefined, live: 'open', channelTools: <div data-testid="channel-tools" /> })
    expect(meet).toContain('data-testid="new-call"')
    expect(meet).toContain('data-testid="channel-tools"')
    expect(meet).toContain('Chat is live')
    for (const id of ['new-email-button', 'search', 'filter-all']) expect(meet).not.toContain(`data-testid="${id}"`)
    // Chat is live only in Meet: the Inbox never shows it, whatever the socket says.
    expect(screen(null, { live: 'open' })).not.toContain('Chat is live')
  })

  test('Meet’s views cut its list: Chat the direct messages, Channels the channels; Calls is the calls’ own list', async () => {
    const a = await answerFor({}, 'chat')
    expect(rowsOf(screen(a, { scope: 'chat', meetView: 'chat' })).map((r) => r.key)).toEqual(['dana@harbor.example', 'priya@northfield.example'])
    expect(rowsOf(screen(a, { scope: 'chat', meetView: 'channels' })).map((r) => r.key)).toEqual(['chat:channel:21'])
    const calls = screen(a, { scope: 'chat', meetView: 'calls' })
    expect(calls).not.toContain('data-testid="rows"')
    expect(calls).toContain('calls')
    expect(screen(await answerFor({ meet: standInMeet({ direct: [], channels: [] }) }, 'chat'), { scope: 'chat', meetView: 'channels' })).toContain('No channels yet.')
  })

  test('the unread badge is one number and says what it is made of, on the badge and at the foot of the list', async () => {
    const mail = screen(await answerFor({}, 'mail'))
    const danaRow = rowsOf(mail).find((r) => r.key === 'dana@harbor.example')!.html
    expect(danaRow).toContain('1 new')
    expect(danaRow).toContain('title="1 unread email conversation"')
    expect(mail).toContain('counts each unread email conversation once')
    expect(mail).not.toContain('chat message')
    const chat = screen(await answerFor({}, 'chat'), { scope: 'chat' })
    const first = rowsOf(chat)[0]!.html
    expect(first).toContain('3 new')
    expect(first).toContain('title="3 unread chat messages"')
    expect(chat).toContain('counts the unread chat messages in it')
    // A row with nothing unread has no badge, and a list with nothing unread no note.
    expect(rowsOf(chat)[2]!.html).not.toContain('data-testid="unread"')
    const quiet = await answerFor({ inbox: standInInbox([], []), meet: standInMeet({ direct: [dm(12, dana, minutesAgo(5))], channels: [] }) }, 'chat')
    expect(screen(quiet, { scope: 'chat' })).not.toContain('counts the unread')
  })

  test('a thread shared with another outsider is listed once and says who else is on it', async () => {
    const rows = rowsOf(screen(await answerFor()))
    expect(rows.filter((r) => r.html.includes('Shared thread')).length).toBe(1)
    expect(rows[0]!.html).toContain('Shared thread, with Marcus Chen')
    expect(rowsOf(screen(await answerFor())).some((r) => r.key === 'marcus@harbor.example')).toBe(false)
  })

  test('a row opens its conversation in the space, by its key, in its own tab, and the one that is open is marked', async () => {
    const answer = await answerFor({}, 'mail')
    const rows = rowsOf(screen(answer))
    expect(rows.map((r) => r.href)).toEqual(['/inbox/tomas%40mail.example', '/inbox/dana%40harbor.example'])
    for (const r of rows) expect(r.html).not.toContain('target="_blank"')
    // The address names the key, and the key comes back out of it, whatever it holds.
    for (const r of rows) expect(conversationPath('mail', conversationKey(new URL(r.href, 'https://space.northfield.example').pathname, 'mail') as string)).toBe(r.href)
    const open = rowsOf(screen(answer, { selected: 'dana@harbor.example' }))
    expect(open[1]!.html).toContain('aria-current="true"')
    expect(open[0]!.html).not.toContain('aria-current')
    expect(screen(answer, { selected: 'dana@harbor.example' })).toContain('class="split open"')
    expect(screen(answer)).toContain('class="split"')
  })

  test('a search hit leads with, and opens, the person the lists put the thread under', async () => {
    const shared: StandInThread[] = [thread('t-s', minutesAgo(30), ['c-dana', 'c-marcus'], { subject: 'Homepage copy', snippet: 'Saturdays?', listedUnder: 'c-marcus' })]
    const found = await search({ apps: { inbox: standInInbox(contacts, shared), meet: undefined }, install, signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }, 'homepage')
    expect(found.mail.hits.map((h) => [h.people, h.key])).toEqual([[['Marcus Chen', 'Dana Reyes'], 'marcus@harbor.example']])
  })

  test('a search hit opens the conversation of the first other person on it, in the space and not in the inbox', async () => {
    const found = await search({ apps: { inbox: standInInbox(contacts, threads), meet: undefined }, install, signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }, 'homepage')
    const html = screen(null, { query: 'homepage', results: { answer: found, searching: false, problem: null } })
    expect(html).toContain('href="/inbox/dana%40harbor.example"')
    expect(html).not.toContain('inbox.northfield.example')
  })

  test('the chips are All, Outside and Team only: Bulk, Closed, each mailbox and each Client are the inbox’s menu (the tree beside the list, the sheet on a phone), not chips', async () => {
    const html = screen(await answerFor({}, 'mail'))
    for (const id of ['filter-all', 'filter-outside', 'filter-team']) expect(html).toContain(`data-testid="${id}"`)
    for (const id of ['filter-bulk', 'filter-closed', 'filter-mailbox-ridgeway']) expect(html).not.toContain(`data-testid="${id}"`)
    expect(html).toContain('aria-pressed="true" data-testid="filter-all"')
    expect(screen(await answerFor(), { who: 'outside' })).toContain('aria-pressed="true" data-testid="filter-outside"')
    // The button a phone opens the menu from is above the list, saying which view is open.
    expect(html).toContain('data-testid="views-button"')
    expect(html).toContain('<span>Inbox</span>')
    expect(screen(await answerFor(), { view: 'bulk' })).toContain('<span>Views</span>') // the menu is still being read: the view has no name yet but the button is there
  })

  test('a Client’s name is a pill under the row, as on the inbox’s own rows, and the line under the name is who they are', async () => {
    const a = await answerFor()
    const dana = rowsOf(screen(a)).find((r) => r.key === 'dana@harbor.example')?.html ?? ''
    expect(dana).toContain('data-testid="client-pill"')
    expect(dana).toContain('>Harbor Dental</span>')
    expect(dana).toContain('dana@harbor.example') // the line under the name
    expect(dana.match(/Harbor Dental/g)).toHaveLength(2) // the pill and its title, not also the line under the name
    // A person with no Client has no pill, and a channel never has one.
    for (const r of rowsOf(screen(a)).filter((r) => r.key !== 'dana@harbor.example' && r.key !== 'marcus@harbor.example')) expect([r.key, r.html.includes('client-pill')]).toEqual([r.key, false])
  })

  test('Outside and Team cut the main list by who the row is: Team is everything that is not outside, channels included', async () => {
    const a = await answerFor()
    expect(filterRows(a.rows, 'outside').map((r) => r.name)).toEqual(['Dana Reyes', 'Tomas Alvarez'])
    expect(filterRows(a.rows, 'team').map((r) => r.name)).toEqual(['launch', 'Priya'])
    expect(filterRows(a.rows, 'all').map((r) => r.name)).toEqual(['Dana Reyes', 'launch', 'Tomas Alvarez', 'Priya'])
    // The Inbox asks the inbox alone; Meet asks meet alone (format.ts MEET_REQUEST).
    expect(requestFor('outside')).toBe('/api/conversations?scope=mail')
    expect(requestFor('unread')).toBe('/api/conversations?scope=mail&view=unread')
    expect(requestFor('drafts')).toBe('/api/conversations?scope=mail&view=drafts')
    expect(requestFor('client:7')).toBe('/api/conversations?scope=mail&view=client&client=7')
    expect(requestFor('bulk')).toBe('/api/conversations?scope=mail&view=bulk')
    expect(requestFor('sent')).toBe('/api/conversations?scope=mail&view=sent')
    expect(requestFor('mailbox:ridgeway')).toBe('/api/conversations?scope=mail&view=mailbox&mailbox=ridgeway')
    expect(MEET_REQUEST).toBe('/api/conversations?scope=chat')
  })

  test('nothing in a view says so, but only when both parts answered', async () => {
    const empty = await answerFor({ inbox: standInInbox([], []), meet: standInMeet({ direct: [], channels: [] }) })
    expect(screen(empty)).toContain('data-testid="empty-conversations"')
    const down = await answerFor({ inbox: null, meet: standInMeet({ direct: [], channels: [] }) })
    expect(screen(down)).not.toContain('data-testid="empty-conversations"')
  })

  test('before the first answer: loading, and no claim that it is empty', () => {
    const html = screen(null, { loading: true })
    expect(html).toContain('data-testid="loading"')
    expect(html).not.toContain('empty-conversations')
    expect(html).toContain('aria-busy="true"')
  })

  test('chat’s live state shows only in Meet, and only when there is one to show', () => {
    expect(screen(null, { scope: 'chat', live: 'open' })).toContain('Chat is live')
    expect(screen(null, { scope: 'chat', live: 'reconnecting' })).toContain('Reconnecting chat')
    expect(screen(null, { scope: 'chat', live: 'off' })).not.toContain('data-testid="live"')
    expect(screen(null, { scope: 'chat', live: 'connecting' })).not.toContain('data-testid="live"')
  })
})

describe('one part down: the other’s rows stay, and the line says what could not be reached', () => {
  test('email that could not be reached leaves the chat rows, with a warning that says so', async () => {
    const answer = await answerFor({ inbox: null })
    const html = screen(answer)
    expect(rowsOf(html).map((r) => r.key)).toEqual(['dana@harbor.example', 'chat:channel:21', 'priya@northfield.example'])
    expect(html).toContain('data-notice="unreachable" data-part="mail"')
    expect(html).toContain('Email could not be reached just now, so it is missing from this list. Showing chat only.')
    expect(html).not.toContain('data-notice="refused"')
  })

  test('chat that took too long leaves the email rows, and says that, not “could not be reached”', async () => {
    const slow = standInMeet({ direct: [], channels: [] }, { delayMs: 300 })
    const html = screen(await answerFor({ meet: slow }))
    expect(rowsOf(html).map((r) => r.key)).toEqual(['tomas@mail.example', 'dana@harbor.example'])
    expect(html).toContain('Chat took too long to answer just now, so it is missing from this list. Showing email only.')
  })

  test('a refusal reads differently: nothing is down, the app does not open its part to this person, and the other part still shows', async () => {
    const inbox = standInInbox([], [])
    inbox.people = async () => ({ ok: false, kind: 'refused', reason: 'not-admitted', message: 'This is not open to you.' })
    const html = screen(await answerFor({ inbox }))
    expect(html).toContain('data-notice="refused" data-part="mail"')
    expect(html).toContain('Email is not open to you.')
    expect(html).not.toContain('data-notice="unreachable"')
    expect(html).not.toContain('could not be reached')
    expect(rowsOf(html).length).toBe(3) // Dana, the channel and Priya, from chat
  })

  test('an app that refuses the sign-in the space just verified is misconfigured: the line says it could not check it, with no advice to reload, and the Worker logs it', async () => {
    const parts: PartStatus[] = [{ part: 'mail', state: 'not-open-to-you', refusal: { ok: false, kind: 'refused', reason: 'not-signed-in', message: 'You are not signed in.' } }, { part: 'chat', state: 'ok' }]
    const [notice] = noticesFor(parts)
    expect([notice!.kind, notice!.text]).toEqual(['refused', 'Email could not check your sign-in.'])
    expect(notice!.text).not.toMatch(/reload|sign in again/i)
    const logged: string[] = []
    const was = console.error
    console.error = (m: string) => void logged.push(String(m))
    try {
      const inbox = standInInbox([], [])
      inbox.people = async () => ({ ok: false, kind: 'refused', reason: 'not-signed-in', message: 'You are not signed in.' })
      const answer = await answerFor({ inbox })
      expect(answer.parts[0]).toMatchObject({ part: 'mail', state: 'not-open-to-you' })
    } finally {
      console.error = was
    }
    expect(logged.some((l) => l.includes('refused a person the space had signed in') && l.includes('the inbox'))).toBe(true)
  })

  test('both parts down: both are named, neither claims to be the only one', () => {
    const parts: PartStatus[] = [
      { part: 'mail', state: 'could-not-be-reached', reason: 'unreachable' },
      { part: 'chat', state: 'could-not-be-reached', reason: 'broken' },
    ]
    const n = noticesFor(parts)
    expect(n).toHaveLength(2)
    expect(n[0]!.text).toBe('Email could not be reached just now, so it is missing from this list. It will be tried again.')
    expect(n[1]!.text).toBe('Chat had a problem and could not answer just now, so it is missing from this list. It will be tried again.')
  })

  test('a sign-in that ended, or a network that failed, is not drawn as an app being down', () => {
    expect(screen(null, { problem: 'signin' })).toContain('data-notice="signin"')
    const html = screen(null, { problem: 'network' })
    expect(html).toContain('data-notice="network"')
    expect(html).toContain('The space could not be reached just now.')
  })
})

describe('search', () => {
  const results = (answer: SearchAnswer | null, problem: ScreenProps['results'] extends infer R ? (R extends { problem: infer P } ? P : never) : never = null) => ({ answer, searching: false, problem })

  test('results are email hits that open the person’s conversation in the Inbox; chat is not in the Inbox, so it is not mentioned', async () => {
    const asked = await search({ apps: { inbox: standInInbox(contacts, threads), meet: undefined }, install, signedIn: OWNER_SIGNED_IN, self: [] }, 'homepage')
    const html = screen(null, { query: 'homepage', results: results(asked) })
    expect(html).toContain('data-testid="results"')
    expect(html).toContain('Email')
    expect(html).toContain('1 found')
    expect(html).toContain('Homepage copy')
    expect(html).toContain('href="/inbox/dana%40harbor.example"')
    expect(html).not.toContain('inbox.northfield.example')
    expect(html).not.toContain('Chat')
    expect(html).not.toContain('data-testid="rows"') // the list gives way to the results
  })

  test('no email match is said, with the words searched for', async () => {
    const asked = await search({ apps: { inbox: standInInbox(contacts, threads), meet: undefined }, install, signedIn: OWNER_SIGNED_IN, self: [] }, 'zebra')
    expect(screen(null, { query: 'zebra', results: results(asked) })).toContain('No email matches “zebra”.')
  })

  test('an inbox that could not be reached is a warning beside the results, not an empty result', async () => {
    const asked = await search({ apps: { inbox: undefined, meet: undefined }, install, signedIn: OWNER_SIGNED_IN, self: [] }, 'x')
    const html = screen(null, { query: 'x', results: results(asked) })
    expect(html).toContain('data-notice="unreachable" data-part="mail"')
    expect(html).not.toContain('No email matches')
  })

  test('the search box is there and the clear button only once something is typed', () => {
    expect(screen(null)).toContain('data-testid="search"')
    expect(screen(null)).not.toContain('Clear the search')
    expect(screen(null, { query: 'ab' })).toContain('Clear the search')
  })
})

describe('small words', () => {
  test('times are short: now, minutes, hours, yesterday, a weekday, a date', () => {
    expect(ago(T0, T0 - 10_000)).toBe('now')
    expect(ago(T0, T0 - 5 * 60_000)).toBe('5m')
    expect(ago(T0, T0 - 3 * 3_600_000)).toBe('3h')
    expect(ago(T0, T0 - 30 * 3_600_000)).toBe('Yesterday')
    expect(ago(T0, T0 + 5_000)).toBe('now') // a clock a little behind the server's never reads "in the future"
    expect(ago(T0, T0 - 30 * 86_400_000)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/)
  })

  test('initials are the first and last word’s first letters, and nothing for a name with no letter', () => {
    expect([initials('Dana Reyes'), initials('Prince'), initials('(626) 555-0142'), initials('Mary Ann de Silva'), initials('')]).toEqual(['DR', 'P', '', 'MS', ''])
  })
})

describe('a row’s mark', () => {
  const textOnly = async () =>
    screen(
      await answerFor({
        inbox: standInInbox([contact('c-text', '(626) 555-0142'), contact('c-bare', '+1 626 555 0199', 'zed@x.example')], [thread('t1', minutesAgo(5), ['c-text'], { kind: 'sms' }), thread('t2', minutesAgo(6), ['c-bare'])]),
        meet: standInMeet({ direct: [], channels: [channel(21, 'launch', minutesAgo(20))] }),
      }),
    )

  test('the “#” is a channel’s and only a channel’s: a person with no name, only a number, gets a phone mark, never a hash', async () => {
    const rows = rowsOf(await textOnly())
    const marks = rows.map((r) => [r.key, /data-mark="(\w+)"/.exec(r.html)?.[1]])
    expect(marks).toEqual([['mail:c-text', 'phone'], ['zed@x.example', 'phone'], ['chat:channel:21', 'channel']])
    const person = rows.find((r) => r.key === 'mail:c-text')!.html
    expect(person).not.toContain('>#<')
    expect(person.match(/<span class="avatar-lg[^>]*>.*?<\/span>/s)?.[0]).not.toContain('M7.5 3 6 17') // hash's path
    expect(rows.find((r) => r.key === 'chat:channel:21')!.html).toContain('M7.5 3 6 17')
  })

  test('which mark a row gets depends on whether it is a channel, then on its name', async () => {
    const a = await answerFor({
      inbox: standInInbox([contact('c-a', 'Dana Reyes', 'dana@harbor.example'), contact('c-n', '(626) 555-0142'), contact('c-sym', '???', 'qq@x.example')], [thread('t1', minutesAgo(5), ['c-a']), thread('t2', minutesAgo(6), ['c-n'], { kind: 'sms' }), thread('t3', minutesAgo(7), ['c-sym'])]),
      meet: standInMeet({ direct: [], channels: [channel(21, 'launch', minutesAgo(20))] }),
    })
    expect(a.rows.map((r) => [r.name, markFor(r)])).toEqual([
      ['Dana Reyes', { kind: 'text', text: 'DR' }],
      ['(626) 555-0142', { kind: 'phone' }],
      ['???', { kind: 'text', text: 'Q' }],
      ['launch', { kind: 'channel' }],
    ])
  })
})

describe('how a row came, as a glyph', () => {
  test('an email is a letter, a text a phone and a note a pen, each its own, a chat a bubble and a channel the hash', async () => {
    const a = await answerFor({
      inbox: standInInbox(
        [contact('c-e', 'Em', 'em@x.example'), contact('c-t', 'Tex', 'tex@x.example'), contact('c-n', 'Note', 'note@x.example')],
        [thread('t1', minutesAgo(5), ['c-e']), thread('t2', minutesAgo(6), ['c-t'], { kind: 'sms' }), thread('t3', minutesAgo(7), ['c-n'], { kind: 'manual' })],
      ),
      meet: standInMeet({ direct: [dm(11, person('p-c', 'Cy', 'cy@northfield.example', 'teammate'), minutesAgo(8))], channels: [channel(21, 'launch', minutesAgo(9))] }),
    })
    expect(a.rows.map((r) => [r.name, cameGlyph(r)])).toEqual([['Em', 'mail'], ['Tex', 'phone'], ['Note', 'note'], ['Cy', 'chat'], ['launch', 'hash']])
  })
})
