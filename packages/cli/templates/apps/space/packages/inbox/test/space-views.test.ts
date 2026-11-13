import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createInstall, type InboxForSpace, type SpacePushPayload } from '@space/workspace'
import { CONFIRM_WINDOW_MS } from '../src/restore'
import type { NotificationPayload } from '../src/types'
import { ACME } from '../test-support/clients-part'
import { reply as modelReply } from '../test-support/fake-model'
import { AGENT, asker, harness, OWNER, RIDGEWAY_ASSISTED, STRANGER, T0 } from '../test-support/harness'
import { decrypt, newDevice, type TestDevice } from '../test-support/push-device'
import { rawMail } from '../test-support/raw-mail'

/**
 * The inbox's other views, as the inbox answers the space (src/space-views.ts, which the space's Worker calls in-process),
 * driven as the space drives it: through `InboxForSpace` with the person the space's check named, over the real store, the real
 * Mailroom, the real notifications and the real restore step. What these cannot show is the runtime (that Cloudflare routes the binding
 * to the class and clones these answers) and Google's push service, Chrome and a phone; those are the runbook's checks after the deploy.
 *
 * Per method: who is refused (and that a refused asker changed nothing), what it answers, what it must never answer, and the rules the
 * inbox's own routes already have, which must stay (the switches are Tessa's, a restore asks twice, a change names the version he saw).
 */

type H = ReturnType<typeof harness>

// What the inbox sends a space device is what the space's service worker reads: the contract's `SpacePushPayload` (checked by the compiler, both ways).
const _payloadIsTheContracts: SpacePushPayload = {} as NotificationPayload
const _andBack: NotificationPayload = {} as SpacePushPayload
void _payloadIsTheContracts
void _andBack

const assertion = (who: Record<string, unknown> = OWNER) => asker(who)
const unwrap = <T>(r: { ok: boolean; value?: T }): T => {
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return (r as { value: T }).value
}
const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]
const count = (h: H, table: string) =>
  (rows<{ n: number }>(h, `SELECT count(*) AS n FROM ${table}`)[0] as { n: number }).n

const PIXEL_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 8a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

/** Gmail is connected and has read in what it holds, so there are contacts, and notifications have somewhere to come from. */
async function live(h: H) {
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
}
async function hear(h: H) {
  expect((await h.push()).status).toBe(204)
  await h.drain()
}

/** A store whose Ridgeway mailbox exists (a message has arrived) and where the spam check runs, as it does once mail has come. */
async function withRidgeway(h: H = harness({}, { mailboxes: [RIDGEWAY_ASSISTED] })) {
  await h.deliver(rawMail('first'))
  await h.drain()
  const id = (rows<{ id: string }>(h, `SELECT id FROM mailbox WHERE kind = 'cloudflare'`)[0] as { id: string }).id
  return { h, mailboxId: id }
}

/** Every call of the contract's new part with arguments that would work for the owner. */
const calls = (s: InboxForSpace, a: never) => ({
  navigation: () => s.navigation(a),
  claudeSending: () => s.claudeSending(a),
  setClaudeSending: () => s.setClaudeSending(a, true),
  mailboxes: () => s.mailboxes(a),
  setSpamCheck: () => s.setSpamCheck(a, 'mb-1', true),
  changeGmail: () => s.changeGmail(a, 'disconnect'),
  notifications: () => s.notifications(a),
  addDevice: () =>
    s.addDevice(a, { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p', auth: 'a' } }, PIXEL_UA),
  removeDevice: () => s.removeDevice(a, 'd-1'),
  testDevice: () => s.testDevice(a, 'd-1'),
  restoreReport: () => s.restoreReport(a),
  prepareRestore: () => s.prepareRestore(a, { bookmark: 'a-bookmark-0000' }),
  confirmRestore: () => s.confirmRestore(a, { token: 't', bookmark: 'a-bookmark-0000' }),
  clients: () => s.clients(a),
  client: () => s.client(a, 1),
  linkClient: () => s.linkClient(a, 'c-1', 1),
  draftChat: () => s.draftChat(a, 'v-1', 'd-1'),
  chat: () => s.chat(a, { conversationId: 'v-1', draftId: 'd-1', rev: 0, instruction: 'shorter' }),
})

describe('who is asking, for every one of the inbox’s other views', () => {
  test('there is a call here for every method of the contract’s new part, and no other', () => {
    const h = harness()
    expect(Object.keys(calls(h.space(), '' as never)).sort()).toEqual(
      [
        'navigation',
        'addDevice',
        'changeGmail',
        'chat',
        'claudeSending',
        'client',
        'clients',
        'confirmRestore',
        'draftChat',
        'linkClient',
        'mailboxes',
        'notifications',
        'prepareRestore',
        'removeDevice',
        'restoreReport',
        'setClaudeSending',
        'setSpamCheck',
        'testDevice',
      ].sort(),
    )
  })

  test('someone Cloudflare knows who is not Tessa is not-admitted (a teammate too), and changed nothing at all', async () => {
    const { h } = await withRidgeway()
    const raw = JSON.parse(readFileSync(new URL('../../workspace/northfield/workspace.json', import.meta.url), 'utf8'))
    raw.people.push({ address: 'eve@northfield.example', name: 'Eve', role: 'member' })
    const withTeam = h.space({ install: createInstall(raw) })
    const before = {
      settings: count(h, 'setting'),
      devices: count(h, 'device'),
      audit: count(h, 'audit'),
    }
    for (const who of [STRANGER, { email: 'eve@northfield.example' }]) {
      for (const [method, call] of Object.entries(calls(withTeam, (await assertion(who)) as never))) {
        expect([JSON.stringify(who), method, await call()]).toMatchObject([
          JSON.stringify(who),
          method,
          { ok: false, kind: 'refused', reason: 'not-admitted' },
        ])
      }
    }
    expect({
      settings: count(h, 'setting'),
      devices: count(h, 'device'),
      audit: count(h, 'audit'),
    }).toEqual(before)
    expect(h.objectStorage.armings).toEqual([])
    expect(h.pushService.requests).toEqual([])
  })
})

describe('the menu: the inbox’s own counts, in one read', () => {
  /** A Tuesday: two open conversations (one unread), a newsletter (Bulk), a closed one, a Ridgeway customer, a draft, and Dana under a Client. */
  async function menuWorld() {
    const h = harness({}, { mailboxes: [RIDGEWAY_ASSISTED], ai: null })
    const g = h.google.mailbox
    g.add({
      id: 'm1',
      threadId: 't1',
      from: 'Dana Smith <dana@acme.example>',
      subject: 'Quote for the shop',
      body: 'Can you quote the shop front?',
    })
    g.add({
      id: 'm2',
      threadId: 't2',
      from: 'Eli Park <eli@example.com>',
      subject: 'Shared plan',
      body: 'Here is the plan.',
    })
    g.add({
      id: 'm3',
      threadId: 't3',
      from: 'Brand News <news@brand.example.com>',
      subject: 'Weekly deals',
      body: 'Ten percent off everything this week.',
      headers: { 'List-Unsubscribe': '<mailto:unsubscribe@brand.example.com>' },
    })
    g.add({
      id: 'm4',
      threadId: 't4',
      from: 'Fay Old <fay@example.com>',
      subject: 'Old matter',
      body: 'The deed was filed.',
    })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    g.labelThread('t4', { remove: ['INBOX', 'UNREAD'] })
    await hear(h)
    await h.deliver(rawMail('first'))
    const dana = (
      rows<{ contact_id: string }>(h, `SELECT contact_id FROM identity WHERE address = 'dana@acme.example'`)[0] as {
        contact_id: string
      }
    ).contact_id
    unwrap(await h.space().linkClient(await assertion(), dana, ACME.id))
    const convo = (
      rows<{ id: string }>(h, `SELECT id FROM conversation WHERE gmail_thread_id = 't2'`)[0] as { id: string }
    ).id
    expect(
      h.inbox.createDraft(
        {
          conversationId: convo,
          address: 'eli@example.com',
          name: 'Eli Park',
          subject: 'Re: Shared plan',
          body: 'Thanks, Eli.',
          why: 'Answered.',
        },
        'agent:abc123.access',
      ).ok,
    ).toBe(true)
    return h
  }

  test('each count is the rows its list holds: the views, the mailbox and the Client equal the people the space’s lists are drawn from', async () => {
    const h = await menuWorld()
    const a = await assertion()
    const nav = unwrap(await h.space().navigation(a))
    // What each list is drawn from (`people`, with the scope the list asks for), a row per person with a conversation in the view.
    const people = async (include?: ('bulk' | 'closed')[]) =>
      unwrap(await h.space().people(a, include ? { include } : undefined)).people
    type Line = Awaited<ReturnType<typeof people>>[number]['conversations'][number]
    // A row is a person with a conversation in the view that is LISTED under them: a thread several people are on is one person's row.
    const rowsIn = async (include: ('bulk' | 'closed')[] | undefined, keep: (l: Line) => boolean) => {
      const listedKeep = (l: Line) => l.listed === true && keep(l)
      const rows = (await people(include)).filter((p) => p.conversations.some(listedKeep))
      return {
        count: rows.length,
        unread: rows.filter((p) => p.conversations.some((l) => listedKeep(l) && l.unread)).length,
      }
    }
    expect(nav.views.inbox).toEqual(await rowsIn(undefined, (l) => l.open && !l.bulk))
    const unread = await rowsIn(undefined, (l) => l.open && !l.bulk && l.unread)
    expect(nav.views.unread).toEqual({ count: unread.count, unread: unread.count })
    expect(nav.views.bulk).toEqual(await rowsIn(['bulk'], (l) => l.open && l.bulk))
    expect(nav.views.closed).toEqual(await rowsIn(['closed'], (l) => !l.open))
    // The menu adds none of the drafts on no conversation here (there are none), so Drafts is the people with a draft waiting.
    expect(nav.views.drafts.count).toBe((await rowsIn(['bulk', 'closed'], (l) => l.drafts > 0)).count)
    expect([nav.views.bulk.count, nav.views.closed.count, nav.views.drafts.count]).toEqual([1, 1, 1])
    expect(nav.views.inbox.count).toBeGreaterThanOrEqual(3)
    const ridgeway = nav.mailboxes[0]
    expect(ridgeway).toMatchObject({
      name: 'Ridgeway Cycles',
      address: 'info@ridgewaycycles.example',
      reason: null,
      ...(await rowsIn(undefined, (l) => l.mailbox?.id === ridgeway?.id)),
    })
    expect(ridgeway?.count).toBe(1)
    const clients = (await h.request(AGENT, 'GET', '/api/clients')).json.clients as { id: number; name: string }[]
    expect(nav.clients.map((c) => [c.id, c.name])).toEqual(clients.map((c) => [c.id, c.name]))
    expect(nav.clients.find((c) => c.name === 'Acme Legal')).toMatchObject({ count: 1, listed: true })
    expect(nav.contacts).toBe((await h.request(AGENT, 'GET', '/api/contacts')).json.length)
    // The Gmail account is a place in the menu like the business mailbox, and counts the rows its list holds.
    expect(nav.gmailAccounts).toMatchObject([
      {
        address: 'tessa@northfield.example',
        name: 'northfield',
        connected: true,
        state: 'live',
        ...(await rowsIn(undefined, (l) => l.open && !l.bulk && l.mailbox?.id === nav.gmailAccounts[0]?.id)),
      },
    ])
    expect(nav.gmailAccounts[0]?.count).toBeGreaterThan(0)
  })

  test('a person with several conversations is one row, and a thread two people are on is one row, under the one who wrote', async () => {
    const h = harness({}, { mailboxes: [], ai: null })
    const g = h.google.mailbox
    for (const n of [1, 2, 3])
      g.add({
        id: `d${n}`,
        threadId: `td${n}`,
        from: 'Dana Smith <dana@acme.example>',
        subject: `Matter ${n}`,
        body: 'Hello',
      })
    g.add({
      id: 'x1',
      threadId: 'tx',
      from: 'Seller <seller@sale.example>',
      to: 'Tessa <tessa@northfield.example>, Relay <relay@reply.example>',
      subject: 'Roof box',
      body: 'Still for sale',
    })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    const a = await assertion()
    const nav = unwrap(await h.space().navigation(a))
    // Four conversations; Dana is one row, and the shared thread is one row, the seller's: the relay never wrote on it.
    const { people } = unwrap(await h.space().people(a))
    const listed = people.filter((p) => p.conversations.some((c) => c.listed))
    expect(nav.views.inbox.count).toBe(listed.length)
    expect(nav.views.inbox.count).toBe(2)
    expect(people.find((p) => p.name === 'Relay')?.conversations.map((c) => c.listed)).toEqual([false])
    expect(
      (await h.request(AGENT, 'GET', '/api/queue')).json.filters.find((f: { id: string }) => f.id === 'inbox').count,
    ).toBe(4)
  })

  test('mail stored as UTF-8 read as Latin-1 reads right in the list line, the message and a search line, without the row being rewritten', async () => {
    const h = harness({}, { mailboxes: [], ai: null })
    // "can’t" and a no-break space, as they were stored: the bytes of the UTF-8 text spelled as windows-1252.
    h.google.mailbox.add({
      id: 'u1',
      threadId: 'tu',
      from: 'Seller <seller@sale.example>',
      subject: 'Roof box',
      body: 'I canâ€™t goÂ now',
    })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    const a = await assertion()
    const person = unwrap(await h.space().people(a)).people[0]
    expect(person?.conversations[0]?.snippet).toBe('I can’t go now')
    const history = unwrap(await h.space().messagesWith(a, { contactId: person?.contactId as string }))
    expect(history.messages[0]?.text).toBe('I can’t go now')
    expect(rows<{ body: string }>(h, 'SELECT body FROM message')[0]?.body).toContain('canâ€™t')
  })

  test('the count is not cut at the screen the lists are, and the menu is one quick read on a store of that size', async () => {
    const h = harness({}, { mailboxes: [], ai: null })
    const g = h.google.mailbox
    const total = 230
    for (let i = 0; i < total; i++)
      g.add({
        id: `c${i}`,
        threadId: `tc${i}`,
        from: `Person ${i} <p${i}@example.com>`,
        subject: `Matter ${i}`,
        body: 'Hello',
      })
    for (let i = 0; i < 12; i++)
      g.add({
        id: `o${i}`,
        threadId: `to${i}`,
        from: `Open ${i} <o${i}@example.com>`,
        subject: `Open ${i}`,
        body: 'Hello',
      })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    for (let i = 0; i < total; i++) g.labelThread(`tc${i}`, { remove: ['INBOX', 'UNREAD'] })
    await hear(h)
    const a = await assertion()
    const started = performance.now()
    const nav = unwrap(await h.space().navigation(a))
    const took = performance.now() - started
    expect(nav.views.closed.count).toBe(total)
    expect(nav.views.inbox.count).toBe(12)
    // A screen of the list is the newest QUEUE_PAGE conversations, so the list holds fewer rows than the menu says: the menu does not stop where the list does.
    expect(unwrap(await h.space().people(a, { include: ['closed'] })).people.length).toBeLessThan(total)
    // One read of the queue's facts and two of the people on them, not a scan of every message per list (a generous bound: it is a guard, not a benchmark).
    expect(took).toBeLessThan(1500)
  })

  test('it names no message, no person’s address, no token and no key: only names and numbers', async () => {
    const h = await menuWorld()
    const text = JSON.stringify(unwrap(await h.space().navigation(await assertion())))
    for (const never of [
      'Quote for the shop',
      'Weekly deals',
      'dana@acme.example',
      'eli@example.com',
      'Thanks, Eli',
      'refresh',
      'secret',
      'token',
    ])
      expect([never, text.includes(never)]).toEqual([never, false])
  })

  test('the menu leaves out an archived Client and offers one made in the space; the archived one’s people stay linked and its page still opens', async () => {
    const h = await menuWorld()
    const a = await assertion()
    expect(unwrap(await h.space().navigation(a)).clients.map((c) => c.id)).toEqual([1, 2])
    const made = h.directory.make('Made Here')
    h.directory.archive(1)
    const nav = unwrap(await h.space().navigation(a))
    expect(nav.clients.map((c) => [c.id, c.name])).toEqual([
      [2, 'Bolt Machines'],
      [made, 'Made Here'],
    ])
    const page = unwrap(await h.space().client(a, 1))
    expect(page.client).toMatchObject({ id: 1, archived: true, contacts: 1 })
    expect(unwrap(await h.space().clients(a)).clients.find((c) => c.id === 1)).toMatchObject({
      archived: true,
      contacts: 1,
    })
  })

  test('with the Clients part down the Clients are shown by number, as the inbox shows them, and the counts still come', async () => {
    const h = await menuWorld()
    h.directory.failure = new Error('down')
    const nav = unwrap(await h.space().navigation(await assertion()))
    expect(nav.clients).toEqual([expect.objectContaining({ id: 1, name: 'Client 1', listed: false, count: 1 })])
    expect(nav.views.inbox.count).toBeGreaterThan(0)
  })

  test('a store with nothing in it is zeros, no mailboxes and no Gmail accounts, not a failure', async () => {
    const h = harness({}, { mailboxes: [] })
    const nav = unwrap(await h.space().navigation(await assertion()))
    expect(nav).toMatchObject({ mailboxes: [], contacts: 0, gmailAccounts: [] })
    expect(nav.views.inbox).toEqual({ count: 0, unread: 0 })
  })
})

describe('a person’s suggested Client, for the dashed pill', () => {
  async function world() {
    const h = harness()
    const g = h.google.mailbox
    g.add({ id: 'm1', threadId: 't1', from: 'Dana Smith <dana@acme.example>', subject: 'Quote', body: 'Hello' })
    g.add({ id: 'm2', threadId: 't2', from: 'Owen Acme <owner@acme.example>', subject: 'Invoice', body: 'Hello' })
    g.add({ id: 'm3', threadId: 't3', from: 'Eve Other <eve@elsewhere.example>', subject: 'Hi', body: 'Hello' })
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    const idOf = (address: string) =>
      (
        rows<{ contact_id: string }>(h, `SELECT contact_id FROM identity WHERE address = '${address}'`)[0] as {
          contact_id: string
        }
      ).contact_id
    return { h, dana: idOf('dana@acme.example'), owen: idOf('owner@acme.example') }
  }
  const byName = (people: { name: string }[], name: string) =>
    people.find((p) => p.name === name) as unknown as { client: unknown; suggestedClient?: unknown }

  test('a contact with none linked is suggested the Client the inbox itself would suggest, and a linked one has the Client and no suggestion', async () => {
    const { h, dana } = await world()
    const a = await assertion()
    let people = unwrap(await h.space().people(a)).people
    // Owen signs in as Acme does; nobody is linked yet, so Dana has no suggestion by domain.
    expect(byName(people, 'Owen Acme')).toMatchObject({
      client: null,
      suggestedClient: { id: 1, name: 'Acme Legal', listed: true },
    })
    expect(byName(people, 'Dana Smith')).toMatchObject({ client: null, suggestedClient: null })
    expect(byName(people, 'Eve Other')).toMatchObject({ client: null, suggestedClient: null })
    unwrap(await h.space().linkClient(a, dana, ACME.id))
    people = unwrap(await h.space().people(a)).people
    expect(byName(people, 'Dana Smith')).toMatchObject({ client: { id: 1, name: 'Acme Legal' }, suggestedClient: null })
  })

  test('with the site’s Client list down there is nothing to vouch for a Client: no suggestion, and the list still answers', async () => {
    const { h } = await world()
    h.directory.failure = new Error('down')
    const people = unwrap(await h.space().people(await assertion())).people
    expect(people.length).toBe(3)
    for (const p of people)
      expect([p.name, (p as { suggestedClient?: unknown }).suggestedClient]).toEqual([p.name, null])
  })

  test('a suggestion is display only: the inbox links nothing, and the person is not among the Client’s people', async () => {
    const { h, owen } = await world()
    const a = await assertion()
    unwrap(await h.space().people(a))
    expect((await h.request(AGENT, 'GET', `/api/contacts/${owen}`)).json.client).toBeNull()
    expect(unwrap(await h.space().client(a, ACME.id)).contacts).toEqual([])
  })
})

describe('Claude’s sending switch is Tessa’s to flip', () => {
  test('it starts off; Tessa turns it on and off through the space, each audited with his address, and Claude cannot', async () => {
    const h = harness()
    const a = await assertion()
    expect(unwrap(await h.space().claudeSending(a))).toEqual({ enabled: false, changedAt: null })
    const on = unwrap(await h.space().setClaudeSending(a, true))
    expect(on).toEqual({ enabled: true, changedAt: T0 })
    expect((await h.request(AGENT, 'GET', '/api/settings/claude-sending')).json.enabled).toBe(true)
    h.tick()
    expect(unwrap(await h.space().setClaudeSending(a, false)).enabled).toBe(false)
    expect(
      rows<{ actor: string; action: string }>(
        h,
        `SELECT actor, action FROM audit WHERE action = 'setting.claude-sending'`,
      ),
    ).toEqual([
      { actor: 'tessa@northfield.example', action: 'setting.claude-sending' },
      { actor: 'tessa@northfield.example', action: 'setting.claude-sending' },
    ])
    // Claude's door has no route for the switch at all (it is the space's alone), and the store refuses an agent as the actor besides.
    expect((await h.request(AGENT, 'PUT', '/api/settings/claude-sending', { enabled: true })).status).toBe(404)
    expect(await h.store.call('setClaudeSending', true, 'agent:abc123.access')).toMatchObject({
      ok: false,
      status: 403,
    })
    expect((await h.request(AGENT, 'GET', '/api/settings/claude-sending')).json.enabled).toBe(false)
  })

  test('only a yes or a no: anything else is refused and the switch is where it was', async () => {
    const h = harness()
    const a = await assertion()
    for (const bad of [undefined, null, 'true', 1, {}]) {
      expect(await h.space().setClaudeSending(a, bad as never)).toMatchObject({ ok: false, reason: 'bad-request' })
    }
    expect(unwrap(await h.space().claudeSending(a)).enabled).toBe(false)
  })
})

describe('the mailboxes, the spam check and the Gmail connection', () => {
  test('Gmail’s state and each business mailbox with its spam check, and no token anywhere in the answer', async () => {
    const { h } = await withRidgeway()
    await live(h)
    const got = unwrap(await h.space().mailboxes(await assertion()))
    expect(got.gmailAccounts).toMatchObject([
      { address: 'tessa@northfield.example', name: 'northfield', connected: true },
    ])
    expect(got.mailboxes.map((m) => [m.name, m.address, m.spamCheck.enabled])).toEqual([
      ['Ridgeway Cycles', 'info@ridgewaycycles.example', true],
    ])
    expect(got.assistantKey).toBe(true)
    expect(JSON.stringify(got)).not.toMatch(/refresh|token|secret/i)
  })

  test('Tessa switches the spam check off and on; an unknown mailbox is not-found; a Gmail mailbox has none', async () => {
    const { h, mailboxId } = await withRidgeway()
    const a = await assertion()
    expect(unwrap(await h.space().setSpamCheck(a, mailboxId, false))).toMatchObject({
      enabled: false,
      changedBy: 'tessa@northfield.example',
    })
    expect(
      unwrap((await h.space().mailboxes(a)) as never) as { mailboxes: { spamCheck: { enabled: boolean } }[] },
    ).toMatchObject({ mailboxes: [{ spamCheck: { enabled: false } }] })
    expect(unwrap(await h.space().setSpamCheck(a, mailboxId, true)).enabled).toBe(true)
    expect(await h.space().setSpamCheck(a, 'no-such-mailbox', true)).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await h.space().setSpamCheck(a, mailboxId, 'yes' as never)).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    expect(await h.space().setSpamCheck(a, '../x', true)).toMatchObject({ ok: false, reason: 'not-found' })
  })

  test('Gmail can be asked what changed, or disconnected (which says whether Google withdrew the permission); with none connected both are refused', async () => {
    const h = harness()
    const a = await assertion()
    expect(await h.space().changeGmail(a, 'sync')).toMatchObject({ ok: false, reason: 'conflict' })
    await live(h)
    const id = unwrap(await h.space().mailboxes(a)).gmailAccounts[0]?.id as string
    expect(unwrap(await h.space().changeGmail(a, 'sync'))).toEqual({ change: 'sync', revoked: null })
    expect(unwrap(await h.space().changeGmail(a, 'sync', id))).toEqual({ change: 'sync', revoked: null })
    expect(await h.space().changeGmail(a, 'disconnect')).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await h.space().changeGmail(a, 'disconnect', 'no-such-account')).toMatchObject({
      ok: false,
      reason: 'not-found',
    })
    expect(unwrap(await h.space().changeGmail(a, 'disconnect', id))).toEqual({ change: 'disconnect', revoked: true })
    expect(unwrap(await h.space().mailboxes(a)).gmailAccounts).toMatchObject([{ connected: false }])
    expect(await h.space().changeGmail(a, 'wipe' as never)).toMatchObject({ ok: false, reason: 'bad-request' })
  })
})

describe('notifications: the inbox’s sender serves the space’s devices', () => {
  /** Turn them on from the SPACE's page. */
  async function spaceDevice(h: H, device: TestDevice, ua = PIXEL_UA) {
    return unwrap(await h.space().addDevice(await assertion(), { endpoint: device.endpoint, keys: device.keys }, ua))
  }
  const read = async (h: H, device: TestDevice) =>
    Promise.all(h.pushService.to(device.endpoint).map(async (r) => JSON.parse((await decrypt(device, r.body)).text)))
  const mail = (h: H, id: string, from: string, subject: string) =>
    h.google.mailbox.add({ id, threadId: `t-${id}`, from, subject, body: 'The body never travels.' })

  test('the space reads the key and every device, every one the space’s, and never a key of a device', async () => {
    const h = harness()
    const [mac, fresh] = [await newDevice(), await newDevice()]
    await spaceDevice(h, mac, MAC_UA)
    const added = await spaceDevice(h, fresh)
    expect(added).toMatchObject({
      label: 'Chrome on Android',
      origin: 'space',
      endpoint: fresh.endpoint,
      delivered: 0,
      refused: false,
    })
    const got = unwrap(await h.space().notifications(await assertion()))
    expect(got.publicKey).toMatch(/^B/)
    expect(got.devices.map((d) => [d.label, d.origin])).toEqual([
      ['Chrome on macOS', 'space'],
      ['Chrome on Android', 'space'],
    ])
    expect(got.week).toEqual({ sent: 0, dropped: 0 })
    const text = JSON.stringify(got)
    expect(text).not.toContain(fresh.keys.p256dh)
    expect(text).not.toContain(fresh.keys.auth)
    // Nothing is kept about where a device was turned on: the kind of device the inbox's own installed app was is gone.
    expect(rows(h, `SELECT key FROM setting WHERE key LIKE 'device-origin:%'`)).toHaveLength(0)
  })

  test('with no key on the Worker nothing can be turned on or sent, and the space is told so rather than failed', async () => {
    const h = harness({}, { vapid: null })
    const a = await assertion()
    expect(unwrap(await h.space().notifications(a))).toEqual({
      publicKey: null,
      devices: [],
      week: { sent: 0, dropped: 0 },
    })
    const device = await newDevice()
    expect(await h.space().addDevice(a, { endpoint: device.endpoint, keys: device.keys }, PIXEL_UA)).toMatchObject({
      ok: false,
    })
    expect(count(h, 'device')).toBe(0)
  })

  test('a device the inbox would not send to, or with keys that are not a browser’s, is refused and not kept', async () => {
    const h = harness()
    const a = await assertion()
    const good = await newDevice()
    for (const bad of [
      { endpoint: 'https://evil.example/push', keys: good.keys },
      { endpoint: 'http://fcm.googleapis.com/fcm/send/x', keys: good.keys },
      { endpoint: good.endpoint, keys: { p256dh: 'nope', auth: 'nope' } },
      { endpoint: good.endpoint },
      'a string',
      null,
    ]) {
      expect(await h.space().addDevice(a, bad as never, PIXEL_UA)).toMatchObject({ ok: false, reason: 'bad-request' })
    }
    expect(
      await h.space().addDevice(a, { endpoint: good.endpoint, keys: good.keys }, { long: 1 } as never),
    ).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(count(h, 'device')).toBe(0)
  })

  test('EVERY DEVICE GETS THE NOTIFICATION, carrying who wrote so its tap opens that conversation in the space', async () => {
    const h = harness()
    await live(h)
    const [phone, mac] = [await newDevice(), await newDevice()]
    await spaceDevice(h, phone)
    await spaceDevice(h, mac, MAC_UA)

    mail(h, 'm1', 'Marta Vidal <Marta@Tamarackprint.test>', 'Re: Changes to the site')
    await hear(h)

    const [forPhone] = await read(h, phone)
    const [forMac] = await read(h, mac)
    expect(h.pushService.to(phone.endpoint)).toHaveLength(1)
    expect(h.pushService.to(mac.endpoint)).toHaveLength(1)
    // The sender's address in the one spelling the space opens a conversation by.
    expect(forPhone).toEqual({
      v: 1,
      kind: 'message',
      conversationId: expect.any(String),
      person: 'marta@tamarackprint.test',
      messageId: expect.any(String),
      title: 'Marta Vidal',
      body: 'Re: Changes to the site',
      at: expect.any(String),
    })
    expect(forMac).toEqual(forPhone)
    // And it is sent once: the message is marked sent after both.
    await hear(h)
    expect(h.pushService.requests).toHaveLength(2)
  })

  test('more than three at once are ONE notification for each device, opening the list in the space', async () => {
    const h = harness()
    await live(h)
    const [phone, mac] = [await newDevice(), await newDevice()]
    await spaceDevice(h, phone)
    await spaceDevice(h, mac, MAC_UA)
    for (const n of [1, 2, 3, 4]) mail(h, `m${n}`, `Person ${n} <p${n}@example.net>`, `Subject ${n}`)
    await hear(h)
    const [forPhone, forMac] = [await read(h, phone), await read(h, mac)]
    expect(forPhone).toHaveLength(1)
    expect(forMac).toHaveLength(1)
    expect(forMac[0]).toEqual(forPhone[0])
    expect(forMac[0]).toMatchObject({ kind: 'summary', conversationId: null, title: '4 new messages' })
    expect(forMac[0]).not.toHaveProperty('person')
  })

  test('mail that arrives through a business mailbox notifies the space’s device with its sender too', async () => {
    const h = harness({}, { mailboxes: [RIDGEWAY_ASSISTED], ai: null })
    const device = await newDevice()
    await spaceDevice(h, device)
    await h.deliver(rawMail('first'))
    const [payload] = await read(h, device)
    expect(payload).toMatchObject({ kind: 'message', person: 'tessa@northfield.example' })
    expect(payload.title).toContain('Ridgeway')
  })

  test('the test notification goes to the device named, saying it is the space’s', async () => {
    const h = harness()
    const [phone, mac] = [await newDevice(), await newDevice()]
    const first = await spaceDevice(h, phone)
    const second = await spaceDevice(h, mac, MAC_UA)
    const a = await assertion()
    expect(unwrap(await h.space().testDevice(a, first.id))).toEqual({ outcome: 'delivered', status: 201 })
    expect(h.pushService.to(mac.endpoint)).toEqual([])
    expect(unwrap(await h.space().testDevice(a, second.id))).toEqual({ outcome: 'delivered', status: 201 })
    expect((await read(h, phone))[0]).toMatchObject({
      kind: 'test',
      title: 'Northfield Works Space',
      conversationId: null,
    })
    expect((await read(h, mac))[0]).toMatchObject({
      kind: 'test',
      title: 'Northfield Works Space',
      conversationId: null,
    })
    expect(await h.space().testDevice(a, 'nope')).toMatchObject({ ok: false, reason: 'not-found' })
  })

  test('Tessa removes a device from the space, and the other keeps being notified', async () => {
    const h = harness()
    await live(h)
    const [oldPhone, newPhone] = [await newDevice(), await newDevice()]
    const old = await spaceDevice(h, oldPhone)
    await spaceDevice(h, newPhone)
    const a = await assertion()
    expect(unwrap(await h.space().removeDevice(a, old.id))).toEqual({ id: old.id })
    expect(await h.space().removeDevice(a, old.id)).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await h.space().removeDevice(a, '../etc')).toMatchObject({ ok: false, reason: 'not-found' })
    mail(h, 'm1', 'Dana Smith <dana@example.com>', 'Quote')
    await hear(h)
    expect(h.pushService.to(oldPhone.endpoint)).toEqual([])
    expect(h.pushService.to(newPhone.endpoint)).toHaveLength(1)
  })

  test('a device turned on again from the same browser is one device, and one the push service says is gone is removed', async () => {
    const h = harness()
    const device = await newDevice('same')
    const first = await spaceDevice(h, device)
    const again = await spaceDevice(h, device)
    expect(again.id).toBe(first.id)
    expect(unwrap(await h.space().notifications(await assertion())).devices).toHaveLength(1)

    const gone = await newDevice('gone')
    await spaceDevice(h, gone)
    h.pushService.answer(gone.endpoint, 410)
    const a = await assertion()
    const id = unwrap(await h.space().notifications(a)).devices.find((d) => d.endpoint === gone.endpoint)?.id as string
    unwrap(await h.space().testDevice(a, id))
    expect(unwrap(await h.space().notifications(a)).devices.map((d) => d.endpoint)).toEqual([device.endpoint])
  })
})

describe('restore asks before it acts', () => {
  function withHistory() {
    const h = harness()
    h.objectStorage.kv.set('row', 'before')
    const earlier = h.objectStorage.mark()
    h.tick(60 * 60_000)
    h.objectStorage.kv.set('row', 'after')
    return { h, earlier }
  }

  test('the report is the bookmark now and the latest records, and changes nothing', async () => {
    const { h } = withHistory()
    const got = unwrap(await h.space().restoreReport(await assertion()))
    expect(got.current).toMatch(/fakebookmark$/)
    expect(got.restores).toEqual([])
    expect(h.objectStorage.armings).toEqual([])
    expect(h.objectStorage.kv.get('row')).toBe('after')
  })

  test('step one only prepares: it answers a token and what would be restored, and the store is as it was', async () => {
    const { h, earlier } = withHistory()
    const plan = unwrap(await h.space().prepareRestore(await assertion(), { bookmark: earlier }))
    expect(plan).toMatchObject({ target: earlier, targetTime: null })
    expect(plan.token).toMatch(/^token-/)
    expect(h.objectStorage.armings).toEqual([])
    expect(h.objectStorage.restarts).toBe(0)
    expect(h.objectStorage.kv.get('row')).toBe('after')
  })

  test('step two needs the token AND the bookmark it named; a wrong one, none, or an expired one restores nothing', async () => {
    const { h, earlier } = withHistory()
    const a = await assertion()
    const plan = unwrap(await h.space().prepareRestore(a, { bookmark: earlier }))
    expect(await h.space().confirmRestore(a, { token: plan.token, bookmark: 'some-other-bookmark' })).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    expect(await h.space().confirmRestore(a, { token: 'nope', bookmark: earlier })).toMatchObject({
      ok: false,
      reason: 'conflict',
    })
    expect(await h.space().confirmRestore(a, { bookmark: earlier } as never)).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    expect(await h.space().confirmRestore(a, undefined as never)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(h.objectStorage.armings).toEqual([])
    h.tick(CONFIRM_WINDOW_MS + 1000)
    expect(await h.space().confirmRestore(a, { token: plan.token, bookmark: earlier })).toMatchObject({
      ok: false,
      reason: 'conflict',
    })
    expect(h.objectStorage.armings).toEqual([])
    expect(h.objectStorage.restarts).toBe(0)
    expect(h.objectStorage.kv.get('row')).toBe('after')
  })

  test('a time or a bookmark, and not both, not neither, and not something else', async () => {
    const { h, earlier } = withHistory()
    const a = await assertion()
    for (const bad of [
      {},
      { bookmark: earlier, time: '2026-10-20T12:30:00Z' },
      { bookmark: 42 },
      { time: 42 },
      'x',
      null,
      { bookmark: 'drop table; --' },
    ]) {
      expect(await h.space().prepareRestore(a, bad as never)).toMatchObject({ ok: false, reason: 'bad-request' })
    }
    expect(h.objectStorage.armings).toEqual([])
  })

  test('with the token and the bookmark it restores once, restarts the object, and answers the bookmark that undoes it', async () => {
    const { h, earlier } = withHistory()
    const a = await assertion()
    const plan = unwrap(await h.space().prepareRestore(a, { bookmark: earlier }))
    const done = unwrap(await h.space().confirmRestore(a, { token: plan.token, bookmark: earlier }))
    expect(done).toMatchObject({ restoredTo: earlier })
    expect(done.undoBookmark).not.toBe(earlier)
    expect(h.objectStorage.armings).toEqual([earlier])
    expect(h.objectStorage.restarts).toBe(1)
    expect(h.objectStorage.kv.get('row')).toBe('before')
    // The token is spent.
    expect(await h.space().confirmRestore(a, { token: plan.token, bookmark: earlier })).toMatchObject({
      ok: false,
      reason: 'conflict',
    })
    expect(h.objectStorage.armings).toEqual([earlier])
  })
})

describe('Clients', () => {
  async function withPeople() {
    const h = harness()
    await live(h)
    h.google.mailbox.add({
      id: 'm1',
      threadId: 't1',
      from: 'Dana Smith <dana@acme.example>',
      subject: 'Quote',
      body: 'Hello',
    })
    h.google.mailbox.add({
      id: 'm2',
      threadId: 't2',
      from: 'Owen Acme <owner@acme.example>',
      subject: 'Invoice',
      body: 'Hello',
    })
    await hear(h)
    const idOf = (address: string) =>
      (
        rows<{ contact_id: string }>(h, `SELECT contact_id FROM identity WHERE address = '${address}'`)[0] as {
          contact_id: string
        }
      ).contact_id
    return { h, dana: idOf('dana@acme.example'), owen: idOf('owner@acme.example') }
  }

  test('the Clients the site lists, with how many of their people and conversations the inbox holds; a failed list is said, not hidden', async () => {
    const { h, dana } = await withPeople()
    const a = await assertion()
    unwrap(await h.space().linkClient(a, dana, ACME.id))
    const got = unwrap(await h.space().clients(a))
    expect(got.directory).toEqual({ available: true, error: null })
    expect(got.clients.map((c) => [c.name, c.contacts, c.conversations, c.open, c.listed])).toEqual([
      ['Acme Legal', 1, 1, 1, true],
      ['Bolt Machines', 0, 0, 0, true],
    ])
    expect(got.clients[0]).toMatchObject({
      legalEntity: 'Acme Legal LLP',
      adminUrl: expect.stringContaining('client-1'),
    })
    h.directory.failure = new Error('down')
    const down = unwrap(await h.space().clients(a))
    expect(down.directory.available).toBe(false)
    expect(down.clients.map((c) => [c.name, c.listed])).toEqual([['Client 1', false]])
  })

  test('a Client’s page: their people with addresses, and the people the inbox suggests, counted for nothing until linked', async () => {
    const { h, dana, owen } = await withPeople()
    const a = await assertion()
    unwrap(await h.space().linkClient(a, dana, ACME.id))
    const page = unwrap(await h.space().client(a, ACME.id))
    expect(page.client).toMatchObject({ id: 1, name: 'Acme Legal', contacts: 1 })
    expect(page.contacts).toEqual([{ contactId: dana, name: 'Dana Smith', addresses: ['dana@acme.example'] }])
    // Owen signs in as the Client does, so he is suggested, and is not yet one of their people.
    expect(page.suggestions).toEqual([
      {
        contactId: owen,
        name: 'Owen Acme',
        addresses: ['owner@acme.example'],
        reason: 'address',
        via: 'owner@acme.example',
      },
    ])
    expect(page.contacts.map((c) => c.contactId)).not.toContain(owen)
    expect(await h.space().client(a, 999)).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await h.space().client(a, -1)).toMatchObject({ ok: false, reason: 'not-found' })
  })

  test('linking a person to a Client, and taking them out; a Client the site does not list, or a list that does not answer, assigns nothing', async () => {
    const { h, dana } = await withPeople()
    const a = await assertion()
    expect(unwrap(await h.space().linkClient(a, dana, ACME.id))).toEqual({ contactId: dana, clientId: ACME.id })
    expect(await h.space().linkClient(a, dana, 99)).toMatchObject({ ok: false, reason: 'bad-request' })
    h.directory.failure = new Error('down')
    expect(await h.space().linkClient(a, dana, 2)).toMatchObject({ ok: false, reason: 'conflict' })
    h.directory.failure = null
    expect(unwrap(await h.space().client(a, ACME.id)).contacts).toHaveLength(1)
    // Taking out needs no answer from the site.
    h.directory.failure = new Error('down')
    expect(unwrap(await h.space().linkClient(a, dana, null))).toEqual({ contactId: dana, clientId: null })
    expect(await h.space().linkClient(a, 'no-such-contact', null)).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await h.space().linkClient(a, dana, 'one' as never)).toMatchObject({ ok: false, reason: 'bad-request' })
  })

  test('linking is checked against the part and never waits on a Client’s source: one the source stopped listing is still linkable, an archived one is refused with a sentence, and a Client made in the space shows no admin address', async () => {
    const { h, dana, owen } = await withPeople()
    const a = await assertion()
    h.directory.send([ACME])
    expect(unwrap(await h.space().linkClient(a, dana, 2))).toEqual({ contactId: dana, clientId: 2 })
    const made = h.directory.make('Made Here', 'Made Here LLC')
    expect(unwrap(await h.space().linkClient(a, owen, made))).toEqual({ contactId: owen, clientId: made })
    const list = unwrap(await h.space().clients(a)).clients
    expect(list.find((c) => c.id === made)).toMatchObject({
      name: 'Made Here',
      legalEntity: 'Made Here LLC',
      adminUrl: null,
      archived: false,
      contacts: 1,
    })
    expect(list.find((c) => c.id === 1)?.adminUrl).toContain('client-1')
    h.directory.archive(1)
    const refused = await h.space().linkClient(a, dana, 1)
    expect(refused).toMatchObject({ ok: false, reason: 'bad-request', message: expect.stringContaining('archived') })
    expect(unwrap(await h.space().client(a, 1)).contacts).toHaveLength(0)
  })

  test('the address that suggests a person is the one under the key the declaration names in the source’s own fields: a Client made in the space is suggested by domain only', async () => {
    const { h, dana, owen } = await withPeople()
    const a = await assertion()
    const made = h.directory.make('Made Here')
    unwrap(await h.space().linkClient(a, dana, made))
    // Owen signs in as Acme does, so the source's field suggests Acme by his address. Dana, at Owen's domain, is now Made Here's person, so Made Here is suggested for him by domain: never by a sign-in address.
    expect(unwrap(await h.space().client(a, ACME.id)).suggestions.map((s) => [s.contactId, s.reason])).toEqual([
      [owen, 'address'],
    ])
    expect(unwrap(await h.space().client(a, made)).suggestions.map((s) => [s.contactId, s.reason])).toEqual([
      [owen, 'domain'],
    ])
  })
})

describe('the draft chat', () => {
  async function withDraft() {
    const h = harness({}, { mailboxes: [RIDGEWAY_ASSISTED], ai: null })
    await h.deliver(rawMail('first'))
    const conversationId = (rows<{ id: string }>(h, `SELECT id FROM conversation`)[0] as { id: string }).id
    const made = h.inbox.createDraft(
      {
        conversationId,
        address: 'tessa@northfield.example',
        name: 'Tessa Marlow',
        subject: 'Re: Hours question',
        body: 'Hi Tessa,\n\nWe are open Saturdays 9 to 1.\n\nTessa',
        why: 'Answered.',
      },
      'assistant',
    )
    expect(made.ok).toBe(true)
    const draft = (made as { value: { id: string; rev: number } }).value
    return { h, conversationId, draftId: draft.id, rev: draft.rev }
  }

  test('a turn revises the draft at the next revision and keeps the turn beside it; nothing is sent', async () => {
    const { h, conversationId, draftId, rev } = await withDraft()
    const a = await assertion()
    h.model?.next(modelReply('Cut it to the answer.', 'Saturdays 9 to 1.\n\nTessa'))
    const got = unwrap(await h.space().chat(a, { conversationId, draftId, rev, instruction: 'shorter' }))
    expect(got).toMatchObject({ draftId, rev: rev + 1, text: 'Saturdays 9 to 1.\n\nTessa' })
    expect(got.turn).toMatchObject({ instruction: 'shorter', note: 'Cut it to the answer.', revised: true })
    expect(unwrap(await h.space().draftChat(a, conversationId, draftId)).map((t) => t.instruction)).toEqual(['shorter'])
    expect(h.email.handed).toHaveLength(0)
    expect(h.google.mailbox.sent).toHaveLength(0)
  })

  test('a second press over the revision he was shown is refused as a conflict, not a second revision', async () => {
    const { h, conversationId, draftId, rev } = await withDraft()
    const a = await assertion()
    h.model?.next(modelReply('Done.', 'Saturdays 9 to 1.\n\nTessa'))
    unwrap(await h.space().chat(a, { conversationId, draftId, rev, instruction: 'shorter' }))
    const again = await h.space().chat(a, { conversationId, draftId, rev, instruction: 'shorter' })
    expect(again).toMatchObject({ ok: false, reason: 'conflict' })
    expect(h.model?.requests).toHaveLength(1)
  })

  test('it names a draft, at a revision, with words; anything else is refused before the model is asked', async () => {
    const { h, conversationId, draftId, rev } = await withDraft()
    const a = await assertion()
    for (const bad of [
      { conversationId, draftId, rev, instruction: '' },
      { conversationId, draftId, rev: 'one', instruction: 'x' },
      { conversationId, draftId, instruction: 'x' },
      { conversationId, rev, instruction: 'x' },
      { draftId, rev, instruction: 'x' },
      null,
      'x',
    ]) {
      const got = await h.space().chat(a, bad as never)
      expect([JSON.stringify(bad), got.ok]).toEqual([JSON.stringify(bad), false])
    }
    expect(await h.space().chat(a, { conversationId, draftId: 'no-such', rev, instruction: 'x' })).toMatchObject({
      ok: false,
    })
    expect(h.model?.requests).toHaveLength(0)
    expect(await h.space().draftChat(a, conversationId, 'no-such')).toMatchObject({ ok: false, reason: 'not-found' })
  })

  test('with no key for the assistant the turn fails as a fault with its words, and the draft is as it was', async () => {
    const h = harness({}, { mailboxes: [RIDGEWAY_ASSISTED], ai: null, model: null })
    await h.deliver(rawMail('first'))
    const conversationId = (rows<{ id: string }>(h, `SELECT id FROM conversation`)[0] as { id: string }).id
    const made = h.inbox.createDraft(
      { conversationId, address: 'tessa@northfield.example', name: 'J', subject: 'Re: x', body: 'Hello', why: 'x' },
      'assistant',
    )
    const draft = (made as { value: { id: string; rev: number } }).value
    const got = await h
      .space()
      .chat(await assertion(), { conversationId, draftId: draft.id, rev: draft.rev, instruction: 'shorter' })
    expect(got).toMatchObject({ ok: false, kind: 'failed', reason: 'broken' })
    expect((got as { message: string }).message).toContain('no key')
  })
})
