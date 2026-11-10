import { describe, expect, test } from 'bun:test'
import {
  CLIENTS_DID_NOT_ANSWER,
  CLIENTS_NOT_CONNECTED,
  checkLink,
  clientLabel,
  clientsById,
  clientView,
  FREE_MAIL_DOMAINS,
  listedClient,
  readClients,
  type SuggestionContact,
  suggestClients as suggest,
} from '../src/clients'
import { bundledInstall } from '../src/workspace'
import { ACME, adminUrlOf, BOLT, TestClients } from '../test-support/clients-part'

/** The suggestion rule, on Northfield's own domain, which it never suggests by. */
const suggestClients = (contacts: SuggestionContact[], clients: Parameters<typeof suggest>[1]) =>
  suggest(contacts, clients, 'northfield.example')

// Northfield's declaration names `signInAddress` as the key to suggest by.
const read = (part: Parameters<typeof readClients>[0]) => readClients(part, bundledInstall)

/**
 * The Clients seam (what is read of the part, and what is done when it does not answer), the mapping from a Client of the part to what the inbox reads, the link check and the pure
 * suggestion rule. The part is the REAL one over a real SQLite (test-support/clients-part.ts); the table tests need no store and no Worker.
 */

describe('what the part answers', () => {
  test('a source’s Client is read as the inbox reads it: the name, the address in the source’s admin, the sign-in address and the subscription come from the source’s generic fields', async () => {
    const part = new TestClients()
    expect(await read(part)).toEqual({
      available: true,
      error: null,
      clients: [BOLT, ACME].sort((a, b) => a.id - b.id),
    })
  })

  test('the address under the declared key is lowercased and a blank one is none; the extra fields are handed on as the source said them', async () => {
    const part = new TestClients([{ ...ACME, extra: { ...ACME.extra, signInAddress: '  Owner@Acme.EXAMPLE ' } }])
    expect((await read(part)).clients[0]?.matchAddress).toBe('owner@acme.example')
    const blank = new TestClients([{ ...ACME, extra: { ...ACME.extra, signInAddress: '   ' } }])
    expect((await read(blank)).clients[0]?.matchAddress).toBeNull()
    expect((await read(new TestClients())).clients.find((c) => c.id === 1)?.extra).toEqual(ACME.extra)
  })

  test('an install whose source declares no key to suggest by reads no address, whatever the source sent', async () => {
    const bare = {
      ...bundledInstall,
      clientsDoor: () =>
        bundledInstall.clientsDoor()
          ? { ...(bundledInstall.clientsDoor() as object), suggestByAddressKey: null }
          : null,
    } as typeof bundledInstall
    const got = await readClients(new TestClients(), bare)
    expect(got.clients.map((c) => c.matchAddress)).toEqual([null, null])
    expect(got.clients.find((c) => c.id === 1)?.extra.signInAddress).toBe('owner@acme.example')
  })

  test('a Client made in the space has no source: no admin address, no sign-in address, no subscription', async () => {
    const part = new TestClients([])
    const number = part.make('Made Here', 'Made Here LLC')
    expect(number).toBe(1001)
    expect((await read(part)).clients).toEqual([
      {
        id: 1001,
        name: 'Made Here',
        legalEntity: 'Made Here LLC',
        matchAddress: null,
        extra: {},
        adminUrl: null,
        archived: false,
      },
    ])
  })

  test('an archived Client is still in the list, marked; a Client the source stopped listing is kept as it was', async () => {
    const part = new TestClients()
    part.archive(2)
    part.send([ACME])
    const got = await read(part)
    expect(got.clients.map((c) => [c.id, c.archived])).toEqual([
      [1, false],
      [2, true],
    ])
    expect(got.clients[1]?.name).toBe('Bolt Machines')
  })

  test('an empty list is an answer: there are no Clients', async () => {
    expect(await read(new TestClients([]))).toEqual({ available: true, error: null, clients: [] })
  })

  test('the mapping of one Client of the part', async () => {
    const part = new TestClients()
    const got = await part.get(1)
    if (!got.ok) throw new Error('expected a Client')
    expect(listedClient(got.value, 'signInAddress')).toEqual(ACME)
  })
})

describe('asking it', () => {
  test('an answer is the Clients, and every ask goes to the part (nothing is cached)', async () => {
    const part = new TestClients()
    expect((await read(part)).clients.map((c) => c.name)).toEqual(['Acme Legal', 'Bolt Machines'])
    part.rename(1, 'Acme Legal Group')
    expect((await read(part)).clients.map((c) => c.name)).toEqual(['Acme Legal Group', 'Bolt Machines'])
    expect(part.asked).toBe(2)
  })

  test('no part and a failure are each an outage with a sentence, and never a throw', async () => {
    expect(await read(undefined)).toEqual({ available: false, error: CLIENTS_NOT_CONNECTED, clients: [] })
    expect(await read(null)).toMatchObject({ available: false })

    const failing = new TestClients()
    failing.failure = new Error('object reset')
    expect(await read(failing)).toEqual({ available: false, error: CLIENTS_DID_NOT_ANSWER, clients: [] })
  })

  test('a part that answers with a refusal is an outage too', async () => {
    const refusing = {
      list: async () => ({ ok: false as const, kind: 'failed' as const, reason: 'broken', message: 'no' }),
      get: async () => ({ ok: false as const, kind: 'failed' as const, reason: 'broken', message: 'no' }),
    }
    expect(await read(refusing as never)).toEqual({
      available: false,
      error: CLIENTS_DID_NOT_ANSWER,
      clients: [],
    })
  })
})

describe('naming a Client', () => {
  const byId = clientsById([ACME])

  test('a held Client is named; one the part does not hold is "Client 7", and says so', () => {
    expect(clientLabel(1, byId)).toEqual({ id: 1, name: 'Acme Legal', listed: true })
    expect(clientLabel(7, byId)).toEqual({ id: 7, name: 'Client 7', listed: false })
  })

  test('a view carries what the part said and the Client in its source’s admin; an unheld one carries only the id', () => {
    expect(clientView(1, byId)).toEqual({
      id: 1,
      name: 'Acme Legal',
      listed: true,
      legalEntity: 'Acme Legal LLP',
      extra: ACME.extra,
      adminUrl: adminUrlOf(1),
      archived: false,
    })
    expect(clientView(7, byId)).toEqual({
      id: 7,
      name: 'Client 7',
      listed: false,
      legalEntity: null,
      extra: {},
      adminUrl: null,
      archived: false,
    })
  })
})

describe('linking a person to a Client', () => {
  const read = (clients: (typeof ACME)[], available = true) => ({
    available,
    error: available ? null : CLIENTS_DID_NOT_ANSWER,
    clients,
  })

  test('a Client the part holds is linkable, whatever its source is doing', () => {
    expect(checkLink(read([ACME]), 1)).toEqual({ ok: true })
  })

  test('the part not answering refuses, with the sentence; a Client it does not hold and an archived one are refused with their own', () => {
    expect(checkLink(read([], false), 1)).toMatchObject({ ok: false, why: 'down' })
    expect(checkLink(read([ACME]), 9)).toMatchObject({
      ok: false,
      why: 'unknown',
      error: expect.stringContaining('no Client 9'),
    })
    expect(checkLink(read([{ ...ACME, archived: true }]), 1)).toMatchObject({
      ok: false,
      why: 'archived',
      error: expect.stringContaining('archived'),
    })
  })
})

describe('suggestions', () => {
  const person = (id: string, emails: string[], clientId: number | null = null): SuggestionContact => ({
    id,
    name: id,
    clientId,
    emails,
  })
  const directory = [ACME, BOLT, { ...BOLT, id: 3, name: 'Cobalt Co', matchAddress: 'hello@cobalt.example' }]
  const ids = (list: ReturnType<typeof suggestClients>) => list.map((s) => `${s.contactId}->${s.clientId}:${s.reason}`)

  test("an address that IS a Client's sign-in address suggests that Client", () => {
    const out = suggestClients([person('p', ['owner@acme.example'])], directory)
    expect(out).toEqual([
      {
        contactId: 'p',
        contactName: 'p',
        clientId: 1,
        clientName: 'Acme Legal',
        reason: 'address',
        via: 'owner@acme.example',
      },
    ])
  })

  test('a similar address does not: only equality counts, and a Client with no sign-in address matches nothing', () => {
    expect(
      suggestClients([person('p', ['owner@acme.example.org', 'xowner@acme.example', 'o@acme.example'])], directory),
    ).toEqual([])
    expect(suggestClients([person('p', ['null@null', ''])], directory)).toEqual([])
  })

  test('a domain that people assigned to one Client already write from suggests that Client', () => {
    const contacts = [person('staff', ['sam@acme-legal.example'], 1), person('new', ['pat@acme-legal.example'])]
    expect(suggestClients(contacts, directory)).toEqual([
      {
        contactId: 'new',
        contactName: 'new',
        clientId: 1,
        clientName: 'Acme Legal',
        reason: 'domain',
        via: 'acme-legal.example',
      },
    ])
  })

  test('a domain shared by people of two Clients says nothing', () => {
    const contacts = [
      person('a', ['x@shared.example'], 1),
      person('b', ['y@shared.example'], 2),
      person('new', ['z@shared.example']),
    ]
    expect(suggestClients(contacts, directory)).toEqual([])
  })

  test('a free-mail domain never counts, however many assigned people write from it', () => {
    for (const domain of FREE_MAIL_DOMAINS) {
      const contacts = [person('a', [`x@${domain}`], 1), person('new', [`y@${domain}`])]
      expect(suggestClients(contacts, directory), domain).toEqual([])
    }
    expect([...FREE_MAIL_DOMAINS].sort()).toEqual(
      [
        'aol.com',
        'gmail.com',
        'googlemail.com',
        'hotmail.com',
        'icloud.com',
        'live.com',
        'me.com',
        'msn.com',
        'outlook.com',
        'proton.me',
        'protonmail.com',
        'yahoo.com',
      ].sort(),
    )
  })

  test('our own domain never counts, so one mistaken assignment of our own address does not suggest a Client for everyone', () => {
    const contacts = [person('tessa', ['tessa@northfield.example'], 1), person('new', ['someone@northfield.example'])]
    expect(suggestClients(contacts, directory)).toEqual([])
  })

  test('a contact that already has a Client is never suggested another', () => {
    const contacts = [person('staff', ['sam@acme-legal.example'], 1), person('owner', ['hello@cobalt.example'], 2)]
    expect(suggestClients(contacts, directory)).toEqual([])
  })

  test('only a listed Client is suggested: an assigned Client the directory does not list suggests nothing', () => {
    const contacts = [person('staff', ['sam@gone.example'], 99), person('new', ['pat@gone.example'])]
    expect(suggestClients(contacts, directory)).toEqual([])
    expect(suggestClients([person('p', ['owner@acme.example'])], [])).toEqual([])
  })

  test('an archived Client is never suggested, by its sign-in address or by its people’s domain: a link to it would be refused', () => {
    const archived = [{ ...ACME, archived: true }, BOLT]
    expect(suggestClients([person('p', ['owner@acme.example'])], archived)).toEqual([])
    const contacts = [person('staff', ['sam@acme-legal.example'], 1), person('new', ['pat@acme-legal.example'])]
    expect(suggestClients(contacts, archived)).toEqual([])
  })

  test('a Client made in the space has no sign-in address, so only its people’s domain can suggest it', () => {
    const here = { ...BOLT, id: 1001, name: 'Made Here', matchAddress: null, adminUrl: null }
    const contacts = [
      person('staff', ['sam@madehere.example'], 1001),
      person('new', ['pat@madehere.example']),
      person('other', ['nobody@else.example']),
    ]
    expect(ids(suggestClients(contacts, [here]))).toEqual(['new->1001:domain'])
  })

  test("any of a contact's addresses will do, and a Client is suggested once, by its strongest reason", () => {
    const contacts = [
      person('staff', ['sam@acme.example'], 1),
      person('both', ['owner@acme.example', 'also@acme.example']),
      person('two', ['else_where@gmail.com', 'hello@cobalt.example']),
    ]
    expect(ids(suggestClients(contacts, directory))).toEqual(['both->1:address', 'two->3:address'])
  })

  test('addresses are compared as stored (normalized), so case in the directory has been dealt with before here', () => {
    expect(
      suggestClients([person('p', ['owner@acme.example'])], [{ ...ACME, matchAddress: 'owner@acme.example' }]),
    ).toHaveLength(1)
  })
})
