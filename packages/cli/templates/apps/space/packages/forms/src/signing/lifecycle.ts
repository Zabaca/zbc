/**
 * An envelope's life from the operator's side: create a draft from a prepared document, edit it, send it, remind, cancel,
 * correct a recipient, expire. The signer's side (open, consent, adopt, sign, decline) is signer.ts; completion is
 * completion.ts. Every state change is ONE guarded batch with exactly one event (src/events.ts): the change names the
 * state it expects, so two requests racing for the same step write one event between them and the loser changes nothing.
 */
import { type ConversationRef, isConversationRef } from '@space/workspace'
import { address, isHeaderSafe } from '../clients'
import { type EventInput, appendEvents, tailSeq } from '../events'
import { type PreparedDocument, type PreparedField, checkPrepared } from '../fields'
import { LIMITS, inspect } from '../pdf/engine'
import { isUniqueViolation, newId } from '../records'
import { DEFAULTS, MAX_RECIPIENTS, UNFINISHED_RETENTION_DAYS } from '../settings'
import { sha256Hex, toBase64Url } from '../bytes'
import { encryptText, putSealed } from '../vault'
import { gateAgent, type Gate } from './instructions'
import { flushAll, queueMail } from './mail'
import { actingSigners, draftFingerprint } from './rules'
import { ACTING, type Actor, type CoreDeps, type EnvelopeRow, type Anchor, Guarded, LIVE, type Origin, type RecipientRow, actorLabel, addDays, copyAddressesOf, ctx, dataKeyFor, eventFor, isoAt, loadClient, loadEnvelope, loadFields, loadRecipients, refused } from './support'
import { badRequest, conflict } from '../store'

export interface RecipientInput {
  role: string
  name: string
  email: string
  kind?: 'signer' | 'copy'
}

export interface CreateInput {
  clientId: string
  kind: 'form' | 'document'
  title: string
  order?: 'sequential' | 'parallel'
  note?: string | null
  expiresInDays?: number
  reminderEveryDays?: number
  reminderMax?: number
  recipients: RecipientInput[]
  /** A document envelope's prepared document: what the signing core takes, from either way of authoring. */
  prepared?: PreparedDocument
  sourceDocumentId?: string
  formVersionId?: string
  /** Holds, or will hold, a sensitive answer: the finished document goes by private link, never attached. */
  sensitive?: boolean
  /** The signer may adopt a signature only by typing their own name into a blank field (an IRS consent, say). */
  typedOnly?: boolean
  /** The conversation in the space this is sent from, if any (migration 0004). Set here and never changed. */
  conversation?: ConversationRef | null
  /** What the source says of itself, recorded in the `created` event (an upload that carried earlier signatures, say). The core's own keys win. */
  details?: Record<string, unknown>
}

/** Who may build and send: an operator, and Claude (which only drafts until the owner turns its sending on). */
function requireBuilder(actor: Actor, owner: string): asserts actor is Extract<Actor, { kind: 'operator' | 'agent' }> {
  if (actor.kind !== 'operator' && actor.kind !== 'agent') throw refused(`Only an operator, or Claude on ${owner}'s word, can do that.`)
}

function whole(v: unknown, what: string, min: number, max: number, fallback: number): number {
  if (v === undefined || v === null) return fallback
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw badRequest(`${what} must be a whole number from ${min} to ${max}`)
  return v
}

function line(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string' || v.trim() === '') throw badRequest(`${what} is required`)
  const s = v.trim()
  if (s.length > max) throw badRequest(`${what} is too long (at most ${max} characters)`)
  if (!isHeaderSafe(s)) throw badRequest(`${what} may not contain control characters`)
  return s
}

/** A conversation ref as forms keeps it: one of the apps the space knows and an id it can name, or none. */
export function checkedConversation(v: unknown): ConversationRef | null {
  if (v === undefined || v === null) return null
  if (!isConversationRef(v)) throw badRequest('A conversation names its app (inbox or meet) and its id')
  return { app: v.app, id: v.id }
}

function noteText(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || v.length > 1000) throw badRequest('The note is at most 1,000 characters')
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) throw badRequest('The note may not contain control characters')
  return v.trim() || null
}

export interface RecipientDraft {
  role: string
  name: string
  email: string
  kind: 'signer' | 'copy'
  position: number
}

/** Validates the people, orders signers first, and adds the client's copy addresses as copy recipients (once each). */
export function normalizeRecipients(input: RecipientInput[], copyAddresses: string[]): RecipientDraft[] {
  if (!Array.isArray(input) || input.length === 0) throw badRequest('Name at least one recipient')
  const checked = input.map((r, i) => {
    const kind = r.kind === 'copy' ? 'copy' : 'signer'
    return { role: line(r.role, `Recipient ${i + 1}'s role`, 40), name: line(r.name, `Recipient ${i + 1}'s name`, 80), email: address(r.email, `Recipient ${i + 1}'s email`), kind } as const
  })
  const signers = checked.filter((r) => r.kind === 'signer')
  if (signers.length === 0) throw badRequest('At least one recipient must be a signer')
  const seen = new Set<string>()
  for (const s of signers) {
    if (seen.has(s.email)) throw badRequest(`${s.email} is named as a signer twice`)
    seen.add(s.email)
  }
  const everyone = new Set(checked.map((r) => r.email))
  const copies = [...new Set(copyAddresses.map((a) => a.toLowerCase()))].filter((a) => !everyone.has(a)).map((email) => ({ role: 'Copy', name: email, email, kind: 'copy' as const }))
  const all = [...signers, ...checked.filter((r) => r.kind === 'copy'), ...copies]
  if (all.length > MAX_RECIPIENTS) throw badRequest(`An envelope has at most ${MAX_RECIPIENTS} recipients`)
  return all.map((r, i) => ({ ...r, position: i + 1 }))
}

async function checkedPrepared(prepared: PreparedDocument, recipients: Pick<RecipientDraft, 'position' | 'kind'>[]) {
  if (prepared.bytes.length === 0 || prepared.bytes.length > LIMITS.maxBytes) throw badRequest(`The document is ${(prepared.bytes.length / 1048576).toFixed(1)} MB; the most that can be signed here is ${LIMITS.maxBytes / 1048576} MB`)
  const problems = checkPrepared(prepared, recipients)
  if (problems.length > 0) throw badRequest(problems.join(' '))
  // The pages are the author's claim; the file is the truth. A mismatch would put a field on a page that is not there.
  const seen = await inspect(prepared.bytes)
  if (!seen.ok) throw badRequest(seen.refusal.message)
  if (seen.value.pageCount !== prepared.pages.length) throw badRequest(`The document has ${seen.value.pageCount} pages but ${prepared.pages.length} were described`)
  return sha256Hex(prepared.bytes)
}

const fieldRow = (f: PreparedField, envelopeId: string, clientId: string, recipientId: string) => ({
  id: newId(),
  envelope_id: envelopeId,
  client_id: clientId,
  recipient_id: recipientId,
  type: f.type,
  page: f.page,
  x: f.box.x,
  y: f.box.y,
  width: f.box.width,
  height: f.box.height,
  required: f.required ? 1 : 0,
  label: f.label ?? null,
  pdf_field_name: f.pdfFieldName ?? null,
})

const preparedKeyOf = (envelopeId: string, sha: string) => `envelopes/${envelopeId}/prepared/${sha}`

/** A draft envelope from a prepared document (a document envelope) or a form version. Nothing is sent. */
export async function createEnvelope(d: CoreDeps, actor: Actor, input: CreateInput): Promise<EnvelopeRow> {
  requireBuilder(actor, d.owner.name)
  const client = await loadClient(d.db, input.clientId)
  if (input.kind !== 'form' && input.kind !== 'document') throw badRequest('An envelope is a form or a document')
  const title = line(input.title, 'The title', 120)
  const recipients = normalizeRecipients(input.recipients, copyAddressesOf(client))
  const expiresInDays = whole(input.expiresInDays, 'Expiry', 1, 365, DEFAULTS.expiresInDays)
  const everyDays = whole(input.reminderEveryDays, 'The reminder interval', 1, 30, DEFAULTS.reminderEveryDays)
  const reminderMax = whole(input.reminderMax, 'The reminder count', 0, 10, DEFAULTS.reminderMax)
  if (input.kind === 'document' && (!input.prepared || !input.sourceDocumentId)) throw badRequest('A document envelope needs a prepared document and the source it was made from')
  if (input.kind === 'form' && (!input.formVersionId || input.prepared)) throw badRequest('A form envelope needs a published form version, and its document is made when the filler finishes answering')

  const conversation = checkedConversation(input.conversation)
  const id = newId()
  const now = d.now()
  const { key, wrapped, version } = await d.vault.newDataKey(`envelope:${id}`)
  let preparedSha: string | null = null
  let preparedKey: string | null = null
  if (input.prepared) {
    preparedSha = await checkedPrepared(input.prepared, recipients)
    preparedKey = preparedKeyOf(id, preparedSha)
    await putSealed(d.files, preparedKey, key, input.prepared.bytes, 'application/pdf')
  }
  const recipientIds = recipients.map(() => newId())
  const byPosition = new Map(recipients.map((r, i) => [r.position, recipientIds[i]!]))
  const db = d.db
  const stmts = [
    db
      .prepare(
        'INSERT INTO envelopes (id, client_id, kind, form_version_id, source_document_id, title, status, order_mode, note, expires_in_days, reminder_every_days, reminder_max, sensitive, typed_only, created_by, created_at, prepared_key, prepared_sha256, prepared_size, wrapped_key, key_version, purge_at, conversation_app, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(id, client.id, input.kind, input.formVersionId ?? null, input.sourceDocumentId ?? null, title, 'draft', input.order === 'parallel' ? 'parallel' : 'sequential', noteText(input.note), expiresInDays, everyDays, reminderMax, input.sensitive ? 1 : 0, input.typedOnly ? 1 : 0, actorLabel(actor), isoAt(now), preparedKey, preparedSha, input.prepared?.bytes.length ?? null, wrapped, version, isoAt(addDays(now, UNFINISHED_RETENTION_DAYS)), conversation?.app ?? null, conversation?.id ?? null),
    ...recipients.map((r, i) =>
      db.prepare('INSERT INTO recipients (id, envelope_id, client_id, role, name, email, kind, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(recipientIds[i]!, id, client.id, r.role, r.name, r.email, r.kind, r.position, isoAt(now)),
    ),
    ...(input.prepared?.fields ?? []).map((f) => {
      const row = fieldRow(f, id, client.id, byPosition.get(f.recipient)!)
      return db
        .prepare('INSERT INTO fields (id, envelope_id, client_id, recipient_id, type, page, x, y, width, height, required, label, pdf_field_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(row.id, row.envelope_id, row.client_id, row.recipient_id, row.type, row.page, row.x, row.y, row.width, row.height, row.required, row.label, row.pdf_field_name)
    }),
  ]
  try {
    await appendEvents(db, { id, client_id: client.id }, [eventFor(actor, {}, { action: 'created', details: { ...input.details, kind: input.kind, title, recipients: recipients.length, fields: input.prepared?.fields.length ?? 0 }, docHash: preparedSha })], { now, changes: stmts })
  } catch (e) {
    if (preparedKey) await d.files.delete(preparedKey)
    throw e
  }
  return loadEnvelope(db, id)
}

export interface DraftPatch {
  title?: string
  order?: 'sequential' | 'parallel'
  note?: string | null
  expiresInDays?: number
  reminderEveryDays?: number
  reminderMax?: number
  recipients?: RecipientInput[]
  sensitive?: boolean
  typedOnly?: boolean
}

/** Edits a draft. A sent envelope never changes: cancel it and send another. */
export async function updateDraft(d: CoreDeps, actor: Actor, id: string, patch: DraftPatch): Promise<EnvelopeRow> {
  requireBuilder(actor, d.owner.name)
  const e = await loadEnvelope(d.db, id)
  if (e.status !== 'draft') throw conflict('Only a draft can be edited. Cancel a sent envelope and send another.')
  const client = await loadClient(d.db, e.client_id)
  const sets: string[] = []
  const binds: unknown[] = []
  const changed: string[] = []
  const set = (col: string, v: unknown, name: string) => {
    sets.push(`${col} = ?`)
    binds.push(v)
    changed.push(name)
  }
  if (patch.title !== undefined) set('title', line(patch.title, 'The title', 120), 'title')
  if (patch.order !== undefined) set('order_mode', patch.order === 'parallel' ? 'parallel' : 'sequential', 'order')
  if (patch.note !== undefined) set('note', noteText(patch.note), 'note')
  if (patch.expiresInDays !== undefined) set('expires_in_days', whole(patch.expiresInDays, 'Expiry', 1, 365, 30), 'expiry')
  if (patch.reminderEveryDays !== undefined) set('reminder_every_days', whole(patch.reminderEveryDays, 'The reminder interval', 1, 30, 3), 'reminders')
  if (patch.reminderMax !== undefined) set('reminder_max', whole(patch.reminderMax, 'The reminder count', 0, 10, 3), 'reminders')
  if (patch.sensitive !== undefined) set('sensitive', patch.sensitive ? 1 : 0, 'sensitive')
  if (patch.typedOnly !== undefined) set('typed_only', patch.typedOnly ? 1 : 0, 'typed-only')
  set('purge_at', isoAt(addDays(d.now(), UNFINISHED_RETENTION_DAYS)), 'purge')
  changed.splice(changed.indexOf('purge'), 1)

  let rebuild: ((g: Guarded) => void) | null = null
  if (patch.recipients) {
    const recipients = normalizeRecipients(patch.recipients, copyAddressesOf(client))
    const oldRecipients = await loadRecipients(d.db, id)
    const positionOf = new Map(oldRecipients.map((r) => [r.id, r.position]))
    const fields = await loadFields(d.db, id)
    const asPrepared: PreparedField[] = fields.map((f) => ({ recipient: positionOf.get(f.recipient_id)!, type: f.type, page: f.page, box: { x: f.x, y: f.y, width: f.width, height: f.height }, required: f.required === 1, label: f.label, pdfFieldName: f.pdf_field_name }))
    const pageCount = fields.reduce((n, f) => Math.max(n, f.page + 1), 1)
    const problems = checkPrepared({ pages: Array.from({ length: pageCount }, (_, index) => ({ index, width: 612, height: 792, rotation: 0 as const })), fields: asPrepared }, recipients)
    // A form's draft has no document yet, so no fields to fit: its people are checked against its roles (src/forms/source.ts).
    if (e.kind !== 'form' && problems.length > 0) throw badRequest(`Those recipients do not fit the document's fields: ${problems.join(' ')}`)
    const newIds = recipients.map(() => newId())
    const byPosition = new Map(recipients.map((r, i) => [r.position, newIds[i]!]))
    const now = isoAt(d.now())
    rebuild = (g) => {
      g.mutate('DELETE FROM fields WHERE envelope_id = ?', id)
      g.mutate('DELETE FROM recipients WHERE envelope_id = ?', id)
      recipients.forEach((r, i) => g.insert('recipients', { id: newIds[i]!, envelope_id: id, client_id: e.client_id, role: r.role, name: r.name, email: r.email, kind: r.kind, position: r.position, created_at: now }))
      fields.forEach((f) => g.insert('fields', fieldRow({ recipient: positionOf.get(f.recipient_id)!, type: f.type, page: f.page, box: { x: f.x, y: f.y, width: f.width, height: f.height }, required: f.required === 1, label: f.label, pdfFieldName: f.pdf_field_name }, id, e.client_id, byPosition.get(positionOf.get(f.recipient_id)!)!)))
    }
    changed.push('recipients')
  }
  const build = (a: Anchor) => {
    const g = Guarded.onEvent(d.db, id, a)
    rebuild?.(g)
    g.mutate(`UPDATE envelopes SET ${sets.join(', ')} WHERE id = ?`, ...binds, id)
    return g.stmts
  }
  const done = await appendEvents(d.db, e, [eventFor(actor, {}, { action: 'draft-edited', details: { changed: [...new Set(changed)] }, docHash: e.prepared_sha256 })], { now: d.now(), changes: build, whenStatus: ['draft'] })
  if (!done.applied) throw conflict('That envelope is no longer a draft.')
  return loadEnvelope(d.db, id)
}

const newToken = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
export const hashToken = (token: string) => sha256Hex(token)

async function mint(key: Uint8Array, envelopeId: string, recipientId: string): Promise<{ token: string; hash: string; enc: string }> {
  const token = newToken()
  return { token, hash: await hashToken(token), enc: await encryptText(key, token, ctx.token(envelopeId, recipientId)) }
}

/** The error an appended batch raises when an instruction was spent by a request racing this one. */
function spentRace(e: unknown, owner: string): never {
  if (isUniqueViolation(e) && /instruction_uses/i.test(String((e as Error).message))) throw refused(`That instruction was already used. Ask ${owner} again for another action.`)
  throw e
}

/**
 * Sends a draft. In order only the first signer is emailed (the next when it is their turn); all at once, every signer is. A
 * form envelope starts with its filler alone, because its document does not exist until the answers do. An agent's send
 * needs the owner's recorded instruction for exactly this draft.
 */
export async function send(d: CoreDeps, actor: Actor, origin: Origin, id: string, opts: { instructionId?: string } = {}): Promise<EnvelopeRow> {
  requireBuilder(actor, d.owner.name)
  // Read BEFORE the draft is read and its fingerprint taken: an edit after that is an event, so the log would no longer end here.
  const tail = actor.kind === 'agent' ? await tailSeq(d.db, id) : undefined
  const e = await loadEnvelope(d.db, id)
  if (e.status !== 'draft') throw conflict('This envelope was already sent.')
  const client = await loadClient(d.db, e.client_id)
  const recipients = await loadRecipients(d.db, id)
  const signers = recipients.filter((r) => r.kind === 'signer')
  if (signers.length === 0) throw badRequest('There is no one to sign.')
  if (e.kind === 'document' && !e.prepared_key) throw badRequest('The document is not prepared.')
  const gate = actor.kind === 'agent' ? await gateAgent(d, actor, e, 'send', opts.instructionId, { fingerprint: await draftFingerprint(e, recipients) }) : null

  const key = await dataKeyFor(d, e)
  const now = d.now()
  const first = signers[0]!
  const notify = new Set((e.kind === 'form' || e.order_mode === 'sequential' ? [first] : signers).map((r) => r.id))
  const expiresAt = isoAt(addDays(now, e.expires_in_days))
  const tokens = new Map<string, Awaited<ReturnType<typeof mint>>>()
  for (const r of recipients) tokens.set(r.id, await mint(key, id, r.id))
  const mailIds: string[] = []
  const build = (a: Anchor) => {
    mailIds.length = 0
    const g = Guarded.onEvent(d.db, id, a)
    for (const r of recipients) {
      const t = tokens.get(r.id)!
      const live = notify.has(r.id)
      g.mutate('UPDATE recipients SET token_hash = ?, token_enc = ?, status = ?, notified_at = ? WHERE id = ?', t.hash, t.enc, live ? 'sent' : 'waiting', live ? isoAt(now) : null, r.id)
      if (live) mailIds.push(queueMail(g, d, { envelope: e, client, recipient: r, kind: 'request', instructionId: gate?.instruction.id }))
    }
    gate?.spend(g)
    // The names the business is sent under are kept on the envelope (migration 0006), in no event: its consent, terms and certificate print these however the row is renamed later.
    g.mutate("UPDATE envelopes SET status = 'sent', sent_by = ?, sent_at = ?, expires_at = ?, purge_at = NULL, client_display_name = ?, client_legal_name = ? WHERE id = ?", actorLabel(actor), isoAt(now), expiresAt, client.display_name, client.legal_name, id)
    return g.stmts
  }
  const event = eventFor(actor, origin, { action: 'sent', details: { order: e.order_mode, recipients: recipients.length, notified: notify.size, expires_at: expiresAt, draft_fingerprint: await draftFingerprint(e, recipients), ...gate?.details }, docHash: e.prepared_sha256 })
  const done = await appendEvents(d.db, e, [event], { now, changes: build, whenStatus: ['draft'], whenTail: tail }).catch((e) => spentRace(e, d.owner.name))
  if (!done.applied) throw conflict('This envelope was already sent.')
  await flushAll(d, mailIds)
  return loadEnvelope(d.db, id)
}

/** A reminder now, to one recipient or to whoever may act. Outside the schedule; an agent needs its own instruction. */
export async function remind(d: CoreDeps, actor: Actor, origin: Origin, id: string, opts: { recipientId?: string; instructionId?: string; scheduled?: boolean } = {}): Promise<number> {
  if (actor.kind !== 'system') requireBuilder(actor, d.owner.name)
  const e = await loadEnvelope(d.db, id)
  if (!(LIVE as string[]).includes(e.status)) throw conflict('Nobody is waiting on this envelope.')
  const client = await loadClient(d.db, e.client_id)
  const recipients = await loadRecipients(d.db, id)
  let targets = actingSigners(e.order_mode, recipients)
  if (opts.recipientId) {
    const one = recipients.find((r) => r.id === opts.recipientId)
    if (!one || one.kind !== 'signer' || !(ACTING as string[]).includes(one.status)) throw conflict('That person is not waiting to sign.')
    targets = [one]
  }
  if (targets.length === 0) throw conflict('Nobody is waiting to sign.')
  const gate = actor.kind === 'agent' ? await gateAgent(d, actor, e, 'remind', opts.instructionId, { target: { recipientId: targets.length === 1 ? targets[0]!.id : '*' } }) : null
  const now = d.now()
  const mailIds: string[] = []
  const events = targets.map((r) => eventFor(actor, origin, { action: 'reminded', details: { recipient_id: r.id, to: r.email, scheduled: opts.scheduled === true, ...gate?.details }, docHash: e.prepared_sha256 }))
  const build = (a: Anchor) => {
    mailIds.length = 0
    const g = Guarded.onEvent(d.db, id, a)
    for (const r of targets) {
      g.mutate(`UPDATE recipients SET last_reminded_at = ?${opts.scheduled ? ', reminder_count = reminder_count + 1' : ''} WHERE id = ?`, isoAt(now), r.id)
      mailIds.push(queueMail(g, d, { envelope: e, client, recipient: r, kind: 'reminder', instructionId: gate?.instruction.id }))
    }
    gate?.spend(g)
    return g.stmts
  }
  const done = await appendEvents(d.db, e, events, { now, changes: build, whenStatus: [...LIVE], whenRecipient: targets.length === 1 ? { id: targets[0]!.id, status: [...ACTING] } : undefined }).catch((e) => spentRace(e, d.owner.name))
  if (!done.applied) throw conflict('That person is no longer waiting, or the envelope has ended.')
  await flushAll(d, mailIds)
  return targets.length
}

/** Cancels with a reason: every link stops working and everyone who was emailed is told. */
export async function cancel(d: CoreDeps, actor: Actor, origin: Origin, id: string, reason: string, opts: { instructionId?: string } = {}): Promise<EnvelopeRow> {
  requireBuilder(actor, d.owner.name)
  const e = await loadEnvelope(d.db, id)
  if (!(LIVE as string[]).includes(e.status)) throw conflict(e.status === 'draft' ? 'A draft was never sent; delete it instead.' : `This envelope is ${e.status}, so there is nothing to cancel.`)
  const why = line(reason, 'The reason', 500)
  const client = await loadClient(d.db, e.client_id)
  const recipients = await loadRecipients(d.db, id)
  const gate = actor.kind === 'agent' ? await gateAgent(d, actor, e, 'cancel', opts.instructionId, {}) : null
  const now = d.now()
  const told = recipients.filter((r) => r.notified_at)
  const mailIds: string[] = []
  const build = (a: Anchor) => {
    mailIds.length = 0
    const g = Guarded.onEvent(d.db, id, a)
    for (const r of told) mailIds.push(queueMail(g, d, { envelope: e, client, recipient: r, kind: 'cancelled', data: { reason: why }, instructionId: gate?.instruction.id }))
    gate?.spend(g)
    g.mutate("UPDATE envelopes SET status = 'cancelled', purge_at = ? WHERE id = ?", isoAt(addDays(now, UNFINISHED_RETENTION_DAYS)), id)
    return g.stmts
  }
  const done = await appendEvents(d.db, e, [eventFor(actor, origin, { action: 'cancelled', details: { reason: why, told: told.length, ...gate?.details }, docHash: e.prepared_sha256 })], { now, changes: build, whenStatus: [...LIVE] }).catch((e) => spentRace(e, d.owner.name))
  if (!done.applied) throw conflict('That envelope has already ended.')
  await flushAll(d, mailIds)
  return loadEnvelope(d.db, id)
}

/** Corrects an address before its owner has opened the link: the old link is replaced, and the new address is emailed. */
export async function correctRecipient(d: CoreDeps, actor: Actor, origin: Origin, id: string, recipientId: string, change: { email: string; name?: string }, opts: { instructionId?: string } = {}): Promise<RecipientRow> {
  requireBuilder(actor, d.owner.name)
  const e = await loadEnvelope(d.db, id)
  if (!(LIVE as string[]).includes(e.status)) throw conflict('This envelope is no longer out for signature.')
  const client = await loadClient(d.db, e.client_id)
  const recipients = await loadRecipients(d.db, id)
  const r = recipients.find((x) => x.id === recipientId)
  if (!r) throw badRequest('That recipient is not on the envelope.')
  if (r.opened_at || !(['waiting', 'sent'] as string[]).includes(r.status)) throw conflict('They have already opened it, so their address can no longer be changed. Cancel and send another.')
  const email = address(change.email, 'The new email')
  const name = change.name === undefined ? r.name : line(change.name, 'The name', 80)
  if (recipients.some((x) => x.id !== r.id && x.email === email && x.kind === r.kind && r.kind === 'signer')) throw badRequest(`${email} is already a signer on this envelope`)
  const gate = actor.kind === 'agent' ? await gateAgent(d, actor, e, 'correct-recipient', opts.instructionId, { target: { recipientId: r.id, email } }) : null
  const key = await dataKeyFor(d, e)
  const t = await mint(key, id, r.id)
  const now = d.now()
  const mailIds: string[] = []
  const notified = r.status === 'sent'
  const build = (a: Anchor) => {
    mailIds.length = 0
    const g = Guarded.onEvent(d.db, id, a)
    g.mutate('UPDATE recipients SET email = ?, name = ?, token_hash = ?, token_enc = ?, notified_at = ?, last_reminded_at = NULL, reminder_count = 0 WHERE id = ? AND opened_at IS NULL', email, name, t.hash, t.enc, notified ? isoAt(now) : null, r.id)
    // What was waiting to go to the old address, or carried the old link, must never be sent: the sweep would otherwise
    // retry it and put the NEW link in the hands of whoever owns the old address.
    g.mutate("UPDATE mail SET status = 'failed', error = 'superseded by a correction' WHERE recipient_id = ? AND status = 'pending'", r.id)
    if (notified) mailIds.push(queueMail(g, d, { envelope: e, client, recipient: { id: r.id, email, name }, kind: 'request', instructionId: gate?.instruction.id }))
    gate?.spend(g)
    return g.stmts
  }
  const done = await appendEvents(d.db, e, [eventFor(actor, origin, { action: 'recipient-corrected', details: { recipient_id: r.id, from: r.email, to: email, name, ...gate?.details }, docHash: e.prepared_sha256 })], { now, changes: build, whenStatus: [...LIVE], whenRecipient: { id: r.id, status: ['waiting', 'sent'] } }).catch((e) => spentRace(e, d.owner.name))
  if (!done.applied) throw conflict('That recipient changed while you were correcting them. Look again.')
  await flushAll(d, mailIds)
  return (await loadRecipients(d.db, id)).find((x) => x.id === r.id)!
}

/** Expires an envelope past its date: every link stops working and the operator is told. The cron's job; a read refuses an expired link before it runs. */
export async function expire(d: CoreDeps, id: string): Promise<boolean> {
  const e = await loadEnvelope(d.db, id)
  if (!(LIVE as string[]).includes(e.status) || !e.expires_at || Date.parse(e.expires_at) > d.now()) return false
  const client = await loadClient(d.db, e.client_id)
  const now = d.now()
  let mailId = ''
  const build = (a: Anchor) => {
    const g = Guarded.onEvent(d.db, id, a)
    mailId = queueMail(g, d, { envelope: e, client, to: d.notice, kind: 'expired' })
    g.mutate("UPDATE envelopes SET status = 'expired', purge_at = ? WHERE id = ?", isoAt(addDays(now, UNFINISHED_RETENTION_DAYS)), id)
    return g.stmts
  }
  const done = await appendEvents(d.db, e, [eventFor({ kind: 'system' }, {}, { action: 'expired', details: { expires_at: e.expires_at }, docHash: e.prepared_sha256 })], { now, changes: build, whenStatus: [...LIVE] })
  if (!done.applied) return false
  await flushAll(d, [mailId])
  return true
}

/**
 * The form path's entry: the filler finished answering, so the document now exists. Stores it, places its fields,
 * moves the envelope to `prepared` and, for an all-at-once envelope, emails the other signers. Called again when the filler
 * changes an answer, with a new fingerprint and a new event, until the filler has signed.
 *
 * The write lands only if the log still ends where it did when the signers were read (`whenTail`: a signer's Finish is an event, so a
 * Finish that raced this call stops it), and it moves every recipient's `values_version` so that a Finish that read the old document
 * and is still on its way fails its own guard instead of signing a document that is no longer there. `opts.first` is the form path's
 * own event (the filler's `answered`) with the statements that go with it: it is written in the same batch ahead of `prepared`, so a lost
 * race writes neither and changes nothing, and `whenRecipient` holds the filler's saved answers to the version the document was made from.
 */
export async function attachPrepared(
  d: CoreDeps,
  actor: Actor,
  origin: Origin,
  id: string,
  prepared: PreparedDocument,
  opts: { sensitive?: boolean; first?: { event: EventInput; changes?: (g: Guarded) => void; whenRecipient?: { id: string; status: string[]; valuesVersion: number } } } = {},
): Promise<EnvelopeRow> {
  if (actor.kind !== 'recipient' && actor.kind !== 'operator' && actor.kind !== 'system') throw refused('That cannot prepare a document.')
  // Read BEFORE the envelope and its signers: a signer who finishes after this has moved the log, and the write below says no.
  const tail = await tailSeq(d.db, id)
  const e = await loadEnvelope(d.db, id)
  if (e.kind !== 'form') throw badRequest('Only a form envelope is prepared after it is sent.')
  if (!['sent', 'prepared'].includes(e.status)) throw conflict('This envelope is not waiting for its document.')
  const client = await loadClient(d.db, e.client_id)
  const recipients = await loadRecipients(d.db, id)
  if (recipients.some((r) => r.status === 'signed')) throw conflict('Someone has already signed, so the document can no longer change.')
  const sha = await checkedPrepared(prepared, recipients)
  const key = await dataKeyFor(d, e)
  const objectKey = preparedKeyOf(id, sha)
  await putSealed(d.files, objectKey, key, prepared.bytes, 'application/pdf')
  const now = d.now()
  const byPosition = new Map(recipients.map((r) => [r.position, r.id]))
  const mailIds: string[] = []
  const build = (a: Anchor) => {
    mailIds.length = 0
    const g = Guarded.onEvent(d.db, id, a)
    opts.first?.changes?.(g)
    g.mutate('DELETE FROM field_values WHERE envelope_id = ?', id)
    g.mutate('DELETE FROM fields WHERE envelope_id = ?', id)
    for (const f of prepared.fields) g.insert('fields', fieldRow(f, id, e.client_id, byPosition.get(f.recipient)!))
    // Whoever read the old document and is about to finish it is told their values moved.
    g.mutate('UPDATE recipients SET values_version = values_version + 1 WHERE envelope_id = ?', id)
    if (e.status === 'sent' && e.order_mode === 'parallel') {
      for (const r of recipients.filter((r) => r.kind === 'signer' && r.status === 'waiting')) {
        g.mutate("UPDATE recipients SET status = 'sent', notified_at = ? WHERE id = ? AND status = 'waiting'", isoAt(now), r.id)
        mailIds.push(queueMail(g, d, { envelope: e, client, recipient: r, kind: 'request' }))
      }
    }
    g.mutate("UPDATE envelopes SET status = 'prepared', prepared_key = ?, prepared_sha256 = ?, prepared_size = ?, sensitive = ? WHERE id = ?", objectKey, sha, prepared.bytes.length, opts.sensitive ? 1 : e.sensitive, id)
    return g.stmts
  }
  const events = [...(opts.first ? [opts.first.event] : []), eventFor(actor, origin, { action: 'prepared', details: { pages: prepared.pages.length, fields: prepared.fields.length, replaces: e.prepared_sha256 }, docHash: sha })]
  const done = await appendEvents(d.db, e, events, { now, changes: build, whenStatus: ['sent', 'prepared'], whenTail: tail, whenRecipient: opts.first?.whenRecipient })
  if (!done.applied) {
    if (objectKey !== e.prepared_key) await d.files.delete(objectKey)
    throw conflict('Something changed while the document was being made, so nothing was changed. Look it over and try again.')
  }
  if (e.prepared_key && e.prepared_key !== objectKey) await d.files.delete(e.prepared_key)
  await flushAll(d, mailIds)
  return loadEnvelope(d.db, id)
}

/**
 * The filler changes an answer or a file after their document was made: the document no longer says what the answers say, so
 * it is withdrawn, and the form makes it again (`attachPrepared`) before anyone can sign. In ONE batch with the change the caller
 * passes (`opts.changes`) and one event, so there is never a moment when a document lists a file or an answer that is gone, and
 * nothing is withdrawn by a change that did not land. Refused once anyone has signed (`whenTail`, read before the signers, stops a
 * Finish that raced this, and every recipient's `values_version` moves so a Finish that read the old document fails its own guard).
 * `opts.when` is a condition that the change will take effect (a file to remove is still there, a place to put one is still free): when it
 * does not hold nothing is written and the document stays. Returns false when the batch did not apply (the caller looks again); the withdrawn document's file is deleted only when it did.
 */
export async function reopenPrepared(d: CoreDeps, actor: Actor, origin: Origin, id: string, opts: { reason: string; changes: (g: Guarded) => void; when?: { sql: string; binds: unknown[] } }): Promise<boolean> {
  if (actor.kind !== 'recipient') throw refused("That cannot change a form's answers.")
  const tail = await tailSeq(d.db, id)
  const e = await loadEnvelope(d.db, id)
  if (e.kind !== 'form' || e.status !== 'prepared' || !e.prepared_key) return false
  const recipients = await loadRecipients(d.db, id)
  if (recipients.some((r) => r.status === 'signed')) throw conflict('Someone has already signed, so the answers can no longer change.')
  const build = (a: Anchor) => {
    const g = Guarded.onEvent(d.db, id, a)
    g.mutate("UPDATE envelopes SET prepared_key = NULL WHERE id = ? AND status = 'prepared'", id)
    g.mutate('UPDATE recipients SET values_version = values_version + 1 WHERE envelope_id = ?', id)
    opts.changes(g)
    return g.stmts
  }
  const done = await appendEvents(d.db, e, [eventFor(actor, origin, { action: 'answered', details: { document_withdrawn: true, why: opts.reason }, docHash: e.prepared_sha256 })], { now: d.now(), changes: build, whenStatus: ['prepared'], whenTail: tail, whenSql: opts.when })
  if (!done.applied) return false
  await d.files.delete(e.prepared_key)
  return true
}
