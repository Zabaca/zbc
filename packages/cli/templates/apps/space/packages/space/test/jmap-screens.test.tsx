// The space's screens for a mailbox on Northfield's own mail server (read and written over JMAP). The menu's tree entry and its foot line, the Settings card and the words
// of each state (live, still reading in, refused, unreachable, no longer declared), Sync now, the New email box's From list (offered while the server takes the space's key, with no files), and Settings reading the answer from
// the inbox: a card in a shape nobody promised is never half read. Over the real views over the stand-in inbox; the fixtures (src/stand-ins.ts) are the invented data the e2e photographs.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { InboxJmap, InboxNav } from '@space/workspace'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { renderToStaticMarkup } from 'react-dom/server'
import { northfield } from '../../workspace/test/helpers'
import { newCompose } from '../src/client/compose'
import { statusLines, treeOf } from '../src/client/nav'
import { AUTOMATIC, filesAllowed, fromOf, fromOptions, whyNotNew } from '../src/client/newmailRules'
import { JmapCard } from '../src/client/Settings'
import { fixtureViews } from '../src/fixture-views'
import { fixtureApps } from '../src/stand-ins'
import { type ReadName, readView } from '../src/views'
import { OWNER_SIGNED_IN } from './signed-in'

const MIN = 60_000
const NOW = Date.UTC(2026, 10, 5, 18, 0, 0)
const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>).replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
const noop = () => undefined

beforeAll(() => {
  GlobalRegistrator.register()
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const jmap = (over: Partial<InboxJmap> = {}): InboxJmap => ({
  id: 'harborline',
  name: 'harborline',
  address: 'test@harborline.example',
  declared: true,
  state: 'live',
  refusedAt: null,
  push: 'live',
  lastPushAt: NOW - 4 * MIN,
  lastSyncAt: NOW - 4 * MIN,
  lastError: null,
  lastErrorAt: null,
  messages: 14,
  conversations: 9,
  open: 5,
  unreadOpen: 2,
  reasons: [],
  ...over,
})

const nav = (over: Partial<NonNullable<InboxNav['jmap']>[number]> | null): InboxNav => ({
  views: { inbox: { count: 3, unread: 1 }, unread: { count: 1, unread: 0 }, drafts: { count: 0, unread: 0 }, bulk: { count: 0, unread: 0 }, closed: { count: 0, unread: 0 } },
  mailboxes: [],
  clients: [],
  contacts: 3,
  gmailAccounts: [],
  ...(over !== null && { jmap: [{ id: 'harborline', name: 'harborline', address: 'test@harborline.example', count: 2, unread: 1, state: 'live' as const, lastSyncAt: NOW - 4 * MIN, reason: null, ...over }] }),
})

describe('the menu', () => {
  test('the mailbox is in the Mailboxes tree with its rows, between the business mailboxes and Telegram, and not in the menu of an inbox that has none', () => {
    expect(treeOf(nav({}), 'all', true).mailboxes).toEqual([{ key: 'mailbox:harborline', label: 'harborline', href: '/inbox?view=mailbox%3Aharborline', unread: 1, count: 2, active: false, title: 'test@harborline.example' }])
    expect(treeOf(nav(null), 'all', true).mailboxes).toEqual([])
    expect(treeOf({ ...nav({}), jmap: [] }, 'all', true).mailboxes).toEqual([])
    expect(treeOf(nav({}), 'mailbox:harborline', true).mailboxes[0]?.active).toBe(true)
  })

  test('the foot says how it stands, amber only where something needs a look, and says nothing at all for an inbox that has none', () => {
    const line = (over: Partial<NonNullable<InboxNav['jmap']>[number]> | null) => statusLines(nav(over), NOW, 'UTC').find((l) => l.key === 'jmap:harborline')
    expect(line({})).toMatchObject({ text: 'harborline live, synced 4 min ago', amber: false })
    expect(line({ state: 'filling' })).toMatchObject({ text: 'harborline reading in mail', amber: false })
    expect(line({ state: 'resyncing' })).toMatchObject({ text: 'harborline catching up', amber: false })
    expect(line({ state: 'refused', reason: 'The mail server refused the space’s key.' })).toMatchObject({ text: 'harborline: the mail server refused the space', amber: true, title: 'The mail server refused the space’s key.' })
    expect(line({ state: 'unreachable', reason: 'The mail server did not answer well.' })).toMatchObject({ text: 'harborline: mail server not answering', amber: true })
    expect(line({ state: 'undeclared', reason: 'No longer declared.' })).toMatchObject({ text: 'harborline needs a look', amber: true })
    expect(line({ reason: 'The mail server has not yet confirmed the push address.' })).toMatchObject({ text: 'harborline needs a look', amber: true })
    expect(line(null)).toBeUndefined()
  })
})

describe('the Settings card', () => {
  const card = (box: InboxJmap) => html(<JmapCard box={box} now={NOW} busy={false} onSync={noop} />)

  test('live: the numbers Tessa checks it by, the push, and Sync now', () => {
    const markup = card(jmap())
    expect(markup).toContain('data-state="live"')
    expect(markup).toContain('test@harborline.example')
    expect(markup).toContain('4 min ago')
    expect(markup).toContain('On: the server calls the inbox when mail arrives')
    expect(markup).toContain('14 messages in 9 conversations')
    expect(markup).toContain('5 conversations, 2 unread')
    expect(markup).toContain('data-testid="sync-jmap"')
    expect(markup.includes('s-card amber')).toBe(false)
  })

  test('refused: amber, says when and why, and offers no Sync now (a deploy that changes the key ends it)', () => {
    const markup = card(jmap({ state: 'refused', refusedAt: NOW - 50 * MIN, push: 'off', reasons: ['The mail server refused the space’s key for test@harborline.example. A deploy with a working key ends this.'] }))
    expect(markup).toContain('data-state="refused"')
    expect(markup).toContain('The mail server refused the space’s key')
    expect(markup).toContain('Key refused')
    expect(markup).toContain('s-card amber')
    expect(markup).not.toContain('sync-jmap')
  })

  test('unreachable: amber, and the time since the last good answer is the first failure’s', () => {
    const markup = card(jmap({ state: 'unreachable', lastError: 'The mail server could not be reached: Network connection lost.', lastErrorAt: NOW - 45 * MIN, reasons: ['The mail server did not answer well: Network connection lost.'] }))
    expect(markup).toContain('data-state="unreachable"')
    expect(markup).toContain('Not answering since')
    expect(markup).toContain('45 min ago')
    expect(markup).toContain('s-card amber')
    expect(markup).toContain('data-testid="sync-jmap"')
  })

  test('filling and resyncing say what the inbox is doing; one taken out of the declaration says it is kept and not synced', () => {
    expect(card(jmap({ state: 'filling' }))).toContain('Reading in the last 30 days of mail')
    expect(card(jmap({ state: 'resyncing' }))).toContain('Catching up')
    const gone = card(jmap({ state: 'undeclared', declared: false, reasons: ['test@harborline.example is no longer declared, so it is kept and not synced.'] }))
    expect(gone).toContain('No longer declared in the deploy: kept, not synced')
    expect(gone).not.toContain('sync-jmap')
  })

  test('a mailbox that has never been told of mail or synced says never, and the card carries no key and no secret', () => {
    const markup = card(jmap({ lastPushAt: null, lastSyncAt: null, push: 'waiting' }))
    expect(markup).toContain('never')
    expect(markup).toContain('Asked for, not yet confirmed by the server')
    expect(markup.toLowerCase()).not.toContain('secret')
    expect(markup.toLowerCase()).not.toContain('bearer')
  })
})

describe('the New email box', () => {
  const choices = (jmapBoxes: Parameters<typeof fromOptions>[0] extends infer M ? (M extends { jmap?: infer J } ? J : never) : never) => ({
    gmailAccounts: [{ id: 'gm', name: 'northfield', address: 'tessa@northfield.example', connected: true, state: 'live' }],
    mailboxes: [{ id: 'ridgeway', name: 'Ridgeway Cycles', address: 'info@ridgewaycycles.example' }],
    jmap: jmapBoxes,
    capabilities: ['new-email-from-and-files'],
  })

  test('a mailbox on the mail server is offered while the server takes the key, named with its address, and not once it is refused, undeclared or without a key', () => {
    const live = fromOptions(choices([jmap()]))
    expect(live.map((o) => o.value)).toEqual(['auto', 'gmail:gm', 'business:ridgeway', 'jmap:harborline'])
    expect(live.at(-1)?.label).toBe('harborline (test@harborline.example)')
    for (const state of ['refused', 'undeclared', 'no-credential'] as const) {
      expect(fromOptions(choices([jmap({ state })])).map((o) => o.value)).toEqual(['auto', 'gmail:gm', 'business:ridgeway'])
    }
    expect(fromOptions(choices([jmap({ declared: false })])).map((o) => o.value)).not.toContain('jmap:harborline')
    // an inbox that predates them says nothing of them
    expect(fromOptions({ ...choices([]), jmap: undefined }).map((o) => o.value)).toEqual(['auto', 'gmail:gm', 'business:ridgeway'])
    // filling and unreachable still send (the server may answer), as Gmail's filling account does
    expect(fromOptions(choices([jmap({ state: 'filling' })])).map((o) => o.value)).toContain('jmap:harborline')
    expect(fromOptions(choices([jmap({ state: 'unreachable' })])).map((o) => o.value)).toContain('jmap:harborline')
  })

  test('it means the inbox’s business mailbox by its id, takes no files, and says why', () => {
    expect(fromOf('jmap:harborline')).toEqual({ kind: 'business', mailboxId: 'harborline' })
    expect(fromOf('business:ridgeway')).toEqual({ kind: 'business', mailboxId: 'ridgeway' })
    expect(fromOf(AUTOMATIC)).toBeUndefined()
    expect(filesAllowed('jmap:harborline')).toBe(false)
    expect(filesAllowed('business:ridgeway')).toBe(true)
    const withFile = { ...newCompose(), text: 'Words.', files: [{ name: 'a.pdf', type: 'application/pdf', bytes: new Uint8Array([1]) }] } as never
    expect(whyNotNew({ to: 'dana@example.com', subject: 'Hello', from: 'jmap:harborline' }, withFile)).toContain('Files go from')
  })
})

describe('Settings reads the card from the inbox’s answer', () => {
  type Inbox = ReturnType<typeof fixtureApps>['inbox']
  const ask = (inbox: Inbox) => ({ apps: { inbox, meet: undefined }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 })
  const view = async (inbox: Inbox, name: string) => {
    const r = await readView(ask(inbox), name as ReadName, new URLSearchParams())
    if (!r.ok) throw new Error(r.message)
    return r.value as { result: string; value: { jmap?: { name: string; state: string }[] } }
  }

  test('the fixtures’ mailbox is read whole in the mailboxes and in the menu, in each of its three states', async () => {
    for (const [mode, state] of [
      ['1', 'live'],
      ['jmap-refused', 'refused'],
      ['jmap-down', 'unreachable'],
    ] as const) {
      const { inbox } = fixtureApps(NOW, mode)
      const cards = await view(inbox, 'mailboxes')
      expect(cards.result).toBe('ok')
      expect(cards.value.jmap?.map((m) => [m.name, m.state])).toEqual([['harborline', state]])
      const menu = await view(inbox, 'navigation')
      expect(menu.result).toBe('ok')
      expect(menu.value.jmap?.map((m) => [m.name, m.state])).toEqual([['harborline', state]])
    }
  })

  test('a card in a shape nobody promised is never half read: the answer is refused', async () => {
    for (const bad of [{ state: 'on fire' }, { push: 'sometimes' }, { messages: -1 }, { reasons: [3] }, { declared: 'yes' }]) {
      const { inbox } = fixtureApps(NOW)
      const real = inbox.mailboxes.bind(inbox)
      inbox.mailboxes = async (a) => {
        const r = await real(a)
        return r.ok ? ({ ...r, value: { ...r.value, jmap: [{ ...(r.value.jmap?.[0] as object), ...bad }] } } as never) : r
      }
      expect((await view(inbox, 'mailboxes')).result, JSON.stringify(bad)).not.toBe('ok')
    }
    expect(fixtureViews(NOW).jmap).toHaveLength(1)
  })
})
