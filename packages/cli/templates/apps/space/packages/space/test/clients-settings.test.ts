// Settings › Clients through the real router: the REAL Clients part over a real SQLite (the very store the inbox is handed) and the REAL inbox over its real store, put
// together by the Worker. What is asserted is what Tessa sees and what a press does: the list with the people under each Client, a Client's page with its source's part and whether its names still follow the source,
// New, Edit (over an out-of-date screen it is refused, and nothing is lost), Archive and Put back, and that a Client archived leaves the menu and the pickers while its people stay linked. The part's own rules are proven in
// packages/clients/test; the screens' look is clients-screens-dom.test.tsx.
import { describe, expect, test } from 'bun:test'
import { ACME, BOLT, TestClients } from '@space/inbox/test-support/clients-part'
import { harness } from '@space/inbox/test-support/harness'
import { T0, northfield } from '../../workspace/test/helpers'
import { repairFormsNames } from '../src/clients-forms'
import { type ClientScreen, type ClientsScreen, fieldValues, humanise } from '../src/clients-settings'
import { type StandInFormsNames, standInFormsNames } from '../src/stand-in-forms-names'
import type { ViewAnswer } from '../src/views'
import { NORTHFIELD_TEAM, world } from './world'

const ORIGIN = 'https://space.northfield.example'
const JSON_POST = { origin: ORIGIN, 'content-type': 'application/json' }

/** The Worker with the real inbox and the real Clients part in it; Dana (acme.example) and Owen (who signs in as Acme does) have written, and nobody is linked yet. */
async function asOwner(options: { rows?: ConstructorParameters<typeof TestClients>[0]; noClients?: boolean; forms?: StandInFormsNames } = {}) {
  const h = harness({}, { mailboxes: [], ai: null })
  const part = new TestClients(options.rows ?? [ACME, BOLT])
  // The inbox's harness reads its own copy of the part; hand it this one, which the space's face also writes through.
  const g = h.google.mailbox
  g.add({ id: 'm1', threadId: 't1', from: 'Dana Smith <dana@acme.example>', subject: 'Quote', body: 'Hello' })
  g.add({ id: 'm2', threadId: 't2', from: 'Owen Acme <owner@acme.example>', subject: 'Invoice', body: 'Hello' })
  g.add({ id: 'm3', threadId: 't3', from: 'Pat Bolt <pat@bolt.example>', subject: 'Parts', body: 'Hello' })
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
  const idOf = (address: string) => (h.db.query(`SELECT contact_id FROM identity WHERE address = '${address}'`).get() as { contact_id: string }).contact_id
  const inbox = h.space({ clients: part })
  const w = await world(northfield(), NORTHFIELD_TEAM, { inbox, parts: { ...(options.noClients ? {} : { clients: part.spaceFace(northfield()) }), ...(options.forms ? { formsNames: options.forms.methods } : {}) } }, undefined, { answerWithinMs: 200, writeWithinMs: 400, now: () => T0 })
  const jwt = await w.signIn('tessa@northfield.example')
  const get = async <T>(path: string): Promise<ViewAnswer<T>> => {
    const res = await w.call(path, { jwt })
    expect([path, res.status]).toEqual([path, 200])
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    return (await res.json()) as ViewAnswer<T>
  }
  const post = async <T>(path: string, body: unknown): Promise<ViewAnswer<T>> => {
    const res = await w.call(path, { method: 'POST', jwt, headers: JSON_POST, body: JSON.stringify(body) })
    expect([path, res.status]).toEqual([path, 200])
    return (await res.json()) as ViewAnswer<T>
  }
  const ok = <T>(answer: ViewAnswer<T>): T => {
    expect(answer, JSON.stringify(answer)).toMatchObject({ result: 'ok' })
    return (answer as { value: T }).value
  }
  const list = async () => ok(await get<ClientsScreen>('/api/clients/list'))
  const page = async (n: number) => ok(await get<ClientScreen>(`/api/clients/one?number=${n}`))
  const link = (address: string, clientId: number | null) => post('/api/inbox/client-link', { contactId: idOf(address), clientId })
  return { h, w, jwt, part, idOf, get, post, ok, list, page, link }
}

describe('a source’s extra fields as label and value pairs', () => {
  const declared = [
    { key: 'plan', label: 'Plan', kind: 'text' as const, list: true },
    { key: 'renewedAt', label: 'Renewed', kind: 'time' as const, list: false },
  ]

  test('a key is made readable', () => {
    expect([humanise('subscriptionStatus'), humanise('plan'), humanise('renewed_at'), humanise('a1B2')]).toEqual(['Subscription status', 'Plan', 'Renewed at', 'A1 b2'])
  })

  test('declared fields come first, in the declaration’s order, under its labels; the rest follow under their readable keys; an empty value is not shown', () => {
    const extra = { zone: 'north', renewedAt: '2026-10-01T00:00:00.000Z', plan: 'gold', seatCount: '4', empty: '' }
    expect(fieldValues(extra, declared)).toEqual([
      { key: 'plan', label: 'Plan', value: 'gold', kind: 'text' },
      { key: 'renewedAt', label: 'Renewed', value: '2026-10-01T00:00:00.000Z', kind: 'time' },
      { key: 'seatCount', label: 'Seat count', value: '4', kind: 'text' },
      { key: 'zone', label: 'Zone', value: 'north', kind: 'text' },
    ])
    expect(fieldValues(extra, declared, true)).toEqual([{ key: 'plan', label: 'Plan', value: 'gold', kind: 'text' }])
    expect(fieldValues(extra, [])).toHaveLength(4)
    expect(fieldValues(extra, [], true)).toEqual([])
  })
})

describe('the list', () => {
  test('every Client the part holds with the people the inbox holds under it, where it came from, and when the source last sent', async () => {
    const s = await asOwner()
    s.ok(await s.link('dana@acme.example', 1))
    const screen = await s.list()
    expect(screen.peopleCounted).toBe(true)
    expect(screen.source).toMatchObject({ name: 'northfield.example', lastPushAt: expect.any(Number), lastSyncAt: expect.any(Number), syncedCount: 2 })
    expect(screen.active.map((c) => [c.number, c.name, c.legalName, c.source, c.contacts, c.followsSource])).toEqual([
      [1, 'Acme Legal', 'Acme Legal LLP', 'northfield.example', 1, true],
      [2, 'Bolt Machines', null, 'northfield.example', 0, true],
    ])
    expect(screen.active[0]).toMatchObject({ conversations: 1, open: 1, fields: [{ key: 'subscriptionStatus', label: 'Subscription', value: 'active', kind: 'text' }] })
    expect(screen.active[1]?.fields).toEqual([])
    expect(screen.archived).toEqual([])
    expect(screen.unlisted).toEqual([])
  })

  test('a Client made here is numbered from 1001, says it was made here, and a Client the source stopped listing is kept and says so', async () => {
    const s = await asOwner()
    const made = s.ok(await s.post<{ number: number }>('/api/clients/make', { name: '  Fischer   Bakery ', legalName: 'Fischer Bakery LLC' }))
    expect(made).toMatchObject({ number: 1001, name: 'Fischer Bakery', legalName: 'Fischer Bakery LLC', source: null })
    s.part.send([ACME])
    const screen = await s.list()
    expect(screen.active.map((c) => [c.number, c.source, c.goneSince !== null])).toEqual([
      [1, 'northfield.example', false],
      [2, 'northfield.example', true],
      [1001, null, false],
    ])
  })

  test('a number only people hold is listed apart, by number, and its page opens', async () => {
    const s = await asOwner()
    s.h.db.query(`UPDATE contact SET client_id = 7 WHERE id = '${s.idOf('pat@bolt.example')}'`).run()
    const screen = await s.list()
    expect(screen.unlisted).toEqual([{ number: 7, name: 'Client 7', contacts: 1, conversations: 1, open: 1 }])
    const p = await s.page(7)
    expect(p).toMatchObject({ number: 7, client: null, name: 'Client 7', names: null, counts: { contacts: 1 } })
    expect(p.contacts.map((c) => c.name)).toEqual(['Pat Bolt'])
  })

  test('with the people not countable, the Clients are still listed, with a sentence', async () => {
    const s = await asOwner()
    const down = await world(northfield(), NORTHFIELD_TEAM, { parts: { clients: s.part.spaceFace(northfield()) } }, undefined, { answerWithinMs: 60, now: () => T0 })
    const jwt = await down.signIn('tessa@northfield.example')
    const res = (await (await down.call('/api/clients/list', { jwt })).json()) as ViewAnswer<ClientsScreen>
    expect(res).toMatchObject({ result: 'ok', value: { peopleCounted: false, peopleError: expect.stringContaining('Email') } })
    expect((res as { value: ClientsScreen }).value.active.map((c) => c.name)).toEqual(['Acme Legal', 'Bolt Machines'])
  })

  test('Clients not being connected is said, and nothing is written', async () => {
    const s = await asOwner({ noClients: true })
    expect(await s.get('/api/clients/list')).toMatchObject({ result: 'unreachable', message: 'Clients is not connected to the space.' })
    expect(await s.post('/api/clients/make', { name: 'X' })).toMatchObject({ result: 'failed' })
  })
})

describe('a Client’s page', () => {
  test('the people linked, the people suggested and not counted, and the source’s part: its fields with the declaration’s labels, and the admin address', async () => {
    const s = await asOwner()
    s.ok(await s.link('dana@acme.example', 1))
    const p = await s.page(1)
    expect(p.client).toMatchObject({ number: 1, name: 'Acme Legal', revision: 1, source: { source: 'northfield.example', externalId: '1' } })
    expect(p).toMatchObject({ adminUrl: 'https://www.northfield.example/admin#client-1', matchLabel: 'Client Portal sign-in', counts: { contacts: 1 } })
    expect(p.fields).toEqual([
      { key: 'signInAddress', label: 'Client Portal sign-in', value: 'owner@acme.example', kind: 'text' },
      { key: 'subscriptionStatus', label: 'Subscription', value: 'active', kind: 'text' },
      { key: 'subscriptionAt', label: 'Subscription said', value: '2026-10-01T00:00:00.000Z', kind: 'time' },
    ])
    expect(p.contacts.map((c) => c.name)).toEqual(['Dana Smith'])
    expect(p.suggestions.map((x) => [x.name, x.reason])).toEqual([['Owen Acme', 'address']])
    expect(p.names).toEqual({ followsName: true, followsLegalName: true, saidName: 'Acme Legal', saidLegalName: 'Acme Legal LLP' })
  })

  test('a Client made here has no source part, no admin address and no fields', async () => {
    const s = await asOwner()
    const made = s.ok(await s.post<{ number: number }>('/api/clients/make', { name: 'Fischer Bakery' }))
    const p = await s.page(made.number)
    expect(p).toMatchObject({ client: { source: null }, names: null, adminUrl: null, fields: [] })
  })

  test('a Client the source no longer lists carries the date, and a number nobody holds is not found', async () => {
    const s = await asOwner()
    s.part.gone(BOLT)
    expect((await s.page(2)).client?.source?.goneSince).toEqual(expect.any(Number))
    expect(await s.get('/api/clients/one?number=999')).toMatchObject({ result: 'refused', reason: 'not-found' })
    for (const q of ['', '?number=0', '?number=x', '?number=1.5']) expect((await s.w.call(`/api/clients/one${q}`, { jwt: s.jwt })).status).toBe(400)
  })
})

describe('whose names win', () => {
  test('a name the source renames follows while it is untouched; once edited here it stands, and the page says what the source calls it', async () => {
    const s = await asOwner()
    s.part.push({ ...ACME, name: 'Acme Legal Group' })
    s.part.push({ ...BOLT, name: 'Bolt Machining' })
    expect((await s.list()).active.map((c) => c.name)).toEqual(['Acme Legal Group', 'Bolt Machining'])
    const shown = (await s.page(1)).client?.revision ?? 0
    const edited = s.ok(await s.post<{ revision: number }>('/api/clients/edit', { number: 1, revision: shown, name: 'Acme (my name)' }))
    expect(edited.revision).toBe(shown + 1)
    s.part.push({ ...ACME, name: 'Acme Legal Holdings' })
    s.part.push({ ...BOLT, name: 'Bolt Works' })
    const screen = await s.list()
    expect(screen.active.map((c) => [c.name, c.followsSource])).toEqual([
      ['Acme (my name)', false],
      ['Bolt Works', true],
    ])
    expect((await s.page(1)).names).toMatchObject({ followsName: false, followsLegalName: true, saidName: 'Acme Legal Holdings' })
    expect((await s.page(2)).names).toMatchObject({ followsName: true, saidName: 'Bolt Works' })
  })
})

describe('New, Edit, Archive and Put back', () => {
  test('New needs a name; the part’s own words come through, and nothing was made', async () => {
    const s = await asOwner()
    expect(await s.post('/api/clients/make', { name: '   ' })).toMatchObject({ result: 'refused', reason: 'bad-request', message: 'A Client needs a name.' })
    expect(await s.post('/api/clients/make', { name: 'x'.repeat(81) })).toMatchObject({ result: 'refused', reason: 'bad-request', message: expect.stringContaining('80') })
    expect((await s.list()).active).toHaveLength(2)
    const res = await s.w.call('/api/clients/make', { method: 'POST', jwt: s.jwt, headers: JSON_POST, body: JSON.stringify({ legalName: 'x' }) })
    expect(res.status).toBe(400)
  })

  test('Edit names the revision the page was shown: over a Client that has moved on it is refused with the Client as it is now, and what was changed stays changed', async () => {
    const s = await asOwner()
    s.ok(await s.post('/api/clients/edit', { number: 2, revision: 1, legalName: 'Bolt Machines Inc.' }))
    const stale = await s.post('/api/clients/edit', { number: 2, revision: 1, name: 'Bolt Co' })
    expect(stale).toMatchObject({ result: 'refused', reason: 'conflict' })
    expect((await s.page(2)).client).toMatchObject({ name: 'Bolt Machines', legalName: 'Bolt Machines Inc.', revision: 2 })
    // A legal name cleared with an empty string; a body that is not the shape is a 400.
    s.ok(await s.post('/api/clients/edit', { number: 2, revision: 2, legalName: '' }))
    expect((await s.page(2)).client?.legalName).toBeNull()
    for (const body of [{}, { number: 2 }, { number: 2, revision: 3 }, { number: 'two', revision: 3, name: 'x' }, { number: 2, revision: 3, name: 5 }]) {
      const res = await s.w.call('/api/clients/edit', { method: 'POST', jwt: s.jwt, headers: JSON_POST, body: JSON.stringify(body) })
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400])
    }
  })

  test('Archive takes a Client out of the menu and the pickers and leaves its people linked; Put back returns it; linking to an archived Client is refused with a sentence', async () => {
    const s = await asOwner()
    s.ok(await s.link('dana@acme.example', 1))
    const nav = async () => ok2(await s.get<{ clients: { id: number }[] }>('/api/inbox/navigation')).clients.map((c) => c.id)
    const ok2 = s.ok
    expect(await nav()).toEqual([1, 2])
    const archived = s.ok(await s.post<{ archivedAt: number | null }>('/api/clients/archive', { number: 1 }))
    expect(archived.archivedAt).toEqual(expect.any(Number))
    expect(await nav()).toEqual([2])
    const screen = await s.list()
    expect(screen.active.map((c) => c.number)).toEqual([2])
    expect(screen.archived).toEqual([expect.objectContaining({ number: 1, contacts: 1, archivedAt: expect.any(Number) })])
    const pickers = ok2(await s.get<{ clients: { id: number; archived: boolean }[] }>('/api/inbox/clients')).clients
    expect(pickers.filter((c) => !c.archived).map((c) => c.id)).toEqual([2])
    expect((await s.page(1)).contacts.map((c) => c.name)).toEqual(['Dana Smith'])
    const refused = await s.link('owner@acme.example', 1)
    expect(refused).toMatchObject({ result: 'refused', reason: 'bad-request', message: expect.stringContaining('archived') })
    const back = s.ok(await s.post<{ archivedAt: number | null }>('/api/clients/put-back', { number: 1 }))
    expect(back.archivedAt).toBeNull()
    expect(await nav()).toEqual([1, 2])
    s.ok(await s.link('owner@acme.example', 1))
    expect((await s.page(1)).counts.contacts).toBe(2)
    expect(await s.post('/api/clients/archive', { number: 99 })).toMatchObject({ result: 'refused', reason: 'not-found' })
  })

  test('a Client made here is linkable at once, and the Inbox menu offers it', async () => {
    const s = await asOwner()
    const made = s.ok(await s.post<{ number: number }>('/api/clients/make', { name: 'Fischer Bakery' }))
    s.ok(await s.link('pat@bolt.example', made.number))
    const nav = s.ok(await s.get<{ clients: { id: number; name: string; count: number }[] }>('/api/inbox/navigation')).clients
    expect(nav.find((c) => c.id === made.number)).toMatchObject({ name: 'Fischer Bakery', count: 1 })
  })

  test('linking works while the source is down: nothing in the path waits on it', async () => {
    const s = await asOwner()
    s.part.gone(ACME)
    s.ok(await s.link('dana@acme.example', 1))
    expect((await s.page(1)).contacts.map((c) => c.name)).toEqual(['Dana Smith'])
  })
})

describe('who may', () => {
  test('without a sign-in, at every path, nothing is read or written', async () => {
    const s = await asOwner()
    const before = s.part.asked
    for (const path of ['/api/clients/list', '/api/clients/one?number=1']) expect((await s.w.call(path)).status).toBe(401)
    for (const path of ['/api/clients/make', '/api/clients/edit', '/api/clients/archive', '/api/clients/put-back']) {
      expect((await s.w.call(path, { method: 'POST', headers: JSON_POST, body: '{}' })).status).toBe(401)
    }
    expect(s.part.asked).toBe(before)
    expect((await s.list()).active).toHaveLength(2)
  })

  test('a write needs this host’s Origin', async () => {
    const s = await asOwner()
    const res = await s.w.call('/api/clients/make', { method: 'POST', jwt: s.jwt, headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ name: 'X' }) })
    expect(res.status).toBe(403)
    expect((await s.list()).active).toHaveLength(2)
  })

  test('another company’s person is refused', async () => {
    const s = await asOwner()
    const stranger = await s.w.signIn('lane@pinecrest.test')
    expect((await s.w.call('/api/clients/list', { jwt: stranger })).status).toBe(403)
    expect((await s.w.call('/api/clients/make', { method: 'POST', jwt: stranger, headers: JSON_POST, body: JSON.stringify({ name: 'X' }) })).status).toBe(403)
  })
})

describe('Forms signs for a Client: the page says so, and the names Forms keeps are written by this part', () => {
  /** Acme (1) is the Client Forms signs for; its row holds Forms' copy of the names. */
  const formsWithAcme = () => standInFormsNames([{ id: 'f0f0f0f0-0000-4000-8000-000000000001', number: 1, name: 'Acme Legal', legalName: 'Acme Legal LLP', replyTo: 'office@acme.example' }])

  test('the page of a Client Forms signs for gives the way into its signing settings; one it does not gives none; without Forms it says Forms cannot be asked', async () => {
    const forms = formsWithAcme()
    const s = await asOwner({ forms })
    expect((await s.page(1)).signing).toEqual({ available: true, settings: { id: 'f0f0f0f0-0000-4000-8000-000000000001', replyTo: 'office@acme.example', copy: null } })
    expect((await s.page(2)).signing).toEqual({ available: true, settings: null })
    forms.script.push('throw')
    expect((await s.page(1)).signing).toEqual({ available: false, settings: null })
  })

  test('without Forms connected the page says Forms cannot be asked', async () => {
    const s = await asOwner()
    expect((await s.page(1)).signing).toEqual({ available: false, settings: null })
  })

  test('an edit writes Forms’ copy of the names in the same request, as the person who edited, and the page then shows the new name', async () => {
    const forms = formsWithAcme()
    const s = await asOwner({ forms })
    s.ok(await s.post('/api/clients/edit', { number: 1, revision: 1, name: 'Acme Law', legalName: 'Acme Law Group LLP' }))
    expect(forms.rows[0]).toMatchObject({ name: 'Acme Law', legalName: 'Acme Law Group LLP' })
    expect(forms.calls.filter((c) => c.method === 'setNames')).toEqual([{ method: 'setNames', args: [1, { name: 'Acme Law', legalName: 'Acme Law Group LLP' }, 'tessa@northfield.example'] }])
    expect((await s.page(1)).client).toMatchObject({ name: 'Acme Law', legalName: 'Acme Law Group LLP' })
  })

  test('clearing the legal name of a Client Forms signs for is refused, with a sentence, and nothing is changed; the same edit is fine for a Client it does not sign for, and a name edited alone is fine', async () => {
    const forms = formsWithAcme()
    const s = await asOwner({ forms })
    for (const legalName of ['', '   ', null]) {
      const refused = await s.post('/api/clients/edit', { number: 1, revision: 1, legalName })
      expect(refused, String(legalName)).toMatchObject({ result: 'refused', reason: 'bad-request' })
      const said = (refused as { message: string }).message
      expect(said).toContain('legal name cannot be cleared')
      expect(said).toContain('Nothing was changed.')
    }
    expect((await s.page(1)).client).toMatchObject({ name: 'Acme Legal', legalName: 'Acme Legal LLP', revision: 1 })
    expect(forms.calls.filter((c) => c.method === 'setNames')).toEqual([])
    s.ok(await s.post('/api/clients/edit', { number: 1, revision: 1, name: 'Acme Law' }))
    s.ok(await s.post('/api/clients/edit', { number: 2, revision: 1, legalName: '' }))
    expect((await s.page(2)).client?.legalName).toBeNull()
  })

  test('the page says when Forms signs under names that are not the Client’s: a name a source pushed that Forms refuses, a legal name a source dropped, and a copy the tick has not written yet', async () => {
    const forms = formsWithAcme()
    const s = await asOwner({ forms })
    expect((await s.page(1)).signing.settings?.copy).toBeNull()

    // The source pushes a name with a comma in it: the Client takes it, Forms cannot send mail under it, and the tick cannot put that right.
    s.part.push({ ...ACME, name: 'Acme, Smith & Co' })
    const refused = (await s.page(1)).signing.settings?.copy
    expect(refused).toMatchObject({ formsName: 'Acme Legal', formsLegalName: 'Acme Legal LLP', clientName: 'Acme, Smith & Co', clientLegalName: 'Acme Legal LLP' })
    expect(refused?.why).toContain('The name may not contain')
    expect(refused?.why).toContain('still signs under the ones it has')
    expect(refused?.todo).toContain('Change the name on this page')

    // The source drops the legal name: Forms keeps the one it had, and the page says so.
    s.part.push({ ...ACME, name: 'Acme Legal', legalEntity: null })
    const dropped = (await s.page(1)).signing.settings?.copy
    expect(dropped).toMatchObject({ formsLegalName: 'Acme Legal LLP', clientLegalName: null })
    expect(dropped?.why).toContain('no legal name now')
    expect(dropped?.todo).toContain('Until then Forms signs under “Acme Legal LLP”')

    // A rename Forms can keep that the tick has not written yet.
    s.part.push({ ...ACME, name: 'Acme Law Offices' })
    const waiting = (await s.page(1)).signing.settings?.copy
    expect(waiting?.why).toBe("Forms has not copied the Client's names yet.")
    expect(waiting?.todo).toContain('within five minutes')
    expect(await repairFormsNames(forms.methods, s.part)).toMatchObject({ fixed: 1 })
    expect((await s.page(1)).signing.settings?.copy).toBeNull()
  })

  test('with the legal name cleared by the Client’s source, the difference stays until it is given back, and the tick neither writes nor complains', async () => {
    const forms = formsWithAcme()
    const s = await asOwner({ forms })
    s.part.push({ ...ACME, legalEntity: null })
    expect(await repairFormsNames(forms.methods, s.part)).toEqual({ checked: 1, fixed: 0, failed: 0 })
    expect(forms.calls.filter((c) => c.method === 'setNames')).toEqual([])
    expect((await s.page(1)).signing.settings?.copy?.clientLegalName).toBeNull()
    const client = (await s.page(1)).client!
    s.ok(await s.post('/api/clients/edit', { number: 1, revision: client.revision, legalName: 'Acme Legal Group LLP' }))
    expect(forms.rows[0]).toMatchObject({ legalName: 'Acme Legal Group LLP' })
    expect((await s.page(1)).signing.settings?.copy).toBeNull()
  })

  test('an edit of a Client Forms does not sign for writes nothing to Forms', async () => {
    const forms = formsWithAcme()
    const s = await asOwner({ forms })
    s.ok(await s.post('/api/clients/edit', { number: 2, revision: 1, name: 'Bolt Co' }))
    expect(forms.calls.filter((c) => c.method !== 'linked')).toEqual([])
    expect(forms.rows).toHaveLength(1)
    expect(forms.rows[0]).toMatchObject({ name: 'Acme Legal' })
  })

  test('a name Forms cannot send mail under is refused before the Client is changed, with a sentence, for a Client Forms signs for; the same name is fine for one it does not', async () => {
    const forms = formsWithAcme()
    const s = await asOwner({ forms })
    const refused = await s.post('/api/clients/edit', { number: 1, revision: 1, name: 'Acme, Smith & Co' })
    expect(refused).toMatchObject({ result: 'refused', reason: 'bad-request' })
    const said = (refused as { message: string }).message
    expect(said).toContain('The name may not contain')
    expect(said).toContain('Forms signs for this Client')
    expect(said).toContain('Nothing was changed.')
    expect((await s.page(1)).client).toMatchObject({ name: 'Acme Legal', revision: 1 })
    expect(forms.calls.filter((c) => c.method === 'setNames')).toEqual([])
    s.ok(await s.post('/api/clients/edit', { number: 2, revision: 1, name: 'Bolt, Nuts & Co' }))
    expect((await s.page(2)).client).toMatchObject({ name: 'Bolt, Nuts & Co' })
  })

  test('Forms not answering does not undo the edit: it is stored, and the copy is put right by the tick', async () => {
    const forms = formsWithAcme()
    const s = await asOwner({ forms })
    forms.script.push('throw')
    forms.script.push('throw')
    s.ok(await s.post('/api/clients/edit', { number: 1, revision: 1, name: 'Acme Law' }))
    expect((await s.page(1)).client).toMatchObject({ name: 'Acme Law' })
    expect(forms.rows[0]).toMatchObject({ name: 'Acme Legal' })
  })

  test('a failed copy after a good edit is the edit’s success, and the copy stays what it was until the tick', async () => {
    const forms = formsWithAcme()
    const s = await asOwner({ forms })
    // The pre-check's two calls pass; the write is what fails.
    const real = forms.methods.setNames
    forms.methods.setNames = async () => {
      throw new Error('Forms is down')
    }
    s.ok(await s.post('/api/clients/edit', { number: 1, revision: 1, legalName: 'Acme Legal Group LLP' }))
    forms.methods.setNames = real
    expect(forms.rows[0]).toMatchObject({ legalName: 'Acme Legal LLP' })
  })
})
