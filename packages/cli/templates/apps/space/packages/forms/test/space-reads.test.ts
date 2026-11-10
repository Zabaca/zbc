// What forms answers the space (src/space-reads.ts): the reads Today and People draw from. Driven with the person the space's one sign-in check
// would have named, over the real migrations, as the space calls them in-process: forms' own rule is applied, and what comes back is a title,
// a state and names, never what a document holds. The sign-in check itself is the space's and is proven in packages/space.
import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { type ConversationRef, DOCUMENT_STATES, type DocumentState, type Install, type SignedIn, normalizeAddress, signedIn } from '@space/workspace'
import { lane as laneInstall } from '../../workspace/test/helpers'
import type { EnvelopeStatus } from '../src/vocab'
import { documents, documentsIn, documentsOn, type SpaceReadDeps } from '../src/space-reads'
import { harness } from './harness'
import { ALICE, BOB, kit } from './signing-kit'

const h = harness()
const k = kit(h)
beforeEach(() => h.reset())

// ── The words are forms' own ──────────────────────────────────────────────────────────────────────────────────────────────

// The contract's list is a copy (the layer cannot import forms). Two checks, one for each place forms keeps its words: the type
// (a status added there fails the build here) and the schema's CHECK (the database refuses anything else).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const documentStateIsEnvelopeStatus: Same<DocumentState, EnvelopeStatus> = true

describe('the contract’s document states are forms’ own', () => {
  test('equal to EnvelopeStatus as a type, and to the statuses the envelopes table accepts', () => {
    expect(documentStateIsEnvelopeStatus).toBe(true)
    const schema = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8')
    const check = /CREATE TABLE envelopes \([\s\S]*?status\s+TEXT NOT NULL DEFAULT 'draft' CHECK \(status IN \(([^)]*)\)\)/.exec(schema)![1]!
    const inSchema = [...check.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!)
    expect([...DOCUMENT_STATES].sort()).toEqual(inSchema.sort() as DocumentState[])
  })
})

// ── The reads ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

function deps(over: Partial<SpaceReadDeps> = {}): SpaceReadDeps {
  return { db: h.env().DB, install: h.install, ...over }
}
/** The person the space's check would have named, for an address of the given install (Northfield's by default). */
const asking = async (claims: { email: string } = { email: 'tessa@northfield.example' }, install: Install = h.install): Promise<SignedIn> => {
  const person = [install, h.install, laneInstall()].flatMap((i) => i.people).find((p) => p.address === claims.email)
  if (!person) throw new Error(`no such person: ${claims.email}`)
  return signedIn(person, 4_000_000_000)
}

async function exec(sql: string, ...binds: unknown[]) {
  await h.env().DB.prepare(sql).bind(...binds).run()
}

describe('documents', () => {
  test('lists every document newest first with its title, state, signers and who has not signed', async () => {
    const sent = await k.sent({ recipients: [ALICE, BOB] })
    const draft = await k.draft({ client: sent.client, recipients: [BOB] })
    const out = await documents(deps(), await asking())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.more).toBe(false)
    const byId = new Map(out.value.documents.map((d) => [d.id, d]))
    expect(byId.get(sent.id)).toMatchObject({ id: sent.id, state: 'sent', signers: 2, signed: 0, notSigned: ['Alice Example', 'Bob Preparer'] })
    expect(typeof byId.get(sent.id)!.createdAt).toBe('number')
    expect(byId.get(sent.id)!.sentAt).not.toBeNull()
    expect(byId.get(sent.id)!.completedAt).toBeNull()
    expect(byId.get(draft.id)).toMatchObject({ state: 'draft', sentAt: null, signers: 1, notSigned: ['Bob Preparer'] })
    expect(out.value.documents.map((d) => d.title).every((t) => typeof t === 'string' && t !== '')).toBe(true)
  })

  test('says who has not signed after someone has, in signing order, and counts those who have', async () => {
    const sent = await k.sent({ recipients: [ALICE, BOB] })
    await exec("UPDATE recipients SET status = 'signed', signed_at = ? WHERE envelope_id = ? AND email = ?", '2026-10-31T20:00:00.000Z', sent.id, ALICE.email)
    const out = await documentsOn(deps(), await asking(), [BOB.email])
    expect(out.ok && out.value.documents[0]).toMatchObject({ id: sent.id, signers: 2, signed: 1, notSigned: ['Bob Preparer'] })
    await exec("UPDATE recipients SET status = 'signed' WHERE envelope_id = ?", sent.id)
    const done = await documents(deps(), await asking(), { states: ['sent'] })
    expect(done.ok && done.value.documents.find((d) => d.id === sent.id)?.notSigned).toEqual([])
  })

  test('filters by state and by time, and says when there is more than the limit', async () => {
    const a = await k.sent({ recipients: [ALICE] })
    await k.draft({ client: a.client, recipients: [BOB] })
    await k.draft({ client: a.client, recipients: [BOB] })
    const sentOnly = await documents(deps(), await asking(), { states: ['sent'] })
    expect(sentOnly.ok && sentOnly.value.documents.map((d) => d.state)).toEqual(['sent'])
    const two = await documents(deps(), await asking(), { limit: 2 })
    expect(two.ok && [two.value.documents.length, two.value.more]).toEqual([2, true])
    const all = await documents(deps(), await asking(), { limit: 3 })
    expect(all.ok && [all.value.documents.length, all.value.more]).toEqual([3, false])
    // The harness clock is 2026-10-31 13:00 Pacific; nothing was made after the next day, everything since the day before.
    const later = await documents(deps(), await asking(), { since: Date.parse('2026-11-02T00:00:00Z') })
    expect(later.ok && later.value.documents).toEqual([])
    const earlier = await documents(deps(), await asking(), { since: Date.parse('2026-10-30T00:00:00Z') })
    expect(earlier.ok && earlier.value.documents.length).toBe(3)
  })
})

describe('documentsOn: every address goes through the layer’s spelling', () => {
  test('a recipient stored as " Alice@Example.TEST " is found by "alice@example.test", and by the spellings normalizeAddress reads as it', async () => {
    const sent = await k.sent({ recipients: [ALICE, BOB] })
    await exec('UPDATE recipients SET email = ? WHERE envelope_id = ? AND position = 1', ' Alice@Example.TEST ', sent.id)
    for (const spelled of ['alice@example.test', 'ALICE@EXAMPLE.TEST', ' alice@example.test ', 'Alice Example <Alice@Example.test>']) {
      expect(normalizeAddress(spelled)).toBe('alice@example.test') // the spelling the layer gives it
      const out = await documentsOn(deps(), await asking(), [spelled])
      expect([spelled, out.ok && out.value.documents.map((d) => d.id)]).toEqual([spelled, [sent.id]])
    }
  })

  test('finds a copy recipient too, and joins several addresses of one person without listing a document twice', async () => {
    const sent = await k.sent({ recipients: [ALICE, BOB], extra: {} })
    const out = await documentsOn(deps(), await asking(), ['alice@example.test', 'bob@example.test', 'books@pinecrest.example'])
    expect(out.ok && out.value.documents.map((d) => d.id)).toEqual([sent.id])
  })

  test('an entry that names no email address (a phone number, a handle, a list) matches nothing, and is not a way to match everything', async () => {
    await k.sent({ recipients: [ALICE, BOB] })
    for (const odd of ['+15551234567', 'alice', '', '@', 'alice@example.test, bob@example.test', 'a b@example.test']) {
      expect(normalizeAddress(odd)).toBeNull()
      const out = await documentsOn(deps(), await asking(), [odd])
      expect([odd, out.ok && out.value.documents]).toEqual([odd, []])
    }
    const none = await documentsOn(deps(), await asking(), [])
    expect(none.ok && none.value).toEqual({ documents: [], more: false })
  })

  test('a person with no documents has none, and another person’s documents are not theirs', async () => {
    await k.sent({ recipients: [ALICE] })
    const out = await documentsOn(deps(), await asking(), ['carol@example.test'])
    expect(out.ok && out.value.documents).toEqual([])
  })

  test('a list too long to be one person’s is refused', async () => {
    const out = await documentsOn(deps(), await asking(), Array.from({ length: 51 }, (_, i) => `p${i}@example.test`))
    expect(out).toMatchObject({ ok: false, kind: 'refused', reason: 'bad-request' })
  })
})

describe('what a read never returns', () => {
  test('a summary is exactly these fields, and nothing a document holds', async () => {
    const sent = await k.sent({ recipients: [ALICE, BOB] })
    const out = await documents(deps(), await asking())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    for (const d of out.value.documents) {
      expect(Object.keys(d).sort()).toEqual(['completedAt', 'conversation', 'createdAt', 'id', 'notSigned', 'sentAt', 'signed', 'signers', 'state', 'title'])
    }
    const text = JSON.stringify(out)
    for (const secret of [ALICE.email, BOB.email, 'books@pinecrest.example', k.tokenFor(ALICE.email), 'wrapped', 'prepared_key', 'finished_key', sent.client.id]) {
      expect(text, secret).not.toContain(secret)
    }
  })

  test('the reads never touch the tables that hold an answer, a value, a signature, a token or a key', () => {
    const source = readFileSync(new URL('../src/space-reads.ts', import.meta.url), 'utf8')
    const sql = [...source.matchAll(/(?:FROM|JOIN)\s+([a-z_]+)/g)].map((m) => m[1])
    expect([...new Set(sql)].sort()).toEqual(['envelopes', 'recipients'])
    expect(source.replace(/^\s*\/\/.*$/gm, "")).not.toMatch(/SELECT\s+\*/i)
    for (const column of ['token_hash', 'token_enc', 'wrapped_key', 'prepared_key', 'finished_key']) expect(source, column).not.toContain(column)
  })
})

describe('who may ask', () => {
  test('a person of another company, though the space signed them in, is not admitted', async () => {
    const out = await documents(deps(), await asking({ email: 'lane@pinecrest.test' }))
    expect(out).toMatchObject({ ok: false, kind: 'refused', reason: 'not-admitted' })
  })

  test('a second company’s forms admits its own people and refuses Northfield’s', async () => {
    const second = harness({}, laneInstall())
    const asks = async (claims: { email: string }) => asking(claims, second.install)
    const d = { db: second.env().DB, install: second.install }
    expect((await documents(d, await asks({ email: 'lane@pinecrest.test' }))).ok).toBe(true)
    expect(await documents(d, await asks({ email: 'tessa@northfield.example' }))).toMatchObject({ ok: false, reason: 'not-admitted' })
    expect(await documentsIn(d, await asks({ email: 'tessa@northfield.example' }), [{ app: 'inbox', id: 'c-alice' }])).toMatchObject({ ok: false, reason: 'not-admitted' })
  })

  test('a query that is not the shape is a bad request, with a sentence', async () => {
    for (const query of [{ states: ['sent', 'shipped'] }, { states: 'sent' }, { since: -1 }, { since: 'yesterday' }, { limit: 0 }, { limit: 1.5 }, 'all', []]) {
      const out = await documents(deps(), await asking(), query as never)
      expect([JSON.stringify(query), out]).toMatchObject([JSON.stringify(query), { ok: false, kind: 'refused', reason: 'bad-request' }])
      if (!out.ok) expect(out.message.length).toBeGreaterThan(5)
    }
  })

  test('a fault in the store is "broken", as data, and not an exception across the binding', async () => {
    const broken = { prepare: () => { throw new Error('D1 is down') }, batch: async () => [] } as never
    const out = await documents(deps({ db: broken }), await asking())
    expect(out).toMatchObject({ ok: false, kind: 'failed', reason: 'broken' })
    expect(JSON.stringify(out)).not.toContain('D1 is down')
  })
})

// ── Documents in a conversation ────────────────────────────────────────────────────────────────────────────────────

const DANA: ConversationRef = { app: 'inbox', id: 'c-dana' }
const DANA_DM: ConversationRef = { app: 'meet', id: '12' }

/** A draft sent from a conversation, through the real admin API, as the space's Send screen makes it. */
async function sentFrom(conversation: ConversationRef | null, opts: Parameters<typeof k.sent>[0] = {}) {
  return k.sent({ ...opts, extra: { ...opts.extra, ...(conversation && { conversation }) } })
}

describe('a document sent from a conversation carries its link', () => {
  test('the link is stored with the envelope and shown on the envelope the operator reads, and is in no event', async () => {
    const made = await sentFrom(DANA, { recipients: [ALICE] })
    expect(h.sql<{ conversation_app: string; conversation_id: string }>('SELECT conversation_app, conversation_id FROM envelopes WHERE id = ?', made.id)).toEqual([{ conversation_app: 'inbox', conversation_id: 'c-dana' }])
    // Every event is sealed into the PDF each signer receives: an internal id of the space has no place in one. The link lives in the envelope's columns only.
    expect(JSON.stringify(k.events(made.id))).not.toContain('c-dana')
    const view = await h.tessa('GET', `/admin/api/envelopes/${made.id}`)
    expect(view.body.envelope).toMatchObject({ conversation_app: 'inbox', conversation_id: 'c-dana' })
    const list = await h.tessa('GET', '/admin/api/envelopes')
    expect(list.body[0]).toMatchObject({ conversation_app: 'inbox', conversation_id: 'c-dana' })
  })

  test('one sent from Forms carries none, and its created event is exactly the one it always was', async () => {
    const made = await sentFrom(null, { recipients: [ALICE] })
    expect(h.sql('SELECT conversation_app, conversation_id FROM envelopes WHERE id = ?', made.id)).toEqual([{ conversation_app: null, conversation_id: null }])
    expect(JSON.parse(k.events(made.id)[0]!.details)).not.toHaveProperty('conversation')
  })

  test('the finished document every signer is sent, and its certificate, never carry the conversation', async () => {
    const made = await sentFrom(DANA, { recipients: [ALICE] })
    await k.signAs(k.tokenFor(ALICE.email), ALICE.name)
    const pdf = await k.text(k.attachment(ALICE.email))
    expect(pdf).not.toContain('c-dana')
    expect(pdf).not.toContain('inbox')
    const cert = await h.tessa('GET', `/admin/api/envelopes/${made.id}/certificate`)
    expect(cert.status).toBe(200)
    expect(JSON.stringify(cert.body)).not.toContain('c-dana')
    expect(JSON.stringify(k.events(made.id))).not.toContain('c-dana')
  })

  test('a conversation that is not an app and an id is refused before anything is stored', async () => {
    const client = await h.makeClient()
    for (const conversation of [{ app: 'slack', id: 'x' }, { app: 'inbox' }, { app: 'inbox', id: '' }, { app: 'inbox', id: 'a b' }, { app: 'meet', id: 'x'.repeat(201) }, 'inbox:c-dana', [DANA]]) {
      const r = await h.tessa('POST', '/admin/api/envelopes', { client_id: client.id, source: { type: 'sample' }, recipients: [ALICE], conversation })
      expect([JSON.stringify(conversation), r.status]).toEqual([JSON.stringify(conversation), 400])
    }
    expect(h.sql('SELECT id FROM envelopes')).toEqual([])
  })

  test('a draft edit cannot move it to another conversation', async () => {
    const made = await k.draft({ recipients: [ALICE], extra: { conversation: DANA } })
    await h.tessa('PATCH', `/admin/api/envelopes/${made.id}`, { conversation: DANA_DM, title: 'Renamed' })
    expect(h.sql('SELECT conversation_app, conversation_id, title FROM envelopes WHERE id = ?', made.id)).toEqual([{ conversation_app: 'inbox', conversation_id: 'c-dana', title: 'Renamed' }])
  })

  test('forms’ own schema holds a link as both halves or none', async () => {
    const made = await sentFrom(null, { recipients: [ALICE] })
    await expect(exec("UPDATE envelopes SET conversation_id = 'c-dana' WHERE id = ?", made.id)).rejects.toThrow()
    await expect(exec("UPDATE envelopes SET conversation_app = 'inbox' WHERE id = ?", made.id)).rejects.toThrow() // the app with no id
    await expect(exec("UPDATE envelopes SET conversation_app = 'slack', conversation_id = 'x' WHERE id = ?", made.id)).rejects.toThrow()
    await expect(exec("UPDATE envelopes SET conversation_app = 'inbox', conversation_id = '' WHERE id = ?", made.id)).rejects.toThrow()
  })
})

describe('documentsIn', () => {
  test('lists the documents that carry the conversation and no other: not one sent from Forms to the same person, not another conversation’s', async () => {
    const here = await sentFrom(DANA, { recipients: [ALICE] })
    const fromForms = await sentFrom(null, { client: here.client, recipients: [ALICE] })
    const elsewhere = await sentFrom({ app: 'inbox', id: 'c-other' }, { client: here.client, recipients: [ALICE] })
    const out = await documentsIn(deps(), await asking(), [DANA])
    expect(out.ok && out.value.documents.map((d) => d.id)).toEqual([here.id])
    expect(out.ok && out.value.documents[0]).toMatchObject({ conversation: DANA, state: 'sent', signers: 1, signed: 0 })
    // The Forms-sent one is the person's (documentsOn) and not the conversation's.
    const person = await documentsOn(deps(), await asking(), [ALICE.email])
    expect(person.ok && person.value.documents.map((d) => d.id).sort()).toEqual([here.id, fromForms.id, elsewhere.id].sort())
    expect(person.ok && person.value.documents.find((d) => d.id === fromForms.id)?.conversation).toBeNull()
  })

  test('a conversation is every ref it has: a document is found by the mail side or by the direct message', async () => {
    const mail = await sentFrom(DANA, { recipients: [ALICE] })
    const chat = await sentFrom(DANA_DM, { client: mail.client, recipients: [ALICE] })
    const both = await documentsIn(deps(), await asking(), [DANA, DANA_DM])
    expect(both.ok && both.value.documents.map((d) => d.id).sort()).toEqual([mail.id, chat.id].sort())
    const onlyChat = await documentsIn(deps(), await asking(), [DANA_DM])
    expect(onlyChat.ok && onlyChat.value.documents.map((d) => d.id)).toEqual([chat.id])
    // The same id in the other app is not the same conversation.
    const other = await documentsIn(deps(), await asking(), [{ app: 'meet', id: 'c-dana' }])
    expect(other.ok && other.value.documents).toEqual([])
  })

  test('a completed one says so, with the time it came back', async () => {
    const made = await sentFrom(DANA, { recipients: [ALICE] })
    await k.signAs(k.tokenFor(ALICE.email), ALICE.name)
    const out = await documentsIn(deps(), await asking(), [DANA])
    expect(out.ok && out.value.documents[0]).toMatchObject({ id: made.id, state: 'completed', signers: 1, signed: 1, notSigned: [] })
    expect(out.ok && out.value.documents[0]!.completedAt).not.toBeNull()
  })

  test('a document holding a private answer shows its title and state, exactly as any other, and nothing it holds', async () => {
    const made = await sentFrom(DANA, { recipients: [ALICE], extra: { sensitive: true } })
    await exec("INSERT INTO answers (envelope_id, client_id, question_id, value_enc, answered_at) VALUES (?, ?, 'q4', 'SENTINEL-123-45-6789', '2026-10-31T20:00:00.000Z')", made.id, made.client.id)
    const out = await documentsIn(deps(), await asking(), [DANA])
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(Object.keys(out.value.documents[0]!).sort()).toEqual(['completedAt', 'conversation', 'createdAt', 'id', 'notSigned', 'sentAt', 'signed', 'signers', 'state', 'title'])
    const text = JSON.stringify(out)
    for (const secret of ['SENTINEL', '123-45', 'q4', ALICE.email, k.tokenFor(ALICE.email), made.client.id]) expect(text, secret).not.toContain(secret)
  })

  test('refs that forms could not have stored match nothing, and a list too long is refused', async () => {
    await sentFrom(DANA, { recipients: [ALICE] })
    const odd = await documentsIn(deps(), await asking(), [{ app: 'slack', id: 'c-dana' }, { app: 'inbox', id: "c-dana' OR 1=1 --" }, null, 'inbox:c-dana'] as never)
    expect(odd.ok && odd.value).toEqual({ documents: [], more: false })
    expect(await documentsIn(deps(), await asking(), [])).toMatchObject({ ok: true, value: { documents: [], more: false } })
    const long = await documentsIn(deps(), await asking(), Array.from({ length: 21 }, (_, i) => ({ app: 'inbox' as const, id: `c-${i}` })))
    expect(long).toMatchObject({ ok: false, kind: 'refused', reason: 'bad-request' })
  })

  test('a second company’s forms reads its own documents in a conversation, and nothing of Northfield’s', async () => {
    const second = harness({}, laneInstall())
    const kk = kit(second)
    const d = { db: second.env().DB, install: second.install }
    const asks = async (claims: { email: string }) => asking(claims, second.install)
    const made = await kk.sent({ recipients: [ALICE], extra: { conversation: DANA } })
    const out = await documentsIn(d, await asks({ email: 'lane@pinecrest.test' }), [DANA])
    expect(out.ok && out.value.documents.map((x) => x.id)).toEqual([made.id])
    expect(out.ok && out.value.documents[0]!.conversation).toEqual(DANA)
    expect(await documentsIn(d, await asks({ email: 'tessa@northfield.example' }), [DANA])).toMatchObject({ ok: false, reason: 'not-admitted' })
    // Northfield's own store holds none of it.
    const mine = await documentsIn(deps(), await asking(), [DANA])
    expect(mine.ok && mine.value.documents).toEqual([])
  })

  test('filters by state and limit as the other reads do', async () => {
    const a = await sentFrom(DANA, { recipients: [ALICE] })
    await k.draft({ client: a.client, recipients: [BOB], extra: { conversation: DANA } })
    const sentOnly = await documentsIn(deps(), await asking(), [DANA], { states: ['sent'] })
    expect(sentOnly.ok && sentOnly.value.documents.map((d) => d.state)).toEqual(['sent'])
    const one = await documentsIn(deps(), await asking(), [DANA], { limit: 1 })
    expect(one.ok && [one.value.documents.length, one.value.more]).toEqual([1, true])
  })
})

describe('the migration is additive', () => {
  test('envelopes made before it keep every column and have no conversation', () => {
    const db = new Database(':memory:')
    const dir = new URL('../migrations/', import.meta.url)
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    expect(files[3]).toBe('0004_conversation.sql')
    for (const f of files.slice(0, 3)) db.run(readFileSync(new URL(f, dir), 'utf8'))
    db.run("INSERT INTO clients (id, slug, display_name, legal_name, accent_color, reply_to, created_at, updated_at) VALUES ('c', 'cc', 'C', 'C Inc', '#112233', 'a@b.example', 'now', 'now')")
    db.run("INSERT INTO envelopes (id, client_id, kind, title, wrapped_key, key_version, created_by, created_at) VALUES ('e1', 'c', 'document', 'Before', 'w', 1, 'x', 'now')")
    db.run(readFileSync(new URL(files[3]!, dir), 'utf8'))
    expect(db.query('SELECT id, title, conversation_app, conversation_id FROM envelopes').all()).toEqual([{ id: 'e1', title: 'Before', conversation_app: null, conversation_id: null }])
  })
})
