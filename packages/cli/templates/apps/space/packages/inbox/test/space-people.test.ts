import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createInstall, type InboxForSpace, PROFILE_MAX } from '@space/workspace'
import { INBOX_MIGRATIONS, INBOX_VERSION, migrate } from '../src/store/schema'
import { ACME, BOLT } from '../test-support/clients-part'
import { AGENT, asker, harness, OWNER, STRANGER } from '../test-support/harness'
import { memoryDatabase } from '../test-support/sql-over-sqlite'

/**
 * The inbox's contacts as People draws them (src/space-people.ts, which the space's Worker calls in-process), driven as the space drives
 * it: through `InboxForSpace` with the person the space's check named, over the real store and the real migrations. What these cannot show is the
 * runtime (that the binding routes to the class and clones the answers) and the real Client list; those are the runbook's checks after the deploy.
 *
 * What is proved: who is refused (and that a refused asker changed nothing), what appears for a person and what never does, the three fields and
 * their revision, linking a Client, the merge of two contacts and its undo.
 */

type H = ReturnType<typeof harness>

const assertion = (who: Record<string, unknown> = OWNER) => asker(who)
const unwrap = <T>(r: { ok: boolean; value?: T }): T => {
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return (r as { value: T }).value
}
const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]

/** Gmail has read in a small correspondence: Dana (under two addresses), Eli, and a newsletter that is no person. */
async function world(): Promise<H> {
  const h = harness()
  const g = h.google.mailbox
  g.add({
    id: 'm1',
    threadId: 't1',
    from: 'Dana Smith <dana@acme.example>',
    subject: 'Quote for the shop',
    body: 'Can you quote the shop front? The secret figure is 4,100.',
  })
  g.add({
    id: 'm2',
    threadId: 't2',
    from: 'D. Smith <dana@home.example>',
    subject: 'From home',
    body: 'Writing from the other address.',
  })
  g.add({
    id: 'm3',
    threadId: 't3',
    from: 'Eli Park <eli@example.com>',
    subject: 'Shared plan',
    body: 'Here is the plan.',
  })
  g.add({
    id: 'm4',
    threadId: 't4',
    from: 'Brand News <news@brand.example.com>',
    subject: 'Weekly deals',
    body: 'Ten percent off everything this week.',
    headers: { 'List-Unsubscribe': '<mailto:unsubscribe@brand.example.com>' },
  })
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
  return h
}

const idOf = (h: H, address: string): string =>
  (
    rows<{ contact_id: string }>(h, `SELECT contact_id FROM identity WHERE address = '${address}'`)[0] as {
      contact_id: string
    }
  ).contact_id
const columns = (h: H, id: string) =>
  h.db.query(`SELECT name, business, role, notes, profile_rev, client_id FROM contact WHERE id = ?`).get(id)

const calls = (s: InboxForSpace, a: never) => ({
  contacts: () => s.contacts(a),
  contact: () => s.contact(a, 'c-1'),
  saveContactProfile: () =>
    s.saveContactProfile(a, { contactId: 'c-1', rev: 0, business: 'Acme', role: 'Owner', notes: 'n' }),
  mergeContacts: () => s.mergeContacts(a, { survivorId: 'c-1', survivorRev: 0, absorbedId: 'c-2', absorbedRev: 0 }),
  undoContactMerge: () => s.undoContactMerge(a, 1),
})

describe('who is asking, for every one of People’s methods', () => {
  test('there is a call here for each of the contract’s five new methods', () => {
    expect(Object.keys(calls(harness().space(), '' as never)).sort()).toEqual([
      'contact',
      'contacts',
      'mergeContacts',
      'saveContactProfile',
      'undoContactMerge',
    ])
  })

  test('a person who is not Tessa (a teammate included) is not-admitted; neither changes anything', async () => {
    const h = await world()
    const dana = idOf(h, 'dana@acme.example')
    const eli = idOf(h, 'eli@example.com')
    const raw = JSON.parse(readFileSync(new URL('../../workspace/northfield/workspace.json', import.meta.url), 'utf8'))
    raw.people.push({ address: 'eve@northfield.example', name: 'Eve', role: 'member' })
    const withTeam = h.space({ install: createInstall(raw) })
    const before = {
      contacts: rows(h, `SELECT * FROM contact ORDER BY id`),
      audit: rows(h, `SELECT * FROM audit`).length,
    }
    const real = (s: InboxForSpace, a: never) => ({
      saveContactProfile: () =>
        s.saveContactProfile(a, { contactId: dana, rev: 0, business: 'Hijack', role: '', notes: '' }),
      mergeContacts: () => s.mergeContacts(a, { survivorId: dana, survivorRev: 0, absorbedId: eli, absorbedRev: 0 }),
      undoContactMerge: () => s.undoContactMerge(a, 1),
      contacts: () => s.contacts(a),
      contact: () => s.contact(a, dana),
    })
    for (const [who, reason] of [
      [STRANGER, 'not-admitted'],
      [{ email: 'eve@northfield.example' }, 'not-admitted'],
    ] as const) {
      for (const [method, call] of Object.entries(real(withTeam, asker(who) as never))) {
        expect([JSON.stringify(who), method, await call()]).toMatchObject([
          JSON.stringify(who),
          method,
          { ok: false, kind: 'refused', reason },
        ])
      }
    }
    expect({
      contacts: rows(h, `SELECT * FROM contact ORDER BY id`),
      audit: rows(h, `SELECT * FROM audit`).length,
    }).toEqual(before)
  })
})

describe('what appears for a person, and what never does', () => {
  test('every person is listed with their addresses, Client, business, role and revision; an automated sender is counted and not listed', async () => {
    const h = await world()
    const list = unwrap(await h.space().contacts(await assertion()))
    expect(list.contacts.map((c) => c.name).sort()).toEqual(['D. Smith', 'Dana Smith', 'Eli Park'])
    expect(list.automated).toBe(1)
    const dana = list.contacts.find((c) => c.name === 'Dana Smith')
    expect(dana).toEqual({
      contactId: idOf(h, 'dana@acme.example'),
      name: 'Dana Smith',
      identities: [{ id: expect.any(String), kind: 'email', address: 'dana@acme.example' }],
      addresses: ['dana@acme.example'],
      client: null,
      suggestedClient: null,
      business: '',
      role: '',
      conversations: 1,
      rev: 0,
      sendsFrom: { name: 'northfield', address: 'tessa@northfield.example' },
      automated: false,
    } as never)
  })

  test('the automated sender is only listed when asked for, marked, and is read by its id either way, so a real person misjudged is not lost', async () => {
    const h = await world()
    const a = await assertion()
    const all = unwrap(await h.space().contacts(a, { automated: true }))
    expect(all.automated).toBe(1)
    expect(all.contacts.filter((c) => c.automated).map((c) => c.name)).toEqual(['Brand News'])
    expect(all.contacts.filter((c) => !c.automated)).toHaveLength(3)
    // Not listed by default, but its profile reads and takes its fields like anyone's.
    const brand = all.contacts.find((c) => c.automated) as { contactId: string; rev: number }
    expect(unwrap(await h.space().contacts(a)).contacts.map((c) => c.contactId)).not.toContain(brand.contactId)
    const saved = unwrap(
      await h.space().saveContactProfile(a, {
        contactId: brand.contactId,
        rev: brand.rev,
        business: 'Brand Co',
        role: '',
        notes: 'A real person after all.',
      }),
    )
    expect(saved).toMatchObject({ automated: true, business: 'Brand Co', notes: 'A real person after all.' })
    expect(unwrap(await h.space().contact(a, brand.contactId)).notes).toBe('A real person after all.')
    expect(await h.space().contacts(a, { automated: 'yes' as never })).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    expect(await h.space().contacts(a, 7 as never)).toMatchObject({ ok: false, reason: 'bad-request' })
  })

  test('no message, subject, snippet, draft or note is in the list, whatever was said', async () => {
    const h = await world()
    const id = idOf(h, 'dana@acme.example')
    unwrap(
      await h.space().saveContactProfile(await assertion(), {
        contactId: id,
        rev: 0,
        business: 'Acme Legal',
        role: 'Partner',
        notes: 'Prefers calls before ten.',
      }),
    )
    const json = JSON.stringify(unwrap(await h.space().contacts(await assertion())))
    for (const never of [
      'secret figure',
      'Quote for the shop',
      'Weekly deals',
      'Prefers calls',
      'news@brand.example.com',
      'Brand News',
    ])
      expect(json).not.toContain(never)
    // The note is the profile's alone; the profile carries no message either.
    const profile = unwrap(await h.space().contact(await assertion(), id))
    expect(profile.notes).toBe('Prefers calls before ten.')
    expect(JSON.stringify(profile)).not.toContain('secret figure')
  })

  test('a Client is named from the site’s list, and a suggestion is shown but counts for nothing', async () => {
    const h = await world()
    const dana = idOf(h, 'dana@acme.example')
    unwrap(await h.space().linkClient(await assertion(), dana, ACME.id))
    const list = unwrap(await h.space().contacts(await assertion()))
    expect(list.contacts.find((c) => c.contactId === dana)).toMatchObject({
      client: { id: ACME.id, name: ACME.name, listed: true },
      suggestedClient: null,
    })
    // Dana is under Acme, so Acme's people at its own domain are suggested for it; nothing is linked by being suggested.
    const rowsAfter = rows<{ client_id: number | null }>(h, `SELECT client_id FROM contact WHERE id != '${dana}'`)
    expect(rowsAfter.every((r) => r.client_id === null)).toBe(true)
  })

  test('a contact with no conversation yet is a person too, and says so', async () => {
    const h = await world()
    const made = h.inbox.createDraft(
      { address: 'new@person.example', name: 'New Person', body: 'Hello', why: 'w' },
      'tessa@northfield.example',
    )
    expect(made.ok).toBe(true)
    const list = unwrap(await h.space().contacts(await assertion()))
    expect(list.contacts.find((c) => c.name === 'New Person')).toMatchObject({ addresses: ['new@person.example'] })
  })
})

describe('the business, the role and the note, at a revision', () => {
  test('a save is trimmed, raises the revision and is audited with the person who made it', async () => {
    const h = await world()
    const id = idOf(h, 'dana@acme.example')
    const saved = unwrap(
      await h.space().saveContactProfile(await assertion(), {
        contactId: id,
        rev: 0,
        business: '  Acme Legal ',
        role: 'Partner',
        notes: ' Prefers calls. ',
      }),
    )
    expect(saved).toMatchObject({
      contactId: id,
      business: 'Acme Legal',
      role: 'Partner',
      notes: 'Prefers calls.',
      rev: 1,
    })
    expect(columns(h, id)).toMatchObject({
      business: 'Acme Legal',
      role: 'Partner',
      notes: 'Prefers calls.',
      profile_rev: 1,
    })
    const entry = rows<{ actor: string; action: string }>(
      h,
      `SELECT actor, action FROM audit WHERE action = 'contact.profile'`,
    )
    expect(entry).toEqual([{ actor: 'tessa@northfield.example', action: 'contact.profile' }])
  })

  test('a save from a screen read before another save is refused and changes nothing; read again, it goes through', async () => {
    const h = await world()
    const id = idOf(h, 'dana@acme.example')
    const a = await assertion()
    unwrap(await h.space().saveContactProfile(a, { contactId: id, rev: 0, business: 'Acme', role: '', notes: 'first' }))
    const stale = await h
      .space()
      .saveContactProfile(a, { contactId: id, rev: 0, business: 'Other', role: '', notes: 'second' })
    expect(stale).toMatchObject({ ok: false, kind: 'refused', reason: 'conflict' })
    expect(columns(h, id)).toMatchObject({ business: 'Acme', notes: 'first', profile_rev: 1 })
    const fresh = unwrap(await h.space().contact(a, id))
    expect(fresh.rev).toBe(1)
    expect(
      unwrap(
        await h
          .space()
          .saveContactProfile(a, { contactId: id, rev: fresh.rev, business: 'Other', role: '', notes: 'second' }),
      ).rev,
    ).toBe(2)
  })

  test('a stale screen is told so even when it would have written what is there; a current one that changes nothing writes nothing', async () => {
    const h = await world()
    const id = idOf(h, 'dana@acme.example')
    const a = await assertion()
    unwrap(await h.space().saveContactProfile(a, { contactId: id, rev: 0, business: 'Acme', role: '', notes: '' }))
    expect(
      await h.space().saveContactProfile(a, { contactId: id, rev: 0, business: 'Acme', role: '', notes: '' }),
    ).toMatchObject({ ok: false, reason: 'conflict' })
    const auditBefore = rows(h, `SELECT * FROM audit`).length
    expect(
      unwrap(await h.space().saveContactProfile(a, { contactId: id, rev: 1, business: 'Acme', role: '', notes: '' }))
        .rev,
    ).toBe(1)
    expect(rows(h, `SELECT * FROM audit`).length).toBe(auditBefore)
  })

  test('a field past its limit, a missing revision, text that is not text and a contact that is not there are refused, and nothing changes', async () => {
    const h = await world()
    const id = idOf(h, 'dana@acme.example')
    const a = await assertion()
    const base = { contactId: id, rev: 0, business: '', role: '', notes: '' }
    expect(
      await h.space().saveContactProfile(a, { ...base, business: 'x'.repeat(PROFILE_MAX.business + 1) }),
    ).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await h.space().saveContactProfile(a, { ...base, role: 'x'.repeat(PROFILE_MAX.role + 1) })).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    expect(await h.space().saveContactProfile(a, { ...base, notes: 'x'.repeat(PROFILE_MAX.notes + 1) })).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    expect(await h.space().saveContactProfile(a, { ...base, rev: -1 })).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    expect(await h.space().saveContactProfile(a, { ...base, notes: 7 as never })).toMatchObject({
      ok: false,
      reason: 'bad-request',
    })
    expect(await h.space().saveContactProfile(a, { ...base, contactId: 'nobody' })).toMatchObject({
      ok: false,
      reason: 'not-found',
    })
    expect(await h.space().saveContactProfile(a, { ...base, contactId: '../etc' })).toMatchObject({
      ok: false,
      reason: 'not-found',
    })
    expect(columns(h, id)).toMatchObject({ business: '', role: '', notes: '', profile_rev: 0 })
  })

  test('the fields survive the inbox’s own rename, Client link and mail arriving', async () => {
    const h = await world()
    const id = idOf(h, 'dana@acme.example')
    const a = await assertion()
    unwrap(
      await h.space().saveContactProfile(a, { contactId: id, rev: 0, business: 'Acme', role: 'Partner', notes: 'n' }),
    )
    expect(h.inbox.renameContact(id, 'Dana S.', 'tessa@northfield.example').ok).toBe(true)
    unwrap(await h.space().linkClient(a, id, ACME.id))
    h.google.mailbox.add({
      id: 'm9',
      threadId: 't9',
      from: 'Dana Smith <dana@acme.example>',
      subject: 'More',
      body: 'More words.',
    })
    await h.push()
    await h.drain()
    expect(columns(h, id)).toMatchObject({
      name: 'Dana S.',
      business: 'Acme',
      role: 'Partner',
      notes: 'n',
      client_id: ACME.id,
    })
  })
})

describe('linking a Client from People', () => {
  test('a person is linked to a Client the site lists, and the list then names it; taking them out clears it; an unlisted Client is refused', async () => {
    const h = await world()
    const id = idOf(h, 'eli@example.com')
    const a = await assertion()
    expect(unwrap(await h.space().linkClient(a, id, BOLT.id))).toEqual({ contactId: id, clientId: BOLT.id })
    expect(unwrap(await h.space().contacts(a)).contacts.find((c) => c.contactId === id)?.client).toMatchObject({
      id: BOLT.id,
      name: BOLT.name,
    })
    expect(await h.space().linkClient(a, id, 99)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(unwrap(await h.space().linkClient(a, id, null))).toEqual({ contactId: id, clientId: null })
    expect(unwrap(await h.space().contacts(a)).contacts.find((c) => c.contactId === id)?.client).toBeNull()
  })
})

describe('merging two contacts, and undoing it', () => {
  async function twoDanas() {
    const h = await world()
    const survivor = idOf(h, 'dana@acme.example')
    const absorbed = idOf(h, 'dana@home.example')
    const a = await assertion()
    return { h, a, survivor, absorbed }
  }
  const merge = (s: InboxForSpace, a: never, survivor: string, absorbed: string, revs = [0, 0]) =>
    s.mergeContacts(a, {
      survivorId: survivor,
      survivorRev: revs[0] as number,
      absorbedId: absorbed,
      absorbedRev: revs[1] as number,
    })

  test('the survivor keeps its name and Client and takes the other’s addresses and conversations; the other is gone; the answer names the merge', async () => {
    const { h, a, survivor, absorbed } = await twoDanas()
    unwrap(await h.space().linkClient(a, survivor, ACME.id))
    const done = unwrap(await merge(h.space(), a as never, survivor, absorbed))
    expect(done).toMatchObject({
      absorbedName: 'D. Smith',
      moved: ['dana@home.example'],
      survivor: {
        contactId: survivor,
        name: 'Dana Smith',
        client: { id: ACME.id },
        addresses: ['dana@acme.example', 'dana@home.example'],
        rev: 1,
      },
    })
    expect(done.mergeId).toBeGreaterThan(0)
    expect(columns(h, absorbed)).toBeNull()
    expect(
      unwrap(await h.space().contacts(a))
        .contacts.map((c) => c.name)
        .sort(),
    ).toEqual(['Dana Smith', 'Eli Park'])
    expect(unwrap(await h.space().contacts(a)).contacts.find((c) => c.contactId === survivor)?.conversations).toBe(2)
  })

  test('a field the survivor leaves blank takes the other’s, one it filled stays, and the audit keeps both', async () => {
    const { h, a, survivor, absorbed } = await twoDanas()
    unwrap(
      await h.space().saveContactProfile(a, { contactId: survivor, rev: 0, business: 'Acme', role: '', notes: '' }),
    )
    unwrap(
      await h.space().saveContactProfile(a, {
        contactId: absorbed,
        rev: 0,
        business: 'Home Co',
        role: 'Owner',
        notes: 'Calls at night.',
      }),
    )
    const done = unwrap(await merge(h.space(), a as never, survivor, absorbed, [1, 1]))
    expect(done.survivor).toMatchObject({ business: 'Acme', role: 'Owner', notes: 'Calls at night.' })
    const entry = rows<{ before: string }>(h, `SELECT before FROM audit WHERE action = 'contact.merge'`)[0]
    expect(entry?.before).toContain('Home Co')
  })

  test('a merge of a person who changed since they were shown is refused and changes nothing; the same screen read again goes through', async () => {
    const { h, a, survivor, absorbed } = await twoDanas()
    unwrap(
      await h.space().saveContactProfile(a, { contactId: absorbed, rev: 0, business: 'Home Co', role: '', notes: '' }),
    )
    const snapshot = rows(h, `SELECT * FROM identity ORDER BY id`)
    expect(await merge(h.space(), a as never, survivor, absorbed, [0, 0])).toMatchObject({
      ok: false,
      kind: 'refused',
      reason: 'conflict',
    })
    expect(await merge(h.space(), a as never, survivor, absorbed, [1, 1])).toMatchObject({
      ok: false,
      reason: 'conflict',
    })
    expect(rows(h, `SELECT * FROM identity ORDER BY id`)).toEqual(snapshot)
    expect(unwrap(await merge(h.space(), a as never, survivor, absorbed, [0, 1])).survivor.business).toBe('Home Co')
  })

  test('a person cannot be merged into themselves, and an unknown or path-shaped contact is not found', async () => {
    const { h, a, survivor } = await twoDanas()
    expect(await merge(h.space(), a as never, survivor, survivor)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await merge(h.space(), a as never, survivor, 'nobody')).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await merge(h.space(), a as never, survivor, '../x')).toMatchObject({ ok: false, reason: 'not-found' })
    expect(
      await h
        .space()
        .mergeContacts(a, { survivorId: survivor, survivorRev: 'x' as never, absorbedId: 'y', absorbedRev: 0 }),
    ).toMatchObject({ ok: false, reason: 'bad-request' })
  })

  test('undoing puts the other person back with their name, Client, fields and addresses, and the survivor as it was', async () => {
    const { h, a, survivor, absorbed } = await twoDanas()
    unwrap(
      await h.space().saveContactProfile(a, {
        contactId: absorbed,
        rev: 0,
        business: 'Home Co',
        role: 'Owner',
        notes: 'Calls at night.',
      }),
    )
    unwrap(await h.space().linkClient(a, absorbed, BOLT.id))
    const survivorBefore = columns(h, survivor)
    const done = unwrap(await merge(h.space(), a as never, survivor, absorbed, [0, 1]))
    expect(columns(h, survivor)).toMatchObject({ business: 'Home Co', client_id: BOLT.id })
    const undone = unwrap(await h.space().undoContactMerge(a, done.mergeId))
    expect(undone.restored).toMatchObject({
      contactId: absorbed,
      name: 'D. Smith',
      addresses: ['dana@home.example'],
      business: 'Home Co',
      role: 'Owner',
      notes: 'Calls at night.',
      client: { id: BOLT.id },
    })
    expect(undone.survivor).toMatchObject({
      contactId: survivor,
      addresses: ['dana@acme.example'],
      business: '',
      client: null,
    })
    expect(columns(h, survivor)).toMatchObject({
      ...(survivorBefore as object),
      profile_rev: (survivorBefore as { profile_rev: number }).profile_rev + 2,
    })
    // Each person's conversations went back with their address.
    const list = unwrap(await h.space().contacts(a)).contacts
    expect(list.find((c) => c.contactId === survivor)?.conversations).toBe(1)
    expect(list.find((c) => c.contactId === absorbed)?.conversations).toBe(1)
    expect(rows<{ action: string }>(h, `SELECT action FROM audit WHERE action = 'contact.unmerge'`)).toHaveLength(1)
  })

  test('a revision never goes back: every screen read before the merge is stale after the undo', async () => {
    const { h, a, survivor, absorbed } = await twoDanas()
    const done = unwrap(await merge(h.space(), a as never, survivor, absorbed))
    const undone = unwrap(await h.space().undoContactMerge(a, done.mergeId))
    expect(undone.survivor.rev).toBeGreaterThan(0)
    expect(undone.restored.rev).toBeGreaterThan(0)
    expect(
      await h.space().saveContactProfile(a, { contactId: absorbed, rev: 0, business: 'x', role: '', notes: '' }),
    ).toMatchObject({ ok: false, reason: 'conflict' })
  })

  test('undoing twice, or undoing a number that is not a merge, is refused and changes nothing', async () => {
    const { h, a, survivor, absorbed } = await twoDanas()
    const done = unwrap(await merge(h.space(), a as never, survivor, absorbed))
    unwrap(await h.space().undoContactMerge(a, done.mergeId))
    const snapshot = rows(h, `SELECT * FROM identity ORDER BY id`)
    expect(await h.space().undoContactMerge(a, done.mergeId)).toMatchObject({ ok: false, reason: 'conflict' })
    expect(await h.space().undoContactMerge(a, 999_999)).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await h.space().undoContactMerge(a, -1)).toMatchObject({ ok: false, reason: 'bad-request' })
    expect(await h.space().undoContactMerge(a, 1.5 as never)).toMatchObject({ ok: false, reason: 'bad-request' })
    // The number of an audit entry that is not a merge (the profile save above is one) is not a merge.
    unwrap(
      await h
        .space()
        .saveContactProfile(a, { contactId: survivor, rev: revOf(h, survivor), business: 'x', role: '', notes: '' }),
    )
    const notAMerge = (
      rows<{ id: number }>(h, `SELECT id FROM audit WHERE action = 'contact.profile'`)[0] as { id: number }
    ).id
    expect(await h.space().undoContactMerge(a, notAMerge)).toMatchObject({ ok: false, reason: 'not-found' })
    expect(rows(h, `SELECT * FROM identity ORDER BY id`)).toEqual(snapshot)
  })

  test('an old merge cannot be undone once the same person was merged again: the later merge is the one to undo', async () => {
    const { h, a, survivor, absorbed } = await twoDanas()
    const first = unwrap(await merge(h.space(), a as never, survivor, absorbed))
    unwrap(await h.space().undoContactMerge(a, first.mergeId))
    const now = unwrap(await h.space().contacts(a)).contacts
    const rev = (id: string) => (now.find((c) => c.contactId === id) as { rev: number }).rev
    const second = unwrap(await merge(h.space(), a as never, survivor, absorbed, [rev(survivor), rev(absorbed)]))
    expect(second.mergeId).toBeGreaterThan(first.mergeId)
    const snapshot = rows(h, `SELECT * FROM identity ORDER BY id`)
    const refusal = await h.space().undoContactMerge(a, first.mergeId)
    expect(refusal).toMatchObject({ ok: false, reason: 'conflict' })
    expect((refusal as { message: string }).message).toContain('merged again')
    expect(rows(h, `SELECT * FROM identity ORDER BY id`)).toEqual(snapshot)
    // The later one undoes.
    expect(unwrap(await h.space().undoContactMerge(a, second.mergeId)).restored.contactId).toBe(absorbed)
  })

  test('edits made to the survivor after the merge are kept by the undo, and an address split off since stays where it went', async () => {
    const { h, a, survivor, absorbed } = await twoDanas()
    // The absorbed contact has two addresses, so one can be split off after the merge.
    h.google.mailbox.add({
      id: 'm5',
      threadId: 't5',
      from: 'D. Smith <dana.s@home.example>',
      subject: 'Third address',
      body: 'Hi.',
    })
    await h.push()
    await h.drain()
    const third = idOf(h, 'dana.s@home.example')
    unwrap(await merge(h.space(), a as never, absorbed, third))
    const done = unwrap(await merge(h.space(), a as never, survivor, absorbed, [0, 1]))
    expect(done.moved).toEqual(['dana.s@home.example', 'dana@home.example'])
    const afterMerge = unwrap(await h.space().contact(a, survivor))
    unwrap(
      await h.space().saveContactProfile(a, {
        contactId: survivor,
        rev: afterMerge.rev,
        business: 'Edited after',
        role: '',
        notes: '',
      }),
    )
    const split = rows<{ id: string }>(h, `SELECT id FROM identity WHERE address = 'dana.s@home.example'`)[0] as {
      id: string
    }
    expect(h.inbox.splitIdentity(split.id, 'tessa@northfield.example').ok).toBe(true)
    const undone = unwrap(await h.space().undoContactMerge(a, done.mergeId))
    expect(undone.restored.addresses).toEqual(['dana@home.example'])
    expect(undone.survivor).toMatchObject({ business: 'Edited after', addresses: ['dana@acme.example'] })
    expect(idOf(h, 'dana.s@home.example')).not.toBe(survivor)
  })

  test('when the survivor was merged into someone else since, the first merge cannot be undone from here', async () => {
    const { h, a, survivor, absorbed } = await twoDanas()
    const eli = idOf(h, 'eli@example.com')
    const first = unwrap(await merge(h.space(), a as never, survivor, absorbed))
    const afterFirst = first.survivor.rev
    unwrap(await merge(h.space(), a as never, eli, survivor, [0, afterFirst]))
    expect(await h.space().undoContactMerge(a, first.mergeId)).toMatchObject({ ok: false, reason: 'conflict' })
    expect(columns(h, absorbed)).toBeNull()
  })

  test('the merge route (Claude’s script merges through it) still merges, and says which merge it was', async () => {
    const { h, survivor, absorbed } = await twoDanas()
    const res = await h.request(AGENT, 'POST', `/api/contacts/${survivor}/merge`, { absorb: absorbed })
    expect(res.status).toBe(200)
    expect(res.json.identities.map((i: { address: string }) => i.address).sort()).toEqual([
      'dana@acme.example',
      'dana@home.example',
    ])
    expect(res.json.mergeId).toBeGreaterThan(0)
  })
})

/** The revision a contact has now. */
function revOf(h: H, id: string): number {
  return (columns(h, id) as { profile_rev: number }).profile_rev
}

describe('the migration', () => {
  test('a store before it takes the four columns and every contact it had starts with empty fields at revision 0, no row rewritten', () => {
    const { sql, db } = memoryDatabase()
    sql.exec(`CREATE TABLE "inbox_meta" ("id" TEXT PRIMARY KEY CHECK ("id" = 'version'), "applied" INTEGER NOT NULL)`)
    for (const step of INBOX_MIGRATIONS.slice(0, 12)) sql.exec(step)
    sql.exec(`INSERT INTO inbox_meta (id, applied) VALUES ('version', 12)`)
    db.run(`INSERT INTO contact (id, name, created_at, created_by) VALUES ('c1', 'Ann', 't', 'x')`)
    // The store is at 12 before the People entry; the delivery reports' (delivery_event) and the several Gmail accounts' follow it, so a store this old ends at the current version.
    expect(migrate(sql)).toBe(INBOX_VERSION)
    expect(sql.exec(`SELECT name, business, role, notes, profile_rev FROM contact`).one()).toEqual({
      name: 'Ann',
      business: '',
      role: '',
      notes: '',
      profile_rev: 0,
    })
  })

  test('a build that knows only twelve refuses a store at thirteen, loudly, rather than answer it wrongly', () => {
    const { sql } = memoryDatabase()
    migrate(sql)
    const older = { ...sql, exec: sql.exec }
    // The refusal is the runner's: a store ahead of the list is a rollback it cannot honestly serve.
    sql.exec(`UPDATE inbox_meta SET applied = ${INBOX_MIGRATIONS.length + 1} WHERE id = 'version'`)
    expect(() => migrate(older)).toThrow(/only knows/)
  })
})
