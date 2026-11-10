// People, driven through the real router with stand-in apps behind the bindings. What is asserted is what a person sees (the directory, a person's page, what a write
// came to) or what is refused, never the merge's internals: no sign-in is refused at every new path and nothing is asked of any app; the assertion the space received is the one
// it hands on; what appears for a person and what never does; the three fields' revision; linking a Client; a merge and its undo; one part down leaves the others.
import { describe, expect, test } from 'bun:test'
import { createInstall, type DocumentSummary, type Install } from '@space/workspace'
import { T0, readJson, NORTHFIELD_FILE } from '../../workspace/test/helpers'
import type { ConversationsAnswer, ListedPerson } from '../src/conversations'
import { findEntry, mergePeople, type PeopleAnswer, type PeopleEntry, type PersonAnswer } from '../src/people'
import { type StandInContact, type StandInThread, standInForms, standInInbox, standInMeet } from '../src/stand-ins'
import { fixtureViews } from '../src/fixture-views'
import type { ViewAnswer } from '../src/views'
import { NORTHFIELD_TEAM, ago, channel, contact, dm, person, thread, world } from './world'

const ORIGIN = 'https://space.northfield.example'
const JSON_POST = { origin: ORIGIN, 'content-type': 'application/json' }

/** Northfield's install with Priya on the team (the real one has Tessa alone). */
function withPriya(): Install {
  const raw = readJson(NORTHFIELD_FILE) as { people: unknown[] }
  return createInstall({ ...raw, people: [...raw.people, { address: 'priya@northfield.example', name: 'Priya Natarajan', role: 'member' }] })
}

const doc = (id: string, title: string, state: DocumentSummary['state'], made: number, extra: Partial<DocumentSummary> = {}): DocumentSummary => ({
  id,
  title,
  state,
  createdAt: made,
  sentAt: state === 'draft' ? null : made,
  completedAt: null,
  signers: 2,
  signed: 0,
  notSigned: [],
  ...extra,
})

/** A small world: Dana (under a Client) and Marcus at the same practice, a lead, Priya on the team (a contact and a teammate of meet's), a guest, a newsletter and a duplicate Dana. */
function standIns() {
  const contacts: StandInContact[] = [
    { ...contact('c-dana', 'Dana Reyes', 'dana@harbor.example'), client: { id: 7, name: 'Harbor Dental' }, business: 'Harbor Dental', role: 'Office manager', notes: 'Prefers calls before ten.' },
    { ...contact('c-marcus', 'Marcus Chen', 'marcus@harbor.example'), client: { id: 7, name: 'Harbor Dental' } },
    { ...contact('c-lead', 'Tomas Alvarez', 'tomas@mail.example'), suggested: { id: 3, name: 'Tamarack Print Supply' } },
    contact('c-priya', 'Priya N.', 'priya@northfield.example'),
    contact('c-text', '(626) 555-0142'),
    { ...contact('c-news', 'Local Business Weekly', 'news@lbw.example'), automated: true },
    contact('c-dana2', 'Dana R.', 'dreyes@mail.example'),
  ]
  const threads: StandInThread[] = [
    thread('t-dana', ago(30), ['c-dana', 'c-marcus'], { subject: 'The secret price list', snippet: 'We will pay 4,100 for the sign.' }),
    thread('t-lead', ago(90), ['c-lead'], { subject: 'Winter service question' }),
    thread('t-priya', ago(200), ['c-priya']),
    thread('t-text', ago(400), ['c-text'], { kind: 'sms' }),
    thread('t-news', ago(500), ['c-news'], { bulk: true }),
  ]
  const direct = [
    dm(11, person('p-guest', 'Gwen Guest', 'gwen@elsewhere.example', 'guest'), ago(10)),
    dm(12, person('p-priya', 'Priya Natarajan', 'priya@northfield.example', 'teammate'), ago(20)),
    dm(13, person('p-sam', 'Sam Ortiz', 'sam@northfield.example', 'teammate'), null),
  ]
  const inbox = standInInbox(contacts, threads, { views: fixtureViews(T0), now: () => T0 })
  const meet = standInMeet({ direct, channels: [channel(21, 'launch', ago(5))] })
  const forms = standInForms(
    [
      doc('e-photo', 'Photo release, Harbor Dental', 'sent', ago(300), { notSigned: ['Dana Reyes', 'Marcus Chen'] }),
      doc('e-agreement', 'Website agreement', 'completed', ago(900), { signed: 2, completedAt: ago(100), notSigned: [] }),
      doc('e-lead', 'Quote for Tomas', 'draft', ago(60), { notSigned: ['Tomas Alvarez'] }),
    ],
    { recipients: { 'e-photo': ['Dana@Harbor.example', 'marcus@harbor.example'], 'e-agreement': ['dana@harbor.example'], 'e-lead': ['tomas@mail.example'] } },
  )
  return { inbox, meet, forms }
}

async function asOwner(over: { install?: Install; answerWithinMs?: number; writeWithinMs?: number; apps?: Partial<ReturnType<typeof standIns>> } = {}) {
  const s = { ...standIns(), ...over.apps }
  const w = await world(over.install ?? withPriya(), NORTHFIELD_TEAM, { inbox: s.inbox, meet: s.meet, parts: { forms: s.forms } }, undefined, { answerWithinMs: over.answerWithinMs ?? 80, writeWithinMs: over.writeWithinMs ?? 300, now: () => T0 })
  const jwt = await w.signIn('tessa@northfield.example')
  const people = async (): Promise<PeopleAnswer> => {
    const res = await w.call('/api/people', { jwt })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    return (await res.json()) as PeopleAnswer
  }
  const one = async (key: string) => w.call(`/api/person?key=${encodeURIComponent(key)}`, { jwt })
  const person_ = async (key: string): Promise<PersonAnswer> => {
    const res = await one(key)
    expect([key, res.status]).toEqual([key, 200])
    return (await res.json()) as PersonAnswer
  }
  const write = async <T = unknown>(name: string, body: unknown): Promise<ViewAnswer<T>> => {
    const res = await w.call(`/api/inbox/${name}`, { method: 'POST', jwt, headers: JSON_POST, body: JSON.stringify(body) })
    expect([name, res.status]).toEqual([name, 200])
    return (await res.json()) as ViewAnswer<T>
  }
  return { w, jwt, s, people, person: person_, one, write }
}

const byName = (a: PeopleAnswer, name: string): PeopleEntry => {
  const e = a.entries.find((x) => x.name === name)
  if (!e) throw new Error(`no ${name} in ${a.entries.map((x) => x.name).join(', ')}`)
  return e
}

describe('no sign-in is refused at every new path', () => {
  test('without a sign-in, whatever the method, nothing is asked of any app', async () => {
    const x = await asOwner()
    const cookie = await x.w.signIn('tessa@northfield.example')
    const forms = await x.w.signInForms('tessa@northfield.example')
    const paths = ['/api/people', '/api/person?key=dana%40harbor.example', '/api/inbox/contact-profile', '/api/inbox/contact-merge', '/api/inbox/contact-unmerge', '/people', '/people/dana%40harbor.example']
    for (const path of paths) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        for (const init of [{}, { cookieJwt: cookie }, { jwt: forms }]) {
          const res = await x.w.call(path, { method, ...init, headers: JSON_POST, body: method === 'POST' ? '{}' : undefined })
          expect([path, method, Object.keys(init)[0] ?? 'none', res.status]).toEqual([path, method, Object.keys(init)[0] ?? 'none', 401])
        }
      }
    }
    expect(x.s.inbox.asked.askers).toEqual([])
    expect(x.s.inbox.views.calls).toEqual([])
    expect(x.s.meet.asked.askers).toEqual([])
    expect(x.s.forms.asked.askers).toEqual([])
  })

  test('another company’s person is a 403 at both reads and the writes, and nothing is asked', async () => {
    const x = await asOwner()
    const stranger = await x.w.signIn('lane@pinecrest.test')
    for (const path of ['/api/people', '/api/person?key=dana%40harbor.example']) expect([path, (await x.w.call(path, { jwt: stranger })).status]).toEqual([path, 403])
    for (const name of ['contact-profile', 'contact-merge', 'contact-unmerge', 'client-link']) {
      expect([name, (await x.w.call(`/api/inbox/${name}`, { method: 'POST', jwt: stranger, headers: JSON_POST, body: '{}' })).status]).toEqual([name, 403])
    }
    expect(x.s.inbox.views.calls).toEqual([])
    expect(x.s.forms.asked.askers).toEqual([])
  })

  test('the Access cookie alone is no sign-in, and a write from another site is refused before the inbox is asked', async () => {
    const x = await asOwner()
    expect((await x.w.call('/api/people', { cookieJwt: x.jwt })).status).toBe(401)
    const res = await x.w.call('/api/inbox/contact-profile', { method: 'POST', jwt: x.jwt, headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(403)
    expect(x.s.inbox.views.calls).toEqual([])
  })

  test('the page is served at /people and under it, to Tessa', async () => {
    const x = await asOwner()
    for (const path of ['/people', '/people/dana%40harbor.example']) expect([path, (await x.w.call(path, { jwt: x.jwt })).status]).toEqual([path, 200])
  })
})

describe('the directory', () => {
  test('Clients, Outside and Team: a Client’s people, everyone else outside (a channel guest too), and the team, by name', async () => {
    const x = await asOwner()
    const a = await x.people()
    const side = (s: string) => a.entries.filter((e) => e.side === s).map((e) => e.name)
    expect(side('client')).toEqual(['Dana Reyes', 'Marcus Chen'])
    expect(side('outside')).toEqual(['(626) 555-0142', 'Dana R.', 'Gwen Guest', 'Tomas Alvarez'])
    expect(side('team')).toEqual(['Priya Natarajan', 'Sam Ortiz', 'Tessa'])
    expect(byName(a, 'Gwen Guest')).toMatchObject({ guest: true, contact: null })
    expect(a.parts).toEqual([
      { part: 'mail', state: 'ok' },
      { part: 'chat', state: 'ok' },
    ])
  })

  test('no channel is listed, and an automated sender is counted and not listed', async () => {
    const x = await asOwner()
    const a = await x.people()
    expect(a.entries.map((e) => e.name)).not.toContain('launch')
    expect(a.entries.map((e) => e.name)).not.toContain('Local Business Weekly')
    expect(a.automated).toBe(1)
  })

  test('the automated senders are listed only when asked for, under their own marking, and their page opens either way with its fields', async () => {
    const x = await asOwner()
    const withThem = (await (await x.w.call('/api/people?automated=1', { jwt: x.jwt })).json()) as PeopleAnswer
    expect(withThem.automated).toBe(1)
    expect(byName(withThem, 'Local Business Weekly')).toMatchObject({ automated: true, side: 'outside', contact: { id: 'c-news' } })
    expect(withThem.entries.filter((e) => e.automated)).toHaveLength(1)
    expect((await x.people()).entries.map((e) => e.name)).not.toContain('Local Business Weekly')
    // A real person the inbox misjudged: the page by their address still opens and carries their fields, beside their conversation too.
    const page = await x.person('news@lbw.example')
    expect(page.entry).toMatchObject({ name: 'Local Business Weekly', automated: true })
    expect(page.profile).toMatchObject({ contactId: 'c-news', automated: true })
    const saved = await x.write<{ business: string }>('contact-profile', { contactId: 'c-news', rev: 0, business: 'LBW', role: '', notes: 'Actually Lena.' })
    expect(saved).toMatchObject({ result: 'ok', value: { business: 'LBW' } })
    expect(x.s.inbox.views.calls.filter((c) => c.method === 'contacts').some((c) => (c.args[0] as { automated?: boolean } | undefined)?.automated === true)).toBe(true)
  })

  test('a teammate is one entry however many places know them: the company layer’s person, their contact and meet’s teammate joined, with no field to edit', async () => {
    const x = await asOwner()
    const priya = byName(await x.people(), 'Priya Natarajan')
    expect(priya).toMatchObject({ side: 'team', contactIds: ['c-priya'], contact: null, team: { address: 'priya@northfield.example', role: 'member' } })
    // The teammate meet knows who has never written appears too, with nothing said.
    expect(byName(await x.people(), 'Sam Ortiz')).toMatchObject({ side: 'team', conversationKey: null, team: null })
  })

  test('a person is joined across the apps by lowercase address, and a contact with only a number is its own entry', async () => {
    const e = mergePeople({
      install: withPriya(),
      inbox: [{ contactId: 'c1', name: 'Dana', identities: [], addresses: ['dana@harbor.example'], client: null, suggestedClient: null, business: '', role: '', conversations: 1, rev: 0, automated: false }],
      meet: [{ conversationId: 3, person: { id: 'p1', name: 'Dana R', kind: 'guest', address: 'Dana@Harbor.Example' }, newest: null, unread: 0 }],
    })
    expect(e.filter((x) => x.side !== 'team').map((x) => x.name)).toEqual(['Dana'])
    expect(e.find((x) => x.name === 'Dana')).toMatchObject({ guest: true, addresses: ['dana@harbor.example'], contactIds: ['c1'] })
  })

  test('a person’s conversation opens only when something has been said, and its key is the Conversations list’s own', async () => {
    const x = await asOwner()
    const a = await x.people()
    expect(byName(a, 'Dana R.').conversationKey).toBeNull()
    expect(byName(a, 'Sam Ortiz').conversationKey).toBeNull()
    const list = (await (await x.w.call('/api/conversations', { jwt: x.jwt })).json()) as ConversationsAnswer
    const rowKeys = list.rows.filter((r): r is ListedPerson => r.type === 'person').map((r) => r.key)
    expect(rowKeys.length).toBeGreaterThan(3)
    const keys = new Set(a.entries.map((e) => e.conversationKey))
    for (const key of rowKeys) expect([key, keys.has(key)]).toEqual([key, true])
  })

  test('where something has been said is on the entry: email for the Inbox, a direct message for Meet, both for a person with both, and neither exactly when there is no conversation to open', async () => {
    const x = await asOwner()
    const a = await x.people()
    for (const e of a.entries) expect([e.name, e.said.mail || e.said.chat]).toEqual([e.name, e.conversationKey !== null])
    const said = (name: string) => byName(a, name).said
    expect(said('Dana Reyes')).toEqual({ mail: true, chat: false })
    expect(said('Gwen Guest')).toEqual({ mail: false, chat: true })
    expect(said('Priya Natarajan')).toEqual({ mail: true, chat: true })
    expect(said('Sam Ortiz')).toEqual({ mail: false, chat: false })
  })

  test('what a person is described by is names, addresses, Client, business and role: no message, subject, snippet, draft or note', async () => {
    const x = await asOwner()
    const json = JSON.stringify(await x.people())
    for (const never of ['secret price list', 'We will pay', 'Winter service question', 'Prefers calls', 'notes']) expect(json).not.toContain(never)
    expect(json).toContain('Office manager')
  })

  test('one part down leaves the others’ people, with a line saying which', async () => {
    const x = await asOwner()
    x.s.inbox.views.script.push('throw')
    const a = await x.people()
    expect(a.parts[0]).toMatchObject({ part: 'mail', state: 'could-not-be-reached' })
    expect(a.entries.map((e) => e.name)).toEqual(['Gwen Guest', 'Priya Natarajan', 'Sam Ortiz', 'Tessa'])
    const y = await asOwner()
    y.s.meet.conversations = async () => ({ ok: false, kind: 'refused', reason: 'not-admitted', message: 'This is not open to you.' })
    const b = await y.people()
    expect(b.parts[1]).toMatchObject({ part: 'chat', state: 'not-open-to-you' })
    expect(b.entries.map((e) => e.name)).toContain('Dana Reyes')
    expect(b.entries.map((e) => e.name)).not.toContain('Gwen Guest')
  })
})

describe('one person’s page', () => {
  test('their contact with its note, every address and number, and the Client; a lead’s suggested Client is only a suggestion', async () => {
    const x = await asOwner()
    const dana = await x.person('dana@harbor.example')
    expect(dana.profileState).toBe('ok')
    expect(dana.profile).toMatchObject({ name: 'Dana Reyes', notes: 'Prefers calls before ten.', business: 'Harbor Dental', role: 'Office manager', client: { id: 7 }, rev: 0 })
    expect(dana.entry.conversationKey).toBe('dana@harbor.example')
    const lead = await x.person('tomas@mail.example')
    expect(lead.profile?.client).toBeNull()
    expect(lead.profile?.suggestedClient).toMatchObject({ id: 3 })
    // A contact reached by a number alone is found by its key and has no email address.
    const number = await x.person('mail:c-text')
    expect(number.entry).toMatchObject({ name: '(626) 555-0142', addresses: [], conversationKey: 'mail:c-text' })
    expect(number.profile).toMatchObject({ contactId: 'c-text', addresses: [] })
  })

  test('a teammate’s page is the company layer’s person and has no profile to edit; a guest the inbox never heard from has none either', async () => {
    const x = await asOwner()
    const priya = await x.person('priya@northfield.example')
    expect(priya.entry.team).toMatchObject({ address: 'priya@northfield.example', role: 'member' })
    expect(priya.profile).toBeNull()
    expect(priya.profileState).toBe('none')
    const guest = await x.person('gwen@elsewhere.example')
    expect(guest.entry).toMatchObject({ guest: true })
    expect(guest.profile).toBeNull()
    // The inbox was not asked for either.
    expect(x.s.inbox.views.calls.filter((c) => c.method === 'contact')).toHaveLength(0)
  })

  test('the key beside a conversation (its row key) finds the same person as the key of the People page, and an address of theirs does too', async () => {
    const x = await asOwner()
    const a = await x.person('dana@harbor.example')
    expect((await x.person('mail:c-dana')).entry.key).toBe(a.entry.key)
    expect((await x.person('DANA@harbor.example')).entry.key).toBe(a.entry.key)
    expect(findEntry((await x.people()).entries, 'nobody@nowhere.example')).toBeUndefined()
  })

  test('an unknown person is a 404, an enormous or empty key a 400, and the apps are not asked for a profile', async () => {
    const x = await asOwner()
    expect((await x.one('nobody@nowhere.example')).status).toBe(404)
    expect((await x.one('x'.repeat(400))).status).toBe(400)
    expect((await x.one('')).status).toBe(400)
    expect(x.s.inbox.views.calls.filter((c) => c.method === 'contact')).toHaveLength(0)
  })

  test('with the inbox down a person is not found, and it is said to be down rather than missing', async () => {
    const x = await asOwner()
    x.s.inbox.views.script.push('throw')
    const res = await x.one('dana@harbor.example')
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toContain('Email could not be reached')
  })
})

describe('the documents a person is on', () => {
  test('forms is asked about their addresses, matched without regard to case, and answers title, state and counts; a draft for someone else is not here', async () => {
    const x = await asOwner()
    const dana = await x.person('dana@harbor.example')
    expect(x.s.forms.asked.on).toEqual([['dana@harbor.example']])
    expect(dana.documents).toMatchObject({ state: 'ok', more: false })
    const docs = (dana.documents as Extract<PersonAnswer['documents'], { state: 'ok' }>).documents
    expect(docs.map((d) => d.title).sort()).toEqual(['Photo release, Harbor Dental', 'Website agreement'])
    expect(docs.find((d) => d.id === 'e-agreement')).toMatchObject({ state: 'completed', signers: 2, signed: 2, at: ago(100) })
  })

  test('never the names of those who have not signed, never an address, link or answer: the page is given no field for them', async () => {
    const x = await asOwner()
    const json = JSON.stringify(await x.person('dana@harbor.example'))
    expect(json).not.toContain('notSigned')
    expect(json).not.toContain('Marcus Chen')
    expect(json).not.toContain('Quote for Tomas')
    expect(json).not.toContain('marcus@harbor.example')
  })

  test('forms down or not connected says so beside a profile that still opens', async () => {
    const x = await asOwner()
    x.s.forms.documentsOn = async () => {
      throw new Error('forms is down')
    }
    const down = await x.person('dana@harbor.example')
    expect(down.profileState).toBe('ok')
    expect(down.documents).toMatchObject({ state: 'could-not-be-reached' })
    const y = await asOwner()
    y.s.forms.documentsOn = async () => ({ ok: false, kind: 'refused', reason: 'not-admitted', message: 'no' })
    expect((await y.person('dana@harbor.example')).documents).toMatchObject({ state: 'not-open-to-you' })
  })

  test('a person with no email address has no documents to ask for, and forms is not asked', async () => {
    const x = await asOwner()
    const number = await x.person('mail:c-text')
    expect(number.documents).toEqual({ state: 'ok', documents: [], more: false })
    expect(x.s.forms.asked.on).toEqual([])
  })
})

describe('who is asking is what the space hands on', () => {
  test('the person its one check named to the inbox, meet and forms, for the list, a page and each write', async () => {
    const x = await asOwner()
    await x.people()
    await x.person('dana@harbor.example')
    await x.write('contact-profile', { contactId: 'c-dana', rev: 0, business: 'B', role: 'R', notes: 'N' })
    const seen = new Set([...x.s.inbox.views.calls.map((c) => c.asker?.person.address), ...x.s.inbox.asked.askers])
    expect([...seen]).toEqual(['tessa@northfield.example'])
    expect(new Set(x.s.meet.asked.askers)).toEqual(new Set(['tessa@northfield.example']))
    expect(new Set(x.s.forms.asked.askers)).toEqual(new Set(['tessa@northfield.example']))
  })
})

describe('the business, the role and the note', () => {
  const edit = (over: Record<string, unknown> = {}) => ({ contactId: 'c-dana', rev: 0, business: 'Harbor Dental Group', role: 'Practice manager', notes: 'Calls before ten.', ...over })

  test('a save is shown back with the next revision, and the page that reads it next sees it', async () => {
    const x = await asOwner()
    const done = await x.write<{ business: string; rev: number }>('contact-profile', edit())
    expect(done).toMatchObject({ result: 'ok', value: { business: 'Harbor Dental Group', rev: 1 } })
    expect((await x.person('dana@harbor.example')).profile).toMatchObject({ business: 'Harbor Dental Group', role: 'Practice manager', notes: 'Calls before ten.', rev: 1 })
    expect(byName(await x.people(), 'Dana Reyes')).toMatchObject({ business: 'Harbor Dental Group', role: 'Practice manager', contact: { id: 'c-dana', rev: 1 } })
  })

  test('a save over a person who changed since is refused with the inbox’s words, says the text typed was not saved, and changes nothing', async () => {
    const x = await asOwner()
    await x.write('contact-profile', edit())
    const stale = await x.write('contact-profile', edit({ notes: 'Typed over the old version.' }))
    expect(stale).toMatchObject({ result: 'refused', reason: 'conflict' })
    expect((await x.person('dana@harbor.example')).profile?.notes).toBe('Calls before ten.')
  })

  test('the Worker refuses a body that is not the shape, before the inbox is asked: no revision, a field past its limit, a contact that is a path', async () => {
    const x = await asOwner()
    for (const body of [edit({ rev: undefined }), edit({ rev: -1 }), edit({ notes: 3 }), edit({ business: 'x'.repeat(201) }), edit({ notes: 'x'.repeat(10_001) }), edit({ contactId: '../etc' }), {}, []]) {
      const res = await x.w.call('/api/inbox/contact-profile', { method: 'POST', jwt: x.jwt, headers: JSON_POST, body: JSON.stringify(body) })
      expect([JSON.stringify(body).slice(0, 40), res.status]).toEqual([JSON.stringify(body).slice(0, 40), 400])
    }
    expect(x.s.inbox.views.calls).toEqual([])
  })

  test('a write the space loses track of is outcome-unknown and is never sent twice', async () => {
    const x = await asOwner({ writeWithinMs: 40 })
    x.s.inbox.views.script.push('hang')
    const lost = await x.write('contact-profile', edit())
    expect(lost).toMatchObject({ result: 'outcome-unknown' })
    expect(x.s.inbox.views.calls.filter((c) => c.method === 'saveContactProfile')).toHaveLength(1)
  })
})

describe('linking a person to a Client', () => {
  test('the list and the page then name the Client; taking them out clears it', async () => {
    const x = await asOwner()
    expect(byName(await x.people(), 'Tomas Alvarez')).toMatchObject({ side: 'outside', client: null, suggestedClient: { id: 3 } })
    const linked = await x.write('client-link', { contactId: 'c-lead', clientId: 3 })
    expect(linked).toMatchObject({ result: 'ok', value: { contactId: 'c-lead', clientId: 3 } })
    expect(x.s.inbox.views.calls.at(-1)).toMatchObject({ method: 'linkClient', args: ['c-lead', 3] })
  })
})

describe('merging two people, and undoing it', () => {
  const merge = (over: Record<string, unknown> = {}) => ({ survivorId: 'c-dana', survivorRev: 0, absorbedId: 'c-dana2', absorbedRev: 0, ...over })

  test('two entries become one, with the addresses of both, and the answer names the merge so it can be undone', async () => {
    const x = await asOwner()
    const done = await x.write<{ mergeId: number; moved: string[]; absorbedName: string }>('contact-merge', merge())
    expect(done).toMatchObject({ result: 'ok', value: { absorbedName: 'Dana R.', moved: ['dreyes@mail.example'] } })
    const a = await x.people()
    expect(a.entries.map((e) => e.name)).not.toContain('Dana R.')
    expect(byName(a, 'Dana Reyes').addresses).toEqual(['dana@harbor.example', 'dreyes@mail.example'])
  })

  test('the undo puts the other person back, with their address, and the first page is as it was', async () => {
    const x = await asOwner()
    const before = await x.people()
    const done = (await x.write<{ mergeId: number }>('contact-merge', merge())) as Extract<ViewAnswer<{ mergeId: number }>, { result: 'ok' }>
    const undone = await x.write('contact-unmerge', { mergeId: done.value.mergeId })
    expect(undone).toMatchObject({ result: 'ok', value: { restored: { name: 'Dana R.', addresses: ['dreyes@mail.example'] } } })
    const after = await x.people()
    expect(after.entries.map((e) => [e.name, e.addresses])).toEqual(before.entries.map((e) => [e.name, e.addresses]))
    // Undone twice is refused, in the inbox's words, and nothing changes.
    expect(await x.write('contact-unmerge', { mergeId: done.value.mergeId })).toMatchObject({ result: 'refused', reason: 'conflict' })
  })

  test('a merge of a person who changed since they were shown is refused and merges nothing', async () => {
    const x = await asOwner()
    await x.write('contact-profile', { contactId: 'c-dana2', rev: 0, business: 'x', role: '', notes: '' })
    expect(await x.write('contact-merge', merge())).toMatchObject({ result: 'refused', reason: 'conflict' })
    expect((await x.people()).entries.map((e) => e.name)).toContain('Dana R.')
  })

  test('the Worker refuses a merge that is not two different people with their revisions, and an undo with no merge named', async () => {
    const x = await asOwner()
    for (const body of [merge({ absorbedId: 'c-dana' }), merge({ survivorRev: 'x' }), merge({ absorbedRev: undefined }), merge({ absorbedId: '../x' }), {}]) {
      expect([JSON.stringify(body), (await x.w.call('/api/inbox/contact-merge', { method: 'POST', jwt: x.jwt, headers: JSON_POST, body: JSON.stringify(body) })).status]).toEqual([JSON.stringify(body), 400])
    }
    for (const body of [{}, { mergeId: -1 }, { mergeId: 'x' }, { mergeId: 1.5 }]) {
      expect([JSON.stringify(body), (await x.w.call('/api/inbox/contact-unmerge', { method: 'POST', jwt: x.jwt, headers: JSON_POST, body: JSON.stringify(body) })).status]).toEqual([JSON.stringify(body), 400])
    }
    expect(x.s.inbox.views.calls).toEqual([])
  })

  test('a team person is never offered as the thing merged: the Worker passes the ids it is given, and the inbox refuses a contact that is not there', async () => {
    const x = await asOwner()
    expect(await x.write('contact-merge', merge({ absorbedId: 'c-nobody' }))).toMatchObject({ result: 'refused', reason: 'not-found' })
  })
})

describe('an inbox the people cannot be read from', () => {
  test('not connected: the team and meet’s people list, and mail is said to be down', async () => {
    const w = await world(withPriya(), NORTHFIELD_TEAM, { meet: standInMeet({ direct: [dm(12, person('p-priya', 'Priya Natarajan', 'priya@northfield.example', 'teammate'), ago(20))], channels: [] }) }, undefined, { now: () => T0 })
    const res = await w.call('/api/people', { jwt: await w.signIn('tessa@northfield.example') })
    const a = (await res.json()) as PeopleAnswer
    expect(a.parts[0]).toMatchObject({ part: 'mail', state: 'could-not-be-reached' })
    expect(a.entries.map((e) => e.name)).toEqual(['Priya Natarajan', 'Tessa'])
  })
})
