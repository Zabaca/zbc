/**
 * What every part of the signing core shares: who is acting, what the core is built from, the rows it reads, the errors it
 * raises and the guarded batch every state change is written with.
 */
import type { ConversationApp } from '@space/workspace'
import { HTTPException } from 'hono/http-exception'
import { type EventInput, describeDevice } from '../events'
import type { Mailer } from '../mail'
import type { Db, Row, Stmt } from '../records'
import type { Sealer } from '../seal/sealer'
import type { ServiceWords } from '../service'
import { SENSITIVE_LINK_DAYS } from '../settings'
import { notFound } from '../store'
import type { FieldType } from '../fields'
import type { AdoptionKind, AdoptionMethod, EnvelopeStatus, RecipientStatus } from '../vocab'
import type { ObjectStore, Vault } from '../vault'
import { decryptText } from '../vault'

/** Who is acting. An agent (Claude's tool) acts only on the owner's recorded word; the system is the cron. */
export type Actor =
  | { kind: 'operator'; email: string; name: string }
  | { kind: 'agent'; /** `agent:forms api (claude)`: its service token's name. */ label: string; /** Whose word it acts on. */ onWordOf: string }
  | { kind: 'system' }
  | { kind: 'recipient'; id: string; email: string; name: string }

export interface Origin {
  ip?: string | null
  userAgent?: string | null
}

export interface CoreDeps {
  db: Db
  files: ObjectStore
  vault: Vault
  /** Null when the Worker has no email binding: mail is recorded and fails with that reason. */
  mailer: Mailer | null
  /** Loaded when a document is sealed, so a Worker without a seal can still send and sign up to that point. */
  sealer: () => Promise<Sealer>
  /** Who is told when an envelope completes, is declined or expires: the install's owner (src/workspace.ts). */
  notice: { email: string; name: string }
  /** The install's owner as the words of a refusal, a record and a certificate name them (src/workspace.ts `ownerOf`): "Tessa", "Tessa Marlow" and their address. */
  owner: { name: string; mailName: string; address: string }
  /** The install's names for the service and who runs it, which every email, consent, certificate and seal says (src/service.ts). */
  service: ServiceWords
  /** The space's address, for links inside an email (signers use its `/s/` path): the install's space host. */
  origin: string
  now: () => number
}

export const refused = (message: string) => new HTTPException(403, { message })
export const gone = (message: string) => new HTTPException(410, { message })
/** One message for every link that does not lead anywhere, so a guess learns nothing. */
export const invalidLink = () => new HTTPException(404, { message: 'This link is not valid. If you were expecting a document, ask the business that sent it.' })

/** Throws unless the actor is a person of the install. What an agent's token can never do goes through here. */
export function requireOperator(actor: Actor, what: string): asserts actor is Extract<Actor, { kind: 'operator' }> {
  if (actor.kind !== 'operator') throw refused(`Only an operator can ${what}.`)
}

export interface ClientRow {
  id: string
  slug: string
  display_name: string
  legal_name: string
  accent_color: string
  logo_key: string | null
  logo_type: 'image/png' | 'image/jpeg' | null
  logo_sha256: string | null
  reply_to: string
  copy_addresses: string
  time_zone: string
  retention_years: number
}

export interface EnvelopeRow {
  id: string
  client_id: string
  kind: 'form' | 'document'
  form_version_id: string | null
  source_document_id: string | null
  title: string
  status: EnvelopeStatus
  order_mode: 'sequential' | 'parallel'
  note: string | null
  expires_at: string | null
  expires_in_days: number
  reminder_every_days: number
  reminder_max: number
  sensitive: number
  typed_only: number
  /** The conversation it was sent from (migration 0004): both set or both null. */
  conversation_app: ConversationApp | null
  conversation_id: string | null
  /** The business's names as the envelope was sent (migration 0006): both set by send, or both null for an envelope sent before it. */
  client_display_name: string | null
  client_legal_name: string | null
  created_by: string
  sent_by: string | null
  created_at: string
  sent_at: string | null
  prepared_key: string | null
  prepared_sha256: string | null
  prepared_size: number | null
  finished_key: string | null
  finished_sha256: string | null
  finished_size: number | null
  wrapped_key: string
  key_version: number
  completed_at: string | null
  sealing_at: string | null
  sealing_attempts: number
  purge_at: string | null
}

export interface RecipientRow {
  id: string
  envelope_id: string
  client_id: string
  role: string
  name: string
  email: string
  kind: 'signer' | 'copy'
  position: number
  token_hash: string | null
  token_enc: string | null
  status: RecipientStatus
  consent_version: string | null
  consent_at: string | null
  opened_at: string | null
  signed_at: string | null
  declined_at: string | null
  decline_reason: string | null
  reminder_count: number
  last_reminded_at: string | null
  notified_at: string | null
  values_version: number
  created_at: string
}

/** The client's copy addresses as stored (the clients table keeps a JSON list). */
export const copyAddressesOf = (client: Pick<ClientRow, 'copy_addresses'>): string[] => {
  try {
    return JSON.parse(client.copy_addresses) as string[]
  } catch {
    return []
  }
}

/** Whether a recipient is one of the client's own copy addresses, as against anyone else an operator added as a copy. */
export const isClientCopy = (client: Pick<ClientRow, 'copy_addresses'>, r: Pick<RecipientRow, 'kind' | 'email'>): boolean => r.kind === 'copy' && copyAddressesOf(client).some((a) => a.toLowerCase() === r.email.toLowerCase())

export interface FieldRow {
  id: string
  envelope_id: string
  client_id: string
  recipient_id: string
  type: FieldType
  page: number
  x: number
  y: number
  width: number
  height: number
  required: number
  label: string | null
  pdf_field_name: string | null
}

export interface AdoptionRow {
  id: string
  envelope_id: string
  recipient_id: string
  kind: AdoptionKind
  method: AdoptionMethod
  image_key: string | null
  image_sha256: string | null
  typed_text: string | null
  typed_font: string | null
  adopted_at: string
}

/** The statuses an envelope is live in: a signer may act and a reminder may go. */
export const LIVE: EnvelopeStatus[] = ['sent', 'prepared']
/** A recipient who may act now. */
export const ACTING: RecipientStatus[] = ['sent', 'opened', 'consented']

export const isoAt = (ms: number) => new Date(ms).toISOString()
export const addDays = (ms: number, days: number) => ms + days * 86_400_000

/** When an envelope's private links (the finished document, the certificate, a client copy's uploads) stop working, in ms; 0 before it is completed, so nothing is live. */
export const linkEndsAt = (e: Pick<EnvelopeRow, 'completed_at'>): number => (e.completed_at ? addDays(Date.parse(e.completed_at), SENSITIVE_LINK_DAYS) : 0)

export async function loadEnvelope(db: Db, id: string): Promise<EnvelopeRow> {
  const row = await db.prepare('SELECT * FROM envelopes WHERE id = ?').bind(id).first<EnvelopeRow>()
  if (!row) throw notFound('Envelope')
  return row
}

export async function loadClient(db: Db, id: string): Promise<ClientRow> {
  const row = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first<ClientRow>()
  if (!row) throw notFound('Client')
  return row
}

/**
 * The client as THIS envelope prints it: the names it was sent under (migration 0006), so a rename of the business after the send changes nothing a signer was shown or a certificate prints. An envelope sent before the
 * snapshot existed has none and prints the row as it is now (`snapshot` false, which the certificate's consent note says).
 */
export function printedAs(e: Pick<EnvelopeRow, 'client_display_name' | 'client_legal_name'>, client: ClientRow): { client: ClientRow; snapshot: boolean } {
  if (e.client_display_name === null || e.client_legal_name === null) return { client, snapshot: false }
  return { client: { ...client, display_name: e.client_display_name, legal_name: e.client_legal_name }, snapshot: true }
}

export async function loadRecipients(db: Db, envelopeId: string): Promise<RecipientRow[]> {
  return (await db.prepare('SELECT * FROM recipients WHERE envelope_id = ? ORDER BY position').bind(envelopeId).all<RecipientRow>()).results
}

export async function loadFields(db: Db, envelopeId: string): Promise<FieldRow[]> {
  return (await db.prepare('SELECT * FROM fields WHERE envelope_id = ? ORDER BY page, y, x').bind(envelopeId).all<FieldRow>()).results
}

/** An envelope's data key. Never cached across requests (ADR 0004). */
export async function dataKeyFor(d: CoreDeps, e: Pick<EnvelopeRow, 'id' | 'wrapped_key' | 'key_version'>): Promise<Uint8Array> {
  return d.vault.unwrap(e.wrapped_key, e.key_version, `envelope:${e.id}`)
}

/** The contexts values are encrypted under, so a ciphertext cannot be moved to another row and still open. */
export const ctx = {
  token: (envelopeId: string, recipientId: string) => `token:${envelopeId}:${recipientId}`,
  fieldValue: (envelopeId: string, fieldId: string) => `field:${envelopeId}:${fieldId}`,
  answer: (envelopeId: string, questionId: string) => `answer:${envelopeId}:${questionId}`,
}

export const decryptToken = (key: Uint8Array, r: Pick<RecipientRow, 'id' | 'envelope_id' | 'token_enc'>) => (r.token_enc ? decryptText(key, r.token_enc, ctx.token(r.envelope_id, r.id)) : Promise.resolve(null))

/** The event an actor's act is recorded as: who, from where, on what device. */
export function eventFor(actor: Actor, origin: Origin, input: Pick<EventInput, 'action' | 'details' | 'docHash'>): EventInput {
  const base = { ...input, ip: origin.ip ?? null, userAgent: origin.userAgent ?? null, device: describeDevice(origin.userAgent) }
  switch (actor.kind) {
    case 'operator':
      return { ...base, actorKind: 'operator', actorEmail: actor.email, actorName: actor.name }
    case 'recipient':
      return { ...base, actorKind: 'recipient', actorEmail: actor.email, actorName: actor.name }
    case 'agent':
      return { ...base, actorKind: 'agent', actorName: actor.label, details: { ...input.details, on_word_of: actor.onWordOf } }
    case 'system':
      return { ...base, actorKind: 'system', ip: null, userAgent: null, device: null }
  }
}

/** What an audit row or a mail row records as the acting party. */
export const actorLabel = (a: Actor): string => (a.kind === 'operator' ? a.email : a.kind === 'agent' ? a.label : a.kind === 'recipient' ? a.email : 'system')

const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ')

/** The first event of an attempt: what every statement of the change depends on. */
export type Anchor = { seq: number; hash: string }

/** What `queueMail` and the authors of a change write through. */
export interface Writer {
  mutate(sql: string, ...binds: unknown[]): this
  insert(table: string, row: Row): this
}

/**
 * The statements of one change, each carrying ONE condition, so the guard is tested once, in one place, and a statement that
 * moves the envelope or the recipient on cannot hide the state another one was guarded by.
 *
 *  - `onEvent`: a change with an event. `appendEvents` inserts the event first, guarded by the state the change expects
 *    (`whenStatus`, `whenRecipient`, `whenTail`); every statement here runs only if that event's row exists. This is what lets
 *    two signers finishing at once change things once (ADR 0005).
 *  - `onState`: a change with no event (a signer saving a field as they go): every statement runs only while the envelope is
 *    in one of the statuses and, when given, the recipient is in one of theirs. Nothing here moves either on.
 */
export class Guarded implements Writer {
  readonly stmts: Stmt[] = []
  private constructor(
    private db: Db,
    private cond: { sql: string; binds: unknown[] },
  ) {}

  static onEvent(db: Db, envelopeId: string, anchor: Anchor): Guarded {
    return new Guarded(db, { sql: 'EXISTS (SELECT 1 FROM events WHERE envelope_id = ? AND seq = ? AND hash = ?)', binds: [envelopeId, anchor.seq, anchor.hash] })
  }

  static onState(db: Db, envelopeId: string, statuses: string[], recipient?: { id: string; status: string[] }): Guarded {
    const env = `EXISTS (SELECT 1 FROM envelopes WHERE id = ? AND status IN (${marks(statuses.length)}))`
    const who = recipient ? ` AND EXISTS (SELECT 1 FROM recipients WHERE id = ? AND status IN (${marks(recipient.status.length)}))` : ''
    return new Guarded(db, { sql: env + who, binds: [envelopeId, ...statuses, ...(recipient ? [recipient.id, ...recipient.status] : [])] })
  }

  /** An UPDATE or DELETE whose WHERE clause is already written; the condition is added to it. */
  mutate(sql: string, ...binds: unknown[]): this {
    this.stmts.push(this.db.prepare(`${sql} AND ${this.cond.sql}`).bind(...binds, ...this.cond.binds))
    return this
  }

  insert(table: string, row: Row): this {
    const keys = Object.keys(row)
    this.stmts.push(this.db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) SELECT ${marks(keys.length)} WHERE ${this.cond.sql}`).bind(...keys.map((k) => row[k] ?? null), ...this.cond.binds))
    return this
  }
}

/** A date in a client's own time zone, written out ("October 31, 2026"). */
export const clientZoneDate = (ms: number, zone: string): string => new Intl.DateTimeFormat('en-US', { timeZone: zone, dateStyle: 'long' }).format(new Date(ms))

/** The hour (0 to 23) it is in a time zone. */
export const hourIn = (ms: number, zone: string): number => Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms)))

export const jsonOrEmpty = (s: string | null): Record<string, unknown> => {
  try {
    return s ? (JSON.parse(s) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
