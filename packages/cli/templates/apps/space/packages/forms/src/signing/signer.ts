/**
 * An envelope's life from a signer's side. Every request carries the recipient's token; the token is looked up by its hash
 * and is the only credential. A link that leads nowhere says so in one message that teaches a guesser nothing.
 *
 * Order of a signer's steps: open (recorded when the page's script says so, not when the link is fetched, so a mail scanner
 * opens nobody's envelope), consent (before anything else), see the document, adopt a signature, fill fields, finish. Every
 * state change here is one guarded batch with one event; saving a field's value is a draft and writes none.
 */
import { sha256Hex } from '../bytes'
import { CONSENT_VERSION, consentHash, consentParagraphs, intentText } from '../consent'
import { appendEvents, stableJson } from '../events'
import { FIELD_CATALOG, checkFieldValue } from '../fields'
import { logoType } from '../clients'
import { buildConsentSample, buildTermsPdf } from '../pdf/terms'
import type { AdoptionKind, AdoptionMethod } from '../vocab'
import { MAX_ADOPTION_BYTES, UNFINISHED_RETENTION_DAYS } from '../settings'
import { encryptText, getSealed, putSealed } from '../vault'
import { maybeSeal } from './completion'
import { readAdoptions, readValues } from './values'
import { flushAll, queueMail } from './mail'
import { ACTING, type Actor, type AdoptionRow, type ClientRow, type CoreDeps, type EnvelopeRow, type FieldRow, type Anchor, Guarded, LIVE, type Origin, type RecipientRow, addDays, ctx, dataKeyFor, eventFor, gone, invalidLink, isoAt, loadClient, loadEnvelope, loadFields, loadRecipients, printedAs } from './support'
import { badRequest, conflict } from '../store'
import { hashToken } from './lifecycle'

export interface Resolved {
  envelope: EnvelopeRow
  client: ClientRow
  recipient: RecipientRow
  recipients: RecipientRow[]
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/

/** The recipient a link belongs to, or the one message every dead link gets. */
export async function resolveToken(d: CoreDeps, token: string): Promise<Resolved> {
  if (!TOKEN.test(token)) throw invalidLink()
  const recipient = await d.db.prepare('SELECT * FROM recipients WHERE token_hash = ?').bind(await hashToken(token)).first<RecipientRow>()
  if (!recipient) throw invalidLink()
  const envelope = await loadEnvelope(d.db, recipient.envelope_id)
  return { envelope, client: await loadClient(d.db, envelope.client_id), recipient, recipients: await loadRecipients(d.db, envelope.id) }
}

export type SignerState =
  | 'consent' // before anything else
  | 'preparing' // a form whose document does not exist yet (the filler answers here)
  | 'sign'
  | 'waiting-turn' // in order, and not yet this person's turn
  | 'waiting-others' // a copy recipient, until everyone has signed
  | 'signed' // this person is done; others are not
  | 'sealing'
  | 'complete'
  | 'declined'
  | 'cancelled'
  | 'expired'

/** What a link shows right now. Expiry holds the moment its time passes, whether or not the sweep has run. */
export function stateOf(d: Pick<CoreDeps, 'now'>, r: Pick<Resolved, 'envelope' | 'recipient'>): SignerState {
  const { envelope: e, recipient: p } = r
  if (e.status === 'cancelled') return 'cancelled'
  if (e.status === 'declined') return 'declined'
  if (e.status === 'expired') return 'expired'
  if (e.status === 'completed') return 'complete'
  if (e.status === 'sealing') return 'sealing'
  if (e.status === 'draft') return 'waiting-turn'
  if (e.expires_at && Date.parse(e.expires_at) <= d.now()) return 'expired'
  if (p.kind === 'copy') return 'waiting-others'
  if (p.status === 'signed') return 'signed'
  if (p.status === 'declined') return 'declined'
  if (p.status === 'waiting') return 'waiting-turn'
  if (p.status !== 'consented') return 'consent'
  return e.prepared_key ? 'sign' : 'preparing'
}

const actorOf = (p: RecipientRow): Actor => ({ kind: 'recipient', id: p.id, email: p.email, name: p.name })

/** Refuses a signer's write unless the link is in the state it needs, with the plain reason for each other state. */
export function mustBe(state: SignerState, ...allowed: SignerState[]): void {
  if (allowed.includes(state)) return
  const why: Partial<Record<SignerState, string>> = {
    consent: 'Agree to sign electronically first.',
    cancelled: 'This was cancelled.',
    expired: 'This link has expired.',
    declined: 'This was declined.',
    complete: 'This is already complete.',
    sealing: 'Everyone has signed and the document is being finished.',
    signed: 'You have already signed.',
    'waiting-turn': 'It is not your turn to sign yet.',
    'waiting-others': 'You will be emailed the finished document.',
    preparing: 'The document is not ready yet.',
    sign: 'You have not agreed to sign electronically yet.',
  }
  throw gone(why[state] ?? 'That cannot be done now.')
}

/** The page's script calls this when it loads. The first call, and only the first, is the "opened" event. */
export async function open(d: CoreDeps, token: string, origin: Origin): Promise<void> {
  const r = await resolveToken(d, token)
  const state = stateOf(d, r)
  if (r.recipient.status !== 'sent' || !(LIVE as string[]).includes(r.envelope.status) || state === 'expired') return
  await markOpened(d, r, origin)
}

async function markOpened(d: CoreDeps, r: Resolved, origin: Origin): Promise<boolean> {
  const build = (a: Anchor) => Guarded.onEvent(d.db, r.envelope.id, a).mutate("UPDATE recipients SET status = 'opened', opened_at = ? WHERE id = ? AND status = 'sent'", isoAt(d.now()), r.recipient.id).stmts
  const done = await appendEvents(d.db, r.envelope, [eventFor(actorOf(r.recipient), origin, { action: 'opened', docHash: r.envelope.prepared_sha256 })], {
    now: d.now(),
    changes: build,
    whenStatus: [...LIVE],
    whenRecipient: { id: r.recipient.id, status: ['sent'] },
  })
  return done.applied
}

/** The signer agrees to sign electronically. The version and the hash of the exact text shown go on the event. */
export async function consent(d: CoreDeps, token: string, origin: Origin): Promise<void> {
  const r = await resolveToken(d, token)
  const state = stateOf(d, r)
  if (state === 'sign' || state === 'preparing') return
  mustBe(state, 'consent')
  const actor = actorOf(r.recipient)
  const events = []
  if (r.recipient.status === 'sent') events.push(eventFor(actor, origin, { action: 'opened', docHash: r.envelope.prepared_sha256 }))
  const hash = await consentHash({ ...printedAs(r.envelope, r.client).client, title: r.envelope.title, service: d.service })
  events.push(eventFor(actor, origin, { action: 'consented', details: { version: CONSENT_VERSION, text_sha256: hash }, docHash: r.envelope.prepared_sha256 }))
  const build = (a: Anchor) => Guarded.onEvent(d.db, r.envelope.id, a).mutate("UPDATE recipients SET status = 'consented', consent_version = ?, consent_at = ?, opened_at = COALESCE(opened_at, ?) WHERE id = ?", CONSENT_VERSION, isoAt(d.now()), isoAt(d.now()), r.recipient.id).stmts
  const done = await appendEvents(d.db, r.envelope, events, { now: d.now(), changes: build, whenStatus: [...LIVE], whenRecipient: { id: r.recipient.id, status: ['sent', 'opened'] } })
  if (!done.applied) throw conflict('That already happened.')
}

/**
 * The sample PDF the consent asks the signer to open. While they are still at the consent step, each opening is an event: the
 * closest record there is that this device opened a PDF before the signer said it could.
 */
export async function consentSample(d: CoreDeps, token: string, origin: Origin): Promise<Uint8Array> {
  const r = await resolveToken(d, token)
  if (stateOf(d, r) === 'consent') await appendEvents(d.db, r.envelope, [eventFor(actorOf(r.recipient), origin, { action: 'consent-sample-opened' })], { now: d.now(), whenStatus: [...LIVE] })
  return buildConsentSample(d.service)
}

/** The consent text the signer is shown, as a PDF to save. Nothing in it is private, so opening it records nothing. */
export async function consentTerms(d: CoreDeps, token: string): Promise<Uint8Array> {
  const r = await resolveToken(d, token)
  const { client } = printedAs(r.envelope, r.client)
  return buildTermsPdf({ version: CONSENT_VERSION, business: `${client.display_name} (${client.legal_name})`, documentTitle: r.envelope.title, paragraphs: consentParagraphs({ ...client, title: r.envelope.title, service: d.service }) })
}

/** The prepared document, for the page to show. Each showing is an event carrying the document's fingerprint. */
export async function showDocument(d: CoreDeps, token: string, origin: Origin): Promise<{ bytes: Uint8Array; sha256: string }> {
  const r = await resolveToken(d, token)
  mustBe(stateOf(d, r), 'sign')
  const key = await dataKeyFor(d, r.envelope)
  const bytes = await getSealed(d.files, r.envelope.prepared_key!, key)
  if (!bytes) throw gone('The document is not available.')
  await appendEvents(d.db, r.envelope, [eventFor(actorOf(r.recipient), origin, { action: 'document-shown', docHash: r.envelope.prepared_sha256 })], { now: d.now() })
  return { bytes, sha256: r.envelope.prepared_sha256! }
}

export interface AdoptInput {
  kind: AdoptionKind
  method: AdoptionMethod
  /** The image (PNG or JPEG) in every method: a typed signature is drawn by the browser in its script font. */
  image: Uint8Array
  typedText?: string
  typedFont?: string
}

/** The signer adopts a signature or initials once; the image is stored with its hash and used wherever they sign. */
export async function adopt(d: CoreDeps, token: string, origin: Origin, input: AdoptInput): Promise<void> {
  const r = await resolveToken(d, token)
  mustBe(stateOf(d, r), 'sign')
  if (input.kind !== 'signature' && input.kind !== 'initials') throw badRequest('Adopt a signature or initials')
  if (!['drawn', 'typed', 'uploaded'].includes(input.method)) throw badRequest('Draw it, type it or upload it')
  if (input.image.length === 0 || input.image.length > MAX_ADOPTION_BYTES) throw badRequest(`The image must be under ${MAX_ADOPTION_BYTES / 1024} KB`)
  if (!logoType(input.image)) throw badRequest('The image must be a PNG or a JPEG')
  if (r.envelope.typed_only === 1 && input.method !== 'typed') throw badRequest('This document is signed by typing your own name. Type it into the blank field.')
  if (input.method === 'typed' && (!input.typedText || input.typedText.trim() === '' || input.typedText.length > 80)) throw badRequest('Type your name (up to 80 characters)')
  const sha = await sha256Hex(input.image)
  const key = await dataKeyFor(d, r.envelope)
  const imageKey = `envelopes/${r.envelope.id}/adoptions/${r.recipient.id}-${input.kind}`
  await putSealed(d.files, imageKey, key, input.image, logoType(input.image)!)
  const build = (a: Anchor) => {
    const g = Guarded.onEvent(d.db, r.envelope.id, a)
    // The picture is part of what Finish hashes, so a new one moves the version Finish is conditioned on.
    g.mutate('UPDATE recipients SET values_version = values_version + 1 WHERE id = ?', r.recipient.id)
    g.mutate('DELETE FROM signature_adoptions WHERE recipient_id = ? AND kind = ?', r.recipient.id, input.kind)
    g.insert('signature_adoptions', {
      id: crypto.randomUUID(),
      envelope_id: r.envelope.id,
      client_id: r.envelope.client_id,
      recipient_id: r.recipient.id,
      kind: input.kind,
      method: input.method,
      image_key: imageKey,
      image_sha256: sha,
      typed_text: input.method === 'typed' ? input.typedText!.trim() : null,
      typed_font: input.method === 'typed' ? (input.typedFont ?? '').slice(0, 40) || null : null,
      adopted_at: isoAt(d.now()),
    })
    return g.stmts
  }
  const done = await appendEvents(d.db, r.envelope, [eventFor(actorOf(r.recipient), origin, { action: 'signature-adopted', details: { kind: input.kind, method: input.method, image_sha256: sha } })], {
    now: d.now(),
    changes: build,
    whenStatus: [...LIVE],
    whenRecipient: { id: r.recipient.id, status: ['consented'] },
  })
  if (!done.applied) throw conflict('That could not be saved. Reload the page.')
}

/** Saves one field's value as the signer goes. A draft: it changes nothing a signer has committed to, so it writes no event. */
export async function saveField(d: CoreDeps, token: string, fieldId: string, value: unknown): Promise<void> {
  const r = await resolveToken(d, token)
  mustBe(stateOf(d, r), 'sign')
  const field = (await loadFields(d.db, r.envelope.id)).find((f) => f.id === fieldId && f.recipient_id === r.recipient.id)
  if (!field) throw badRequest('That is not one of your fields.')
  // A letter typed as a base and a mark (some phones) is one letter before it is checked and stored; the font does not position a loose mark.
  if (typeof value === 'string') value = value.normalize('NFC')
  const bad = checkFieldValue(field.type, value)
  if (bad) throw badRequest(bad)
  if (field.type === 'signature' || field.type === 'initials') {
    const have = await d.db.prepare('SELECT 1 AS one FROM signature_adoptions WHERE recipient_id = ? AND kind = ?').bind(r.recipient.id, field.type).first()
    if (!have) throw badRequest(`Adopt your ${field.type === 'signature' ? 'signature' : 'initials'} first.`)
  }
  const key = await dataKeyFor(d, r.envelope)
  const enc = await encryptText(key, JSON.stringify(value), ctx.fieldValue(r.envelope.id, field.id))
  const g = Guarded.onState(d.db, r.envelope.id, [...LIVE], { id: r.recipient.id, status: ['consented'] })
  // Every save moves the version Finish is conditioned on, in the same batch as the value.
  g.mutate('UPDATE recipients SET values_version = values_version + 1 WHERE id = ?', r.recipient.id)
  g.mutate('DELETE FROM field_values WHERE field_id = ?', field.id)
  g.insert('field_values', { field_id: field.id, envelope_id: r.envelope.id, client_id: r.envelope.client_id, value_enc: enc, filled_by: r.recipient.id, filled_at: isoAt(d.now()) })
  await d.db.batch(g.stmts)
}

/** A date in the client's zone as YYYY-MM-DD. */
export const dateIn = (ms: number, zone: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))


/** Which of a signer's required fields still need them (by label), given what is saved. */
export function missingFields(fields: FieldRow[], values: Map<string, unknown>, adopted: Set<string>): FieldRow[] {
  return fields.filter((f) => {
    if (f.required !== 1) return false
    const v = values.get(f.id)
    switch (f.type) {
      case 'date':
        return false
      case 'signature':
      case 'initials':
        return !(v === 'adopted' && adopted.has(f.type))
      case 'checkbox':
        return v !== true
      case 'text':
        return typeof v !== 'string' || v.trim() === ''
    }
  })
}

/**
 * The signer finishes: every required field is filled, the date fields fill themselves, and the confirmation that the
 * signature is theirs is recorded with the event. The turn passes (in order the next signer is emailed), and when the
 * last signer finishes the envelope is sealed.
 */
export async function finish(d: CoreDeps, token: string, origin: Origin, input: { intent: boolean }): Promise<'signed' | 'sealing' | 'complete'> {
  const r = await resolveToken(d, token)
  mustBe(stateOf(d, r), 'sign')
  if (input.intent !== true) throw badRequest('Confirm that your electronic signature is yours to finish.')
  const key = await dataKeyFor(d, r.envelope)
  const mine = (await loadFields(d.db, r.envelope.id)).filter((f) => f.recipient_id === r.recipient.id)
  const values = await readValues(d, r.envelope, key)
  const adoptions = (await readAdoptions(d, r.envelope.id)).filter((a) => a.recipient_id === r.recipient.id)
  const missing = missingFields(mine, values, new Set(adoptions.map((a) => a.kind)))
  if (missing.length > 0) throw badRequest(`${missing.length} ${missing.length === 1 ? 'field still needs' : 'fields still need'} you: ${missing.map((f) => f.label || FIELD_CATALOG[f.type].label).join(', ')}.`)

  const today = dateIn(d.now(), r.client.time_zone)
  const dates = mine.filter((f) => f.type === 'date')
  for (const f of dates) values.set(f.id, today)
  const filled = mine.filter((f) => values.has(f.id)).sort((a, b) => (a.id < b.id ? -1 : 1))
  const valuesSha = await sha256Hex(stableJson(filled.map((f) => [f.id, f.type, f.type === 'signature' || f.type === 'initials' ? (adoptions.find((a) => a.kind === f.type)?.image_sha256 ?? null) : values.get(f.id)])))

  const dateRows = await Promise.all(dates.map(async (f) => ({ id: f.id, enc: await encryptText(key, JSON.stringify(today), ctx.fieldValue(r.envelope.id, f.id)) })))
  const mailIds: string[] = []
  // In order, the next signer's turn comes now. All at once, everyone was emailed at Send.
  const next = r.envelope.order_mode === 'sequential' ? r.recipients.filter((p) => p.kind === 'signer' && p.position > r.recipient.position && p.status === 'waiting').sort((a, b) => a.position - b.position)[0] : undefined
  const build = (a: Anchor) => {
    mailIds.length = 0
    const g = Guarded.onEvent(d.db, r.envelope.id, a)
    for (const row of dateRows) {
      g.mutate('DELETE FROM field_values WHERE field_id = ?', row.id)
      g.insert('field_values', { field_id: row.id, envelope_id: r.envelope.id, client_id: r.envelope.client_id, value_enc: row.enc, filled_by: r.recipient.id, filled_at: isoAt(d.now()) })
    }
    g.mutate("UPDATE recipients SET status = 'signed', signed_at = ? WHERE id = ?", isoAt(d.now()), r.recipient.id)
    if (next) {
      g.mutate("UPDATE recipients SET status = 'sent', notified_at = ? WHERE id = ? AND status = 'waiting'", isoAt(d.now()), next.id)
      mailIds.push(queueMail(g, d, { envelope: r.envelope, client: r.client, recipient: next, kind: 'turn' }))
    }
    return g.stmts
  }
  const done = await appendEvents(d.db, r.envelope, [eventFor(actorOf(r.recipient), origin, { action: 'signed', details: { values_sha256: valuesSha, fields: filled.length, intent_sha256: await sha256Hex(intentText(r.recipient.name)) }, docHash: r.envelope.prepared_sha256 })], {
    now: d.now(),
    changes: build,
    whenStatus: [...LIVE],
    // The values hashed above are the ones read at the top of this call: written only if no save has moved them since.
    whenRecipient: { id: r.recipient.id, status: ['consented'], valuesVersion: r.recipient.values_version },
  })
  if (!done.applied) {
    const now = await d.db.prepare('SELECT status FROM recipients WHERE id = ?').bind(r.recipient.id).first<{ status: string }>()
    throw conflict(now?.status === 'consented' ? 'Something you filled in changed while you were finishing. Look it over and press Finish again.' : 'That was already finished.')
  }
  await flushAll(d, mailIds)
  const after = await maybeSeal(d, r.envelope.id)
  return after
}

/** Declining ends the envelope for everyone; the operator, the copy recipients and anyone who already signed are told. */
export async function decline(d: CoreDeps, token: string, origin: Origin, reason: unknown): Promise<void> {
  const r = await resolveToken(d, token)
  const state = stateOf(d, r)
  mustBe(state, 'consent', 'sign', 'preparing')
  if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > 500)) throw badRequest('Your reason can be up to 500 characters')
  const why = typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : null
  const now = d.now()
  const mailIds: string[] = []
  const data = { declinedBy: r.recipient.name, reason: why }
  const build = (a: Anchor) => {
    mailIds.length = 0
    const g = Guarded.onEvent(d.db, r.envelope.id, a)
    for (const p of r.recipients.filter((p) => p.id !== r.recipient.id && (p.kind === 'copy' || p.status === 'signed'))) mailIds.push(queueMail(g, d, { envelope: r.envelope, client: r.client, recipient: p, kind: 'declined', data }))
    mailIds.push(queueMail(g, d, { envelope: r.envelope, client: r.client, to: d.notice, kind: 'declined', data }))
    g.mutate("UPDATE recipients SET status = 'declined', declined_at = ?, decline_reason = ? WHERE id = ?", isoAt(now), why, r.recipient.id)
    g.mutate("UPDATE envelopes SET status = 'declined', purge_at = ? WHERE id = ?", isoAt(addDays(now, UNFINISHED_RETENTION_DAYS)), r.envelope.id)
    return g.stmts
  }
  const done = await appendEvents(d.db, r.envelope, [eventFor(actorOf(r.recipient), origin, { action: 'declined', details: { reason: why }, docHash: r.envelope.prepared_sha256 })], {
    now,
    changes: build,
    whenStatus: [...LIVE],
    whenRecipient: { id: r.recipient.id, status: [...ACTING] },
  })
  if (!done.applied) throw conflict('That envelope has already ended.')
  await flushAll(d, mailIds)
}
