// What forms answers the space (the reads behind the Forms tab), as plain functions over a database, called IN-PROCESS by the space's Worker
// (`createSpaceForms` below; they were once an entrypoint, `SpaceForms`, behind
// a service binding), so `bun test` drives them without the Workers runtime. The shapes are the company layer's (`FormsForSpace`,
// packages/workspace/src/forms-for-space.ts) and the rule is its ADR 0003: the space verified the sign-in once and hands each read the person
// it named (`SignedIn`), so a read verifies nothing itself and only applies forms' own rule: the person must be an operator
// (`operatorOf`), which is any person of the install.
//
// WHAT A READ NEVER RETURNS. A document's title and state, when it moved, how many signers it has and have signed, and the NAMES
// of the signers who have not. Nothing it holds: no answer (private or not, the answers table is not read at all), no recipient's
// address, link or token, no file name or key, no finished document. An envelope with a private question shows exactly what any
// other does. The SQL below names its columns; nothing is `SELECT *`.
//
// CONVERSATIONS. `documentsIn` finds the envelopes that carry one of the conversations it is given (migration 0004: `conversation_app`,
// `conversation_id`), and only those: a document to the same person sent from Forms carries none and is `documentsOn`'s. Every summary names the
// conversation it carries, which is a pair of ids and nothing else.
//
// ADDRESSES. A query's addresses go through the layer's `normalizeAddress` on the way in, and a recipient is matched case-blind
// and trimmed (`lower(trim(email))`), so "Ines@X.example.com" stored is found by "ines@x.example.com". No address is returned, so nothing needs
// to be spelled on the way out.

import {
  type ConversationApp,
  type ConversationRef,
  MOST_CONVERSATION_REFS,
  type Documents,
  type DocumentsQuery,
  type DocumentState,
  type DocumentSummary,
  DOCUMENT_STATES,
  type FormsForSpace,
  type Install,
  type SignedIn,
  type SpaceReply,
  answered,
  failed,
  isConversationRef,
  NOT_ADMITTED,
  normalizeAddress,
  refused,
} from '@space/workspace'
import { type Db, isoAt } from './records'
import { operatorOf } from './workspace'

export interface SpaceReadDeps {
  db: Db
  install: Install
}

const DEFAULT_LIMIT = 100
/** The admin list's cap (`listEnvelopes`). */
const MAX_LIMIT = 500
/** D1 allows 100 bound values in a statement; a person has a handful of addresses. */
const MAX_ADDRESSES = 50

interface EnvelopeRow {
  id: string
  title: string
  status: string
  created_at: string
  sent_at: string | null
  completed_at: string | null
  conversation_app: ConversationApp | null
  conversation_id: string | null
}

interface SignerRow {
  envelope_id: string
  name: string
  status: string
}

const ms = (iso: string | null): number | null => {
  if (iso === null) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/** The query as forms understands it, or the sentence that says what is wrong with it. */
function readQuery(q: unknown): { states: DocumentState[] | null; since: number | null; limit: number } | string {
  if (q === undefined || q === null) return { states: null, since: null, limit: DEFAULT_LIMIT }
  if (typeof q !== 'object' || Array.isArray(q)) return 'The query is not an object.'
  const { states, since, limit } = q as Record<string, unknown>
  let wanted: DocumentState[] | null = null
  if (states !== undefined) {
    if (!Array.isArray(states) || states.some((s) => !(DOCUMENT_STATES as readonly unknown[]).includes(s))) return `States are among: ${DOCUMENT_STATES.join(', ')}.`
    wanted = [...new Set(states as DocumentState[])]
  }
  if (since !== undefined && (typeof since !== 'number' || !Number.isFinite(since) || since < 0)) return '`since` is a time in milliseconds.'
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) return '`limit` is a whole number of documents, at least one.'
  return { states: wanted, since: typeof since === 'number' ? since : null, limit: Math.min(typeof limit === 'number' ? limit : DEFAULT_LIMIT, MAX_LIMIT) }
}

/** Forms' own rule, the only step left of every read: the person the space named must be an operator, which is anyone of THIS install. */
function admitted(d: SpaceReadDeps, asker: SignedIn): SpaceReply<never> | null {
  // The space's check has named a person of its own install; forms is deployed with the same declaration, so a person it does not list is a mismatch worth refusing.
  if (d.install.person(asker.person.address) === null) return refused('not-admitted', NOT_ADMITTED)
  operatorOf(asker.person, d.install) // every person of the install is an operator; named so a narrower rule has one place to go
  return null
}

async function summaries(d: SpaceReadDeps, where: string, binds: unknown[], q: { states: DocumentState[] | null; since: number | null; limit: number }): Promise<Documents> {
  const clauses = [where]
  const values = [...binds]
  if (q.states) {
    clauses.push(`e.status IN (${q.states.map(() => '?').join(', ')})`)
    values.push(...q.states)
  }
  if (q.since !== null) {
    const at = isoAt(q.since)
    clauses.push('(e.created_at >= ? OR e.sent_at >= ? OR e.completed_at >= ?)')
    values.push(at, at, at)
  }
  // One more than asked, to know whether there is more.
  const rows = (
    await d.db
      .prepare(`SELECT e.id, e.title, e.status, e.created_at, e.sent_at, e.completed_at, e.conversation_app, e.conversation_id FROM envelopes e WHERE ${clauses.join(' AND ')} ORDER BY e.created_at DESC, e.id LIMIT ?`)
      .bind(...values, q.limit + 1)
      .all<EnvelopeRow>()
  ).results
  const page = rows.slice(0, q.limit)
  const signers = new Map<string, SignerRow[]>()
  if (page.length > 0) {
    const found = (
      await d.db
        .prepare(`SELECT envelope_id, name, status FROM recipients WHERE kind = 'signer' AND envelope_id IN (${page.map(() => '?').join(', ')}) ORDER BY envelope_id, position`)
        .bind(...page.map((r) => r.id))
        .all<SignerRow>()
    ).results
    for (const s of found) signers.set(s.envelope_id, [...(signers.get(s.envelope_id) ?? []), s])
  }
  return {
    documents: page.map((r): DocumentSummary => {
      const all = signers.get(r.id) ?? []
      return {
        id: r.id,
        title: r.title,
        state: r.status as DocumentState,
        createdAt: ms(r.created_at) ?? 0,
        sentAt: ms(r.sent_at),
        completedAt: ms(r.completed_at),
        signers: all.length,
        signed: all.filter((s) => s.status === 'signed').length,
        notSigned: all.filter((s) => s.status !== 'signed').map((s) => s.name),
        conversation: r.conversation_app !== null && r.conversation_id !== null ? { app: r.conversation_app, id: r.conversation_id } : null,
      }
    }),
    more: rows.length > q.limit,
  }
}

/** Every document, newest first, for Today: drafts, out for signature, signed and back. */
export async function documents(d: SpaceReadDeps, asker: SignedIn, query?: DocumentsQuery): Promise<SpaceReply<Documents>> {
  try {
    const no = admitted(d, asker)
    if (no) return no
    const q = readQuery(query)
    if (typeof q === 'string') return refused('bad-request', q)
    return answered(await summaries(d, '1 = 1', [], q))
  } catch (e) {
    console.error('space read failed', e)
    return failed('Forms could not read its documents.')
  }
}

/** The documents any of these addresses is a recipient of (a signer or a copy), newest first. */
export async function documentsOn(d: SpaceReadDeps, asker: SignedIn, addresses: readonly string[], query?: DocumentsQuery): Promise<SpaceReply<Documents>> {
  try {
    const no = admitted(d, asker)
    if (no) return no
    if (!Array.isArray(addresses) || addresses.length > MAX_ADDRESSES) return refused('bad-request', `Name up to ${MAX_ADDRESSES} addresses.`)
    const q = readQuery(query)
    if (typeof q === 'string') return refused('bad-request', q)
    // An entry that names no email address (a phone number, a handle) can match no recipient and is left out.
    const wanted = [...new Set(addresses.map(normalizeAddress).filter((a): a is string => a !== null))]
    if (wanted.length === 0) return answered({ documents: [], more: false })
    return answered(await summaries(d, `e.id IN (SELECT envelope_id FROM recipients WHERE lower(trim(email)) IN (${wanted.map(() => '?').join(', ')}))`, wanted, q))
  } catch (e) {
    console.error('space read failed', e)
    return failed('Forms could not read its documents.')
  }
}

/** The documents sent from any of these conversations, newest first. A ref that is not an app and an id forms could have stored is left out. */
export async function documentsIn(d: SpaceReadDeps, asker: SignedIn, conversations: readonly ConversationRef[], query?: DocumentsQuery): Promise<SpaceReply<Documents>> {
  try {
    const no = admitted(d, asker)
    if (no) return no
    if (!Array.isArray(conversations) || conversations.length > MOST_CONVERSATION_REFS) return refused('bad-request', `Name up to ${MOST_CONVERSATION_REFS} conversations.`)
    const q = readQuery(query)
    if (typeof q === 'string') return refused('bad-request', q)
    const wanted = conversations.filter(isConversationRef)
    if (wanted.length === 0) return answered({ documents: [], more: false })
    return answered(await summaries(d, `(${wanted.map(() => '(e.conversation_app = ? AND e.conversation_id = ?)').join(' OR ')})`, wanted.flatMap((c) => [c.app, c.id]), q))
  } catch (e) {
    console.error('space read failed', e)
    return failed('Forms could not read its documents.')
  }
}

/** The reads as the space calls them: one object over forms' database, made once per request from the Worker's binding. */
export function createSpaceForms(d: SpaceReadDeps): FormsForSpace {
  return {
    documents: (asker, query) => documents(d, asker, query),
    documentsOn: (asker, addresses, query) => documentsOn(d, asker, addresses, query),
    documentsIn: (asker, conversations, query) => documentsIn(d, asker, conversations, query),
  }
}
