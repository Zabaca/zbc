// The inbox's own menu, in the space (nav.tsx): the entries and their counts, the words at the foot, and what picking one does. They were placed after seeing the live list
// beside the inbox: the views, mailboxes and Clients sit as a tree under Inbox (a sheet on a phone), and a row carries its Client as a pill. Pure over the inbox's `navigation`
// answer (packages/workspace/src/inbox-views.ts); the presses are in a DOM at the end, over the Worker's real read and a stand-in inbox.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { InboxNav } from '@space/workspace'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { renderToStaticMarkup } from 'react-dom/server'
import { northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { fixtureViews } from '../src/fixture-views'
import { filterRows, meetViewOf, narrow, narrowMeet, requestFor, viewAt, viewOf } from '../src/client/format'
import { MeetTreeBody, SettingsFoot, TreeBody, currentOf, meetTreeOf, meetViewHref, setPhoneRow, statusLines, treeOf, viewHref } from '../src/client/nav'
import { standInInbox } from '../src/stand-ins'
import { type ReadName, readView } from '../src/views'
import { conversations } from '../src/list'
import { MAIN } from '../src/conversations'
import { ago, contact, thread } from './world'
import { OWNER_SIGNED_IN } from './signed-in'

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)
const noop = () => undefined
const ME = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, northfield())
const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>)

/** What the inbox's own menu says on a day like the one in Tessa's screenshot (2.png): Inbox 20, Unread 0, Drafts 1, Bulk 5 unread of 90, Closed 162, two mailboxes, four Clients, 141 contacts. */
const NAV: InboxNav = {
  views: { inbox: { count: 20, unread: 0 }, unread: { count: 0, unread: 0 }, drafts: { count: 1, unread: 0 }, bulk: { count: 90, unread: 5 }, closed: { count: 162, unread: 0 } },
  mailboxes: [
    { id: 'ridgeway', name: 'Ridgeway Cycles', address: 'info@ridgewaycycles.example', count: 0, unread: 0, lastArrivalAt: NOW - 40 * 60_000, reason: null },
    { id: 'shiftlantern', name: 'ShiftLantern', address: 'hello@shiftlantern.example', count: 0, unread: 0, lastArrivalAt: null, reason: null },
  ],
  clients: [
    { id: 4, name: 'Corin Pike', listed: true, count: 4, unread: 0 },
    { id: 3, name: 'Tamarack Print Supply', listed: true, count: 5, unread: 2 },
    { id: 9, name: 'Lumena', listed: true, count: 0, unread: 0 },
  ],
  contacts: 141,
  gmailAccounts: [{ id: 'gm-northfield', name: 'northfield', address: 'tessa@northfield.example', count: 14, unread: 2, connected: true, state: 'live', lastPushAt: NOW - 3 * 60_000, reason: null }],
}

describe("Meet's menu", () => {
  test('All, Chat, Channels and Calls, and the Phone only for a person who has one, each a place in the address', () => {
    expect(meetTreeOf('all', true, false, false).map((i) => [i.label, i.href, i.count])).toEqual([
      ['All', '/meet', null],
      ['Chat', '/meet?view=chat', null],
      ['Channels', '/meet?view=channels', null],
      ['Calls', '/meet?view=calls', null],
    ])
    expect(meetTreeOf('all', true, true, false).map((i) => i.label)).toEqual(['All', 'Chat', 'Channels', 'Calls', 'Phone'])
    expect(meetTreeOf('all', true, true, false).at(-1)?.href).toBe('/meet/phone')
    for (const view of ['all', 'chat', 'channels', 'calls'] as const) expect(meetViewOf(new URL(`https://x${meetViewHref(view)}`).search)).toBe(view)
    expect(meetViewOf('?view=bulk')).toBe('all')
  })

  test('exactly one item is lit: the view the list is on, or the Phone, and none when the page is not the list', () => {
    const lit = (view: Parameters<typeof meetTreeOf>[0], onList: boolean, onPhone: boolean) => meetTreeOf(view, onList, true, onPhone).filter((i) => i.active).map((i) => i.label)
    expect(lit('channels', true, false)).toEqual(['Channels'])
    expect(lit('all', false, true)).toEqual(['Phone'])
    expect(lit('calls', false, false)).toEqual([])
  })

  test('the markup is the four items, with no inbox group in it', () => {
    const markup = html(<MeetTreeBody view="chat" onList onPhone={false} go={noop} />)
    expect(markup.match(/data-testid="tree-item"/g)).toHaveLength(4)
    expect(markup).toContain('data-key="chat"')
    expect(markup).not.toContain('Mailboxes')
    expect(markup).not.toContain('Contacts')
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1)
  })

  test('the Phone is in the menu once Meet’s list has a Phone row for the person, and not before', () => {
    const items = () => [...html(<MeetTreeBody view="all" onList onPhone={false} go={noop} />).matchAll(/data-key="([a-z]+)"/g)].map((m) => m[1])
    expect(items()).toEqual(['all', 'chat', 'channels', 'calls'])
    setPhoneRow(true)
    try {
      expect(items()).toEqual(['all', 'chat', 'channels', 'calls', 'phone'])
    } finally {
      setPhoneRow(false)
    }
    expect(items()).toEqual(['all', 'chat', 'channels', 'calls'])
  })

  test('the views cut Meet’s one list: Chat is the direct messages, Channels the channels, All the lot', () => {
    const rows = [{ type: 'person' }, { type: 'channel' }, { type: 'call' }, { type: 'phone' }] as never
    expect(narrowMeet(rows, 'chat').map((r) => r.type)).toEqual(['person'])
    expect(narrowMeet(rows, 'channels').map((r) => r.type)).toEqual(['channel'])
    expect(narrowMeet(rows, 'all').map((r) => r.type)).toEqual(['person', 'channel', 'call', 'phone'])
  })
})

describe('the entries of the tree', () => {
  test('the views in the inbox’s order with its counts, and in the accent how many are unread, which Unread itself never says', () => {
    const { views } = treeOf(NAV, 'all', true)
    expect(views.map((v) => [v.label, v.count, v.unread])).toEqual([
      ['Inbox', 20, 0],
      ['Unread', 0, 0],
      // Sent has no number: a count would not be the rows the list shows (cut at the newest screen).
      ['Sent', null, 0],
      ['Drafts', 1, 0],
      ['Bulk', 90, 5],
      ['Closed', 162, 0],
    ])
    const withUnread = treeOf({ ...NAV, views: { ...NAV.views, unread: { count: 7, unread: 7 }, inbox: { count: 20, unread: 7 } } }, 'all', true).views
    expect(withUnread.map((v) => [v.label, v.count, v.unread])).toEqual([['Inbox', 20, 7], ['Unread', 7, 0], ['Sent', null, 0], ['Drafts', 1, 0], ['Bulk', 90, 5], ['Closed', 162, 0]])
  })

  test('each view is a place in the address, and the main list has none', () => {
    expect(treeOf(NAV, 'all', true).views.map((v) => v.href)).toEqual(['/inbox', '/inbox?view=unread', '/inbox?view=sent', '/inbox?view=drafts', '/inbox?view=bulk', '/inbox?view=closed'])
    expect(viewHref('mailbox:ridgeway')).toBe('/inbox?view=mailbox%3Aridgeway')
    expect(viewHref('client:3')).toBe('/inbox?view=client%3A3')
    for (const view of ['all', 'unread', 'sent', 'drafts', 'bulk', 'closed', 'mailbox:ridgeway', 'client:3'] as const) expect(viewOf(new URL(`https://x${viewHref(view)}`).search)).toBe(view)
  })

  test('exactly one item is lit, the view the list is on, and none when the page is not the list', () => {
    const lit = (view: Parameters<typeof treeOf>[1], onList = true) => {
      const t = treeOf(NAV, view, onList)
      return [...t.views, ...t.mailboxes, ...t.clients].filter((i) => i.active).map((i) => i.label)
    }
    expect(lit('all')).toEqual(['Inbox'])
    expect(lit('bulk')).toEqual(['Bulk'])
    expect(lit('mailbox:ridgeway')).toEqual(['Ridgeway Cycles'])
    expect(lit('client:3')).toEqual(['Tamarack Print Supply'])
    expect(lit('client:999')).toEqual([]) // a Client the menu does not list lights nothing
    expect(lit('bulk', false)).toEqual([])
  })

  test('each mailbox with its count and nothing under it (the knowledge base is the Knowledge tab’s); each Client with its open count; no Contacts item', () => {
    const t = treeOf(NAV, 'all', true)
    expect(t.mailboxes.map((m) => [m.label, m.count])).toEqual([
      ['northfield', 14],
      ['Ridgeway Cycles', 0],
      ['ShiftLantern', 0],
    ])
    expect(JSON.stringify(t)).not.toContain('knowledge')
    expect(t.clients.map((c) => [c.label, c.count, c.unread])).toEqual([['Corin Pike', 4, 0], ['Tamarack Print Supply', 5, 2], ['Lumena', 0, 0]])
    // No Contacts item: People is a tab of its own.
    expect('contacts' in treeOf(NAV, 'all', true)).toBe(false)
  })

  test('each Gmail account the person is on is the first of the Mailboxes, by the short name its pill wears, with its own counts, and a lapsed or disconnected one stays (its mail is still held)', () => {
    const account = (id: string, name: string, over: Partial<InboxNav['gmailAccounts'][number]> = {}): InboxNav['gmailAccounts'][number] => ({ id, name, address: `tessa@${name}.example`, count: 0, unread: 0, connected: true, state: 'live', lastPushAt: null, reason: null, ...over })
    const nav: InboxNav = {
      ...NAV,
      gmailAccounts: [account('gm-northfield', 'northfield', { count: 14, unread: 2 }), account('gm-ashgrove', 'ashgrove', { count: 5, unread: 1, state: 'lapsed', reason: 'Connect it again.' }), account('gm-fernway', 'fernway', { connected: false, state: 'disconnected', count: 2 })],
      jmap: [{ id: 'harborline', name: 'Harborline', address: 'test@harborline.example', count: 1, unread: 1, state: 'live', lastSyncAt: null, reason: null }],
      telegram: { id: 'tg', name: 'Telegram', address: '7000000001', count: 2, unread: 1, state: 'live', checkedInAt: null, lastPushAt: null },
    }
    const t = treeOf(nav, 'mailbox:gm-ashgrove', true)
    // Gmail accounts first, then the business mailboxes, then the mail server's, then Telegram.
    expect(t.mailboxes.map((m) => [m.label, m.count, m.unread])).toEqual([
      ['northfield', 14, 2],
      ['ashgrove', 5, 1],
      ['fernway', 2, 0],
      ['Ridgeway Cycles', 0, 0],
      ['ShiftLantern', 0, 0],
      ['Harborline', 1, 1],
      ['Telegram', 2, 1],
    ])
    // Each narrows the list the way a business mailbox does, and the address is its title.
    expect(t.mailboxes.slice(0, 3).map((m) => [m.href, m.title])).toEqual([
      ['/inbox?view=mailbox%3Agm-northfield', 'tessa@northfield.example'],
      ['/inbox?view=mailbox%3Agm-ashgrove', 'tessa@ashgrove.example'],
      ['/inbox?view=mailbox%3Agm-fernway', 'tessa@fernway.example'],
    ])
    expect(viewOf(new URL(`https://x${viewHref('mailbox:gm-ashgrove')}`).search)).toBe('mailbox:gm-ashgrove')
    expect([...t.views, ...t.mailboxes, ...t.clients].filter((i) => i.active).map((i) => i.label)).toEqual(['ashgrove'])
    expect(currentOf(nav, 'mailbox:gm-ashgrove')).toEqual({ label: 'ashgrove', count: 5 })
    // No account connected: no Gmail entry, and the Mailboxes start with the business ones.
    expect(treeOf({ ...NAV, gmailAccounts: [] }, 'all', true).mailboxes.map((m) => m.label)).toEqual(['Ridgeway Cycles', 'ShiftLantern'])
  })

  test('the markup has the inbox’s groups, in its order, and has no footnote about the counts', () => {
    const markup = html(<TreeBody nav={NAV} view="bulk" onList go={noop} />)
    const order = ['Inbox', 'Unread', 'Drafts', 'Bulk', 'Closed', 'Mailboxes', 'northfield', 'Ridgeway Cycles', 'ShiftLantern', 'Clients', 'Corin Pike', 'Tamarack Print Supply', 'Lumena']
    let at = 0
    for (const word of order) {
      const next = markup.indexOf(word, at)
      expect([word, next >= at]).toEqual([word, true])
      at = next
    }
    expect(markup).not.toContain('Counts are the inbox’s own')
    expect(markup).not.toContain('Contacts')
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1)
    // A tree with no Gmail account, no business mailbox and no Client has neither heading.
    const bare = html(<TreeBody nav={{ ...NAV, gmailAccounts: [], mailboxes: [], clients: [] }} view="all" onList go={noop} />)
    expect(bare).not.toContain('Mailboxes')
    expect(bare).not.toContain('Clients')
  })

  test('the button a phone opens it from says which view is open and its count', () => {
    expect(currentOf(NAV, 'all')).toEqual({ label: 'Inbox', count: 20 })
    expect(currentOf(NAV, 'bulk')).toEqual({ label: 'Bulk', count: 90 })
    expect(currentOf(NAV, 'client:3')).toEqual({ label: 'Tamarack Print Supply', count: 5 })
    expect(currentOf(NAV, 'client:999')).toEqual({ label: 'Inbox', count: 20 })
  })
})

describe('the foot: Settings, and the lines the inbox says under it', () => {
  test('Gmail live and its last push, and each mailbox’s last mail', () => {
    expect(statusLines(NAV, NOW).map((l) => [l.text, l.amber])).toEqual([
      ['northfield Gmail live, last push 3 min ago', false],
      ['Ridgeway Cycles: last mail 40 min ago', false],
      ['ShiftLantern: no mail yet', false],
    ])
  })

  test('a line that needs a look is amber and says why: a list that has gone quiet is never trusted without it', () => {
    const account = (over: Partial<InboxNav['gmailAccounts'][number]> = {}): InboxNav['gmailAccounts'][number] => ({ id: 'gm-northfield', name: 'northfield', address: 'tessa@northfield.example', count: 0, unread: 0, connected: true, state: 'live', lastPushAt: null, reason: null, ...over })
    const lines = statusLines({ ...NAV, gmailAccounts: [account({ reason: 'No push for two days.' })], mailboxes: [{ ...(NAV.mailboxes[0] as InboxNav['mailboxes'][number]), reason: 'One message is not filed.' }] }, NOW)
    expect(lines.map((l) => [l.text, l.amber, l.title])).toEqual([
      ['northfield Gmail needs a look', true, 'No push for two days.'],
      ['Ridgeway Cycles needs a look', true, 'One message is not filed.'],
    ])
    expect(statusLines({ ...NAV, gmailAccounts: [], mailboxes: [] }, NOW)[0]).toMatchObject({ text: 'Gmail not connected', amber: true })
    expect(statusLines({ ...NAV, gmailAccounts: [account({ connected: false, state: 'disconnected' })], mailboxes: [] }, NOW)[0]).toMatchObject({ text: 'northfield Gmail disconnected', amber: true })
    expect(statusLines({ ...NAV, gmailAccounts: [account({ state: 'filling' })], mailboxes: [] }, NOW)[0]?.text).toBe('northfield Gmail reading in mail')
    expect(statusLines({ ...NAV, gmailAccounts: [account()], mailboxes: [] }, NOW)[0]?.text).toBe('northfield Gmail live, no push yet')
  })

  test('each Gmail account has its own line, and one whose sign-in lapsed says so by name, in amber, with the sentence that says what to do', () => {
    const lapsed = 'Google no longer accepts the saved sign-in for tessa@ashgrove.example (a Google app in testing mode loses its grants after 7 days), so nothing new arrives or goes out from it. Connect it again.'
    const lines = statusLines(
      {
        ...NAV,
        mailboxes: [],
        gmailAccounts: [
          { id: 'gm-northfield', name: 'northfield', address: 'tessa@northfield.example', count: 3, unread: 0, connected: true, state: 'live', lastPushAt: NOW - 60_000, reason: null },
          { id: 'gm-ashgrove', name: 'ashgrove', address: 'tessa@ashgrove.example', count: 0, unread: 0, connected: true, state: 'lapsed', lastPushAt: null, reason: lapsed },
        ],
      },
      NOW,
    )
    expect(lines.map((l) => [l.key, l.text, l.amber])).toEqual([
      ['gmail:gm-northfield', 'northfield Gmail live, last push 1 min ago', false],
      ['gmail:gm-ashgrove', 'ashgrove Gmail: connect it again', true],
    ])
    expect(lines[1]?.title).toBe(lapsed)
  })

  test('Settings is drawn with the lines under it once the menu is read, and with none while it is not', () => {
    const loaded = html(<SettingsFoot nav={{ kind: 'value', value: NAV }} now={NOW} active go={noop} />)
    expect(loaded).toContain('Settings')
    expect(loaded.match(/data-testid="status-line"/g)).toHaveLength(3)
    expect(loaded).toContain('aria-current="page"')
    const loading = html(<SettingsFoot nav={{ kind: 'loading' }} now={NOW} active={false} go={noop} />)
    expect(loading).toContain('Settings')
    expect(loading).not.toContain('status-line')
  })
})

describe('what a view keeps of the list', () => {
  const answer = async () => {
    const inbox = standInInbox(
      [
        { ...contact('c-dana', 'Dana Reyes', 'dana@harbor.example'), client: { id: 7, name: 'Harbor Dental' } },
        { ...contact('c-marcus', 'Marcus Chen', 'marcus@harbor.example'), client: { id: 7, name: 'Harbor Dental' } },
        contact('c-lena', 'Lena Fischer', 'lena@bakery.example'),
        contact('c-pri', 'Priya', 'priya@northfield.example'),
      ],
      [
        thread('t-dana', ago(10), ['c-dana'], { unread: true }),
        thread('t-marcus', ago(20), ['c-marcus']),
        thread('t-lena', ago(30), ['c-lena'], { unread: true }),
        thread('t-pri', ago(40), ['c-pri']),
      ],
      { drafts: [{ id: 'd-1', conversationId: 't-lena', contactId: 'c-lena', subject: 'Re', text: 'Hi', at: ago(5) }] },
    )
    return conversations({ apps: { inbox, meet: undefined }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }, MAIN)
  }

  test('Unread keeps the rows with anything unread; Drafts the people with a draft waiting; a Client the people linked to it; the rest cut by who they are', async () => {
    const a = await answer()
    const names = (rows: ReturnType<typeof filterRows>) => rows.map((r) => r.name)
    expect(names(narrow(a.rows, 'all', 'all'))).toEqual(['Dana Reyes', 'Marcus Chen', 'Lena Fischer', 'Priya'])
    expect(names(narrow(a.rows, 'unread', 'all'))).toEqual(['Dana Reyes', 'Lena Fischer'])
    expect(names(narrow(a.rows, 'drafts', 'all'))).toEqual(['Lena Fischer'])
    expect(names(narrow(a.rows, 'client:7', 'all'))).toEqual(['Dana Reyes', 'Marcus Chen'])
    expect(names(narrow(a.rows, 'client:8', 'all'))).toEqual([])
    // The two cuts together: the Client's people, who are outside the team.
    expect(names(narrow(a.rows, 'client:7', 'outside'))).toEqual(['Dana Reyes', 'Marcus Chen'])
    expect(names(narrow(a.rows, 'unread', 'team'))).toEqual([])
    expect(requestFor('unread')).toBe('/api/conversations?scope=mail&view=unread')
    expect(requestFor('bulk')).toBe('/api/conversations?scope=mail&view=bulk')
  })

  test('a person’s row says how many drafts wait for them, and a person with none says none', async () => {
    const a = await answer()
    const drafts = Object.fromEntries(a.rows.flatMap((r) => (r.type === 'person' ? [[r.name, r.drafts]] : [])))
    expect(drafts).toEqual({ 'Dana Reyes': 0, 'Marcus Chen': 0, 'Lena Fischer': 1, Priya: 0 })
  })

  test('a draft’s own address that names no view is the Drafts view, so the tree and the list agree; one that names a view keeps it', () => {
    expect(viewAt('/inbox/draft/d-1', '')).toBe('drafts')
    expect(viewAt('/inbox/draft/d-1', '?view=unread')).toBe('unread')
    expect(viewAt('/inbox/ana%40x.example', '')).toBe('all')
    expect(viewAt('/inbox', '?view=bulk')).toBe('bulk')
  })

  test('an address that names no view, or a view that is not one, is the main list', () => {
    for (const search of ['', '?view=', '?view=nonsense', '?view=mailbox:', '?view=client:0', '?view=client:x', '?view=mailbox:../x', '?view=bulk&view=closed']) {
      expect([search, viewOf(search)]).toEqual([search, search === '?view=bulk&view=closed' ? 'bulk' : 'all'])
    }
  })
})

// ── What a press does, in a DOM ──────────────────────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const realFetch = globalThis.fetch

describe('the menu, pressed', () => {
  beforeAll(() => {
    GlobalRegistrator.register()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterAll(async () => {
    await GlobalRegistrator.unregister()
    globalThis.fetch = realFetch
  })

  /** The Worker's own `navigation` read over a stand-in inbox, as the page's fetch reaches it. */
  function nav() {
    const inbox = standInInbox([{ ...contact('c-dana', 'Dana Reyes', 'dana@harbor.example'), client: { id: 7, name: 'Harbor Dental' } }], [thread('t-1', Date.now() - 600_000, ['c-dana'], { unread: true })], { views: fixtureViews(Date.now()) })
    const ask = { apps: { inbox, meet: undefined }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname === '/api/conversations') return json(await conversations(ask, MAIN))
      if (!url.pathname.startsWith('/api/inbox/')) return json({ error: 'no live chat here' }, 403)
      const got = await readView(ask, url.pathname.replace('/api/inbox/', '') as ReadName, url.searchParams)
      return json(got.ok ? got.value : { error: got.message }, got.ok ? 200 : 400)
    }) as typeof fetch
    return inbox
  }

  test('the tree draws from the inbox’s own counts; picking an item goes to that view; the sheet on a phone opens, picks and shuts', async () => {
    const inbox = nav()
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { useNavData } = await import('../src/client/nav')
    const { Space } = await import('../src/client/App')
    document.body.innerHTML = '<div id="root"></div>'
    const gone: string[] = []
    const root = createRoot(document.getElementById('root') as HTMLElement)
    function Shell() {
      return createElement(Space, { me: ME, pathname: '/inbox', search: '?view=bulk', go: (p: string) => void gone.push(p) })
    }
    await act(async () => {
      root.render(createElement(Shell))
      await sleep(120)
    })
    const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
    const items = () => [...document.querySelectorAll('.rail [data-testid="tree-item"]')] as HTMLElement[]
    // The tree is under Inbox in the rail, with the inbox's own counts and the current view lit.
    expect(inbox.views.calls.map((c) => c.method)).toContain('navigation')
    expect(items().map((i) => i.getAttribute('data-key'))).toEqual(['all', 'unread', 'sent', 'drafts', 'bulk', 'closed', 'mailbox:gmail-northfield', 'mailbox:gmail-ashgrove', 'mailbox:ridgeway', 'mailbox:shiftlantern', 'mailbox:harborline', 'mailbox:telegram', 'client:7', 'client:9', 'client:3', 'client:12'])
    expect(items().filter((i) => i.getAttribute('aria-current') === 'page').map((i) => i.getAttribute('data-key'))).toEqual(['bulk'])
    expect(document.querySelectorAll('.rail [data-testid="status-line"]').length).toBe(6)
    // A Gmail account is picked like any mailbox: it goes to that account's list.
    await act(async () => {
      items().find((i) => i.getAttribute('data-key') === 'mailbox:gmail-ashgrove')?.click()
      await sleep(20)
    })
    expect(gone).toEqual(['/inbox?view=mailbox%3Agmail-ashgrove'])
    await act(async () => {
      items().find((i) => i.getAttribute('data-key') === 'client:7')?.click()
      await sleep(20)
    })
    expect(gone).toEqual(['/inbox?view=mailbox%3Agmail-ashgrove', '/inbox?view=client%3A7'])
    void useNavData
    await act(async () => root.unmount())
    expect(q('views-sheet')).toBeNull()
  })

  test('the sheet, in the real list: it opens with focus in it, Escape shuts it and gives focus back, and Inbox reaches the main list from another view', async () => {
    nav()
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { Conversations } = await import('../src/client/Conversations')
    const { NavContext: Context, useNavData } = await import('../src/client/nav')
    document.body.innerHTML = '<div id="root"></div>'
    const gone: string[] = []
    const root = createRoot(document.getElementById('root') as HTMLElement)
    // The App hands the list its own `go`: a place is a place. (The list wraps it so that opening a conversation keeps the view; the sheet must not use that wrapper.)
    const appGo = (p: string) => void gone.push(p)
    function Holder() {
      const state = useNavData()
      return createElement(Context.Provider, { value: state }, createElement(Conversations, { scope: 'mail', me: ME, pathname: '/inbox', search: '?view=bulk', go: appGo }))
    }
    await act(async () => {
      root.render(createElement(Holder))
      await sleep(150)
    })
    const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
    expect(q('views-button')?.textContent).toContain('Bulk')
    expect(q('views-sheet')).toBeNull()
    await act(async () => {
      q('views-button')?.click()
      await sleep(20)
    })
    expect(q('views-sheet')).not.toBeNull()
    expect(document.activeElement).toBe(q('views-sheet'))
    expect(document.querySelectorAll('[data-testid="views-sheet"] [data-testid="tree-item"]').length).toBe(16)
    expect(document.querySelectorAll('[data-testid="views-sheet"] [data-testid="status-line"]').length).toBe(6)
    expect(q('views-sheet')?.textContent).toContain('Settings')
    // Escape shuts it, goes nowhere, and focus is back on the button that opened it.
    await act(async () => {
      q('views-sheet')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await sleep(20)
    })
    expect(q('views-sheet')).toBeNull()
    expect(document.activeElement).toBe(q('views-button'))
    expect(gone).toEqual([])
    // The Close button does the same.
    await act(async () => {
      q('views-button')?.click()
      await sleep(20)
    })
    await act(async () => {
      q('views-close')?.click()
      await sleep(20)
    })
    expect(q('views-sheet')).toBeNull()
    // Inbox goes to the main list, with NO view in the address (the list's own `go` would have put ?view=bulk back).
    await act(async () => {
      q('views-button')?.click()
      await sleep(20)
    })
    await act(async () => {
      ;(document.querySelector('[data-testid="views-sheet"] [data-key="all"]') as HTMLElement).click()
      await sleep(20)
    })
    expect(gone).toEqual(['/inbox'])
    expect(q('views-sheet')).toBeNull()
    // Another view goes there and shuts the sheet.
    await act(async () => {
      q('views-button')?.click()
      await sleep(20)
    })
    await act(async () => {
      ;(document.querySelector('[data-testid="views-sheet"] [data-key="drafts"]') as HTMLElement).click()
      await sleep(20)
    })
    expect(gone).toEqual(['/inbox', '/inbox?view=drafts'])
    expect(q('views-sheet')).toBeNull()
    await act(async () => root.unmount())
  })
})
