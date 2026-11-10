/**
 * What the two sides are shown, and the downloads. The operator's view of an envelope (recipients, the timeline with its
 * chain checked, mail, instructions) and the signer's view of their own link: who sent it, where they are, their fields and
 * what earlier signers put on the page. Nothing here returns a token, a key, or a stored object name.
 */
import { CONSENT_VERSION, consentParagraphs, intentText } from '../consent'
import { type EventRow, checkChain, readEvents } from '../events'
import { renderMail, senderFor } from '../mail'
import { SIGNER_API } from '../paths'
import { sealSubject } from '../service'
import { decryptText, getSealed } from '../vault'
import { gatherCertificate } from './completion'
import { type InstructionRow, agentSendingOn } from './instructions'
import { type Resolved, dateIn, resolveToken, stateOf } from './signer'
import { type Actor, type AdoptionRow, type CoreDeps, type EnvelopeRow, type Origin, addDays, clientZoneDate, ctx, dataKeyFor, eventFor, gone, jsonOrEmpty, linkEndsAt, loadClient, loadEnvelope, loadFields, loadRecipients, printedAs, requireOperator } from './support'
import { badRequest, conflict, notFound } from '../store'
import { appendEvents } from '../events'
import { readAdoptions, readValues } from './values'
import type { Row } from '../records'

/** The columns of an envelope the admin may see: no storage keys, no wrapped key. */
const SAFE = 'e.id, e.client_id, e.kind, e.title, e.status, e.order_mode, e.note, e.expires_at, e.expires_in_days, e.reminder_every_days, e.reminder_max, e.sensitive, e.typed_only, e.conversation_app, e.conversation_id, e.created_by, e.sent_by, e.created_at, e.sent_at, e.completed_at, e.purge_at, e.prepared_sha256, e.prepared_size, e.finished_sha256, e.finished_size, e.sealing_at'

export interface ListFilter {
  client?: string | null
  status?: string | null
  limit?: number
}

/** Every envelope, newest first, by client and status, with how many of its signers have signed. */
export async function listEnvelopes(d: CoreDeps, f: ListFilter = {}): Promise<Row[]> {
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500)
  return (
    await d.db
      .prepare(
        `SELECT ${SAFE}, c.display_name AS client_name, (SELECT count(*) FROM recipients r WHERE r.envelope_id = e.id AND r.kind = 'signer') AS signers, (SELECT count(*) FROM recipients r WHERE r.envelope_id = e.id AND r.kind = 'signer' AND r.status = 'signed') AS signed FROM envelopes e JOIN clients c ON c.id = e.client_id WHERE (?1 IS NULL OR e.client_id = ?1) AND (?2 IS NULL OR e.status = ?2) ORDER BY e.created_at DESC LIMIT ?3`,
      )
      .bind(f.client ?? null, f.status ?? null, limit)
      .all<Row>()
  ).results
}

const parse = (s: string) => jsonOrEmpty(s)

/** One envelope for the admin: recipients, the timeline with the chain checked, mail, instructions. */
export async function envelopeView(d: CoreDeps, id: string) {
  const envelope = await d.db.prepare(`SELECT ${SAFE}, c.display_name AS client_name, e.source_document_id, e.form_version_id FROM envelopes e JOIN clients c ON c.id = e.client_id WHERE e.id = ?`).bind(id).first<Row>()
  if (!envelope) throw notFound('Envelope')
  const recipients = (
    await d.db
      .prepare('SELECT id, role, name, email, kind, position, status, consent_version, consent_at, opened_at, signed_at, declined_at, decline_reason, reminder_count, last_reminded_at, notified_at FROM recipients WHERE envelope_id = ? ORDER BY position')
      .bind(id)
      .all<Row>()
  ).results
  const events = await readEvents(d.db, id)
  const mail = (await d.db.prepare('SELECT id, recipient_id, kind, to_email, subject, status, error, attempts, instruction_id, created_at, sent_at FROM mail WHERE envelope_id = ? ORDER BY created_at').bind(id).all<Row>()).results
  const used = new Set((await d.db.prepare('SELECT instruction_id FROM instruction_uses WHERE envelope_id = ?').bind(id).all<{ instruction_id: string }>()).results.map((r) => r.instruction_id))
  const instructions = (await d.db.prepare('SELECT * FROM instructions WHERE envelope_id = ? ORDER BY recorded_at').bind(id).all<InstructionRow>()).results.map((i) => ({ ...i, used: used.has(i.id) }))
  const fieldCounts = (await d.db.prepare('SELECT recipient_id, count(*) AS n FROM fields WHERE envelope_id = ? GROUP BY recipient_id').bind(id).all<{ recipient_id: string; n: number }>()).results
  return {
    envelope,
    recipients: recipients.map((r) => ({ ...r, fields: fieldCounts.find((c) => c.recipient_id === r.id)?.n ?? 0 })),
    events: events.map((e: EventRow) => ({ seq: e.seq, at: e.at, actor_kind: e.actor_kind, actor_email: e.actor_email, actor_name: e.actor_name, action: e.action, ip: e.ip, device: e.device, details: parse(e.details), doc_hash: e.doc_hash, hash: e.hash })),
    chain: await checkChain(d.db, id),
    mail,
    instructions,
    agentSending: await agentSendingOn(d),
  }
}

/** The request email as the first signer will receive it, for the Send screen to show before anything goes out. */
export async function mailPreview(d: CoreDeps, id: string) {
  const e = await loadEnvelope(d.db, id)
  const client = await loadClient(d.db, e.client_id)
  const first = (await loadRecipients(d.db, id)).find((r) => r.kind === 'signer')
  if (!first) throw conflict('Name a signer first.')
  const expires = clientZoneDate(addDays(d.now(), e.expires_in_days), client.time_zone)
  const rendered = renderMail({
    kind: 'request',
    service: d.service,
    brand: { name: client.display_name, accent: client.accent_color, logoUrl: client.logo_sha256 ? `${d.origin}${SIGNER_API}/logo/${client.id}?v=${client.logo_sha256}` : null, replyTo: client.reply_to },
    title: e.title,
    toName: first.name,
    link: `${d.origin}/s/their-private-link-appears-here`,
    note: e.note,
    expiresOn: expires,
  })
  const from = senderFor(client.display_name, d.service)
  return { from: `${from.name} <${from.email}>`, replyTo: client.reply_to, to: `${first.name} <${first.email}>`, ...rendered }
}

/** The finished document for an operator. Each download is an event; an agent can never take one. */
export async function operatorDownload(d: CoreDeps, actor: Actor, origin: Origin, id: string): Promise<{ bytes: Uint8Array; sha256: string; filename: string }> {
  requireOperator(actor, 'download a finished document')
  const e = await loadEnvelope(d.db, id)
  if (e.status !== 'completed' || !e.finished_key) throw conflict('This envelope has no finished document yet.')
  const bytes = await getSealed(d.files, e.finished_key, await dataKeyFor(d, e))
  if (!bytes) throw gone('The finished document is no longer in storage.')
  await appendEvents(d.db, e, [eventFor(actor, origin, { action: 'copy-downloaded', details: { by: 'operator' }, docHash: e.finished_sha256 })], { now: d.now() })
  return { bytes, sha256: e.finished_sha256!, filename: `${e.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'signed-document'}.pdf` }
}

/** The certificate of completion as data, for the admin or a signer's link, once an envelope is complete. */
export async function certificateView(d: CoreDeps, id: string) {
  const e = await loadEnvelope(d.db, id)
  if (e.status !== 'completed' || !e.completed_at) throw conflict('The certificate is made when everyone has signed.')
  const client = await loadClient(d.db, e.client_id)
  const key = await dataKeyFor(d, e)
  const seal = await d.sealer().then(
    (s) => ({ subject: s.subject, rootFingerprint: s.rootFingerprint }),
    () => ({ subject: sealSubject(d.service), rootFingerprint: 'unavailable' }),
  )
  return (await gatherCertificate(d, e, client, key, new Date(e.completed_at), seal)).model
}

/** The word of a sensitive answer, for an operator, on the record. Claude's token can never reveal one. */
export async function revealAnswer(d: CoreDeps, actor: Actor, origin: Origin, id: string, questionId: string): Promise<string> {
  requireOperator(actor, 'reveal a sensitive answer')
  const e = await loadEnvelope(d.db, id)
  const row = await d.db.prepare('SELECT value_enc FROM answers WHERE envelope_id = ? AND question_id = ?').bind(id, questionId).first<{ value_enc: string }>()
  if (!row) throw notFound('Answer')
  const value = await decryptText(await dataKeyFor(d, e), row.value_enc, ctx.answer(id, questionId))
  await appendEvents(d.db, e, [eventFor(actor, origin, { action: 'sensitive-answer-revealed', details: { question_id: questionId } })], { now: d.now() })
  return value
}

// ── The signer's side ─────────────────────────────────────────────────────

const REASON: Partial<Record<ReturnType<typeof stateOf>, string>> = {
  cancelled: 'This document was cancelled by the business that sent it. There is nothing more for you to do.',
  expired: 'This link has expired.',
  declined: 'This document was declined, so it will not be completed.',
}

/** One field as the signer's page draws it. */
export interface SignerField {
  id: string
  type: string
  page: number
  box: { x: number; y: number; width: number; height: number }
  required: boolean
  label: string | null
  /** The signer's own: what they have saved, for text and checkbox. */
  value?: string | boolean | null
  done: boolean
}

/** What a link shows. Reading it changes nothing: "opened" is its own call, made when the page's script runs. */
export async function signerView(d: CoreDeps, token: string) {
  const r = await resolveToken(d, token)
  const state = stateOf(d, r)
  const { envelope: e, client, recipient: me } = r
  const brand = { name: client.display_name, legalName: client.legal_name, accent: client.accent_color, logo: client.logo_sha256 ? `${SIGNER_API}/logo/${client.id}?v=${client.logo_sha256}` : null, replyTo: client.reply_to }
  const base = {
    state,
    kind: e.kind,
    brand,
    title: e.title,
    note: e.note,
    recipient: { name: me.name, role: me.role },
    message: REASON[state] ?? null,
    expiresOn: e.expires_at ? clientZoneDate(Date.parse(e.expires_at), client.time_zone) : null,
  }
  if (state === 'consent') return { ...base, consent: { version: CONSENT_VERSION, paragraphs: consentParagraphs({ ...printedAs(e, client).client, title: e.title, service: d.service }) } }
  if (state === 'complete') {
    const until = linkEndsAt(e)
    return { ...base, download: { available: until > d.now(), until: clientZoneDate(until, client.time_zone), sensitive: e.sensitive === 1 }, certificate: until > d.now() }
  }
  if (state !== 'sign') return base

  const key = await dataKeyFor(d, e)
  const fields = await loadFields(d.db, e.id)
  const values = await readValues(d, e, key)
  const adoptions = await readAdoptions(d, e.id)
  const mine = fields.filter((f) => f.recipient_id === me.id)
  const adopted = new Set(adoptions.filter((a) => a.recipient_id === me.id).map((a) => a.kind))
  const signerFields: SignerField[] = mine.map((f) => {
    const v = values.get(f.id)
    const done = f.type === 'date' ? true : f.type === 'signature' || f.type === 'initials' ? v === 'adopted' && adopted.has(f.type) : f.type === 'checkbox' ? v === true : typeof v === 'string' && v.trim() !== ''
    return { id: f.id, type: f.type, page: f.page, box: { x: f.x, y: f.y, width: f.width, height: f.height }, required: f.required === 1, label: f.label, value: f.type === 'text' || f.type === 'checkbox' ? ((v as string | boolean | undefined) ?? null) : null, done }
  })
  // What the people before this signer put on the page: shown in place, read only, so a countersigner sees what was agreed.
  const signedIds = new Set(r.recipients.filter((p) => p.status === 'signed' && p.id !== me.id).map((p) => p.id))
  const others = fields
    .filter((f) => signedIds.has(f.recipient_id))
    .map((f) => ({
      id: f.id,
      type: f.type,
      page: f.page,
      box: { x: f.x, y: f.y, width: f.width, height: f.height },
      by: f.recipient_id,
      // Typed name only: an earlier signer's name is shown as the text they typed, never as a picture the browser sent.
      value: f.type === 'signature' || f.type === 'initials' ? (e.typed_only === 1 ? (adoptions.find((a) => a.recipient_id === f.recipient_id && a.kind === f.type)?.typed_text ?? null) : null) : (values.get(f.id) ?? null),
      picture: e.typed_only !== 1 && (f.type === 'signature' || f.type === 'initials') && values.get(f.id) === 'adopted' ? `${SIGNER_API}/s/${token}/picture/${f.recipient_id}/${f.type}` : null,
    }))
  return { ...base, fields: signerFields, others, adopted: { signature: adopted.has('signature'), initials: adopted.has('initials') }, today: clientZoneDate(d.now(), client.time_zone), isoToday: dateIn(d.now(), client.time_zone), intent: intentText(me.name), typedOnly: e.typed_only === 1, document: { sha256: e.prepared_sha256 } }
}

/** The signer's own adopted picture, so the page can show it where they applied it, also after a reload. */
export async function ownPicture(d: CoreDeps, token: string, kind: string): Promise<{ bytes: Uint8Array; type: string }> {
  const r = await resolveToken(d, token)
  if (stateOf(d, r) !== 'sign') throw gone('That is not available now.')
  if (kind !== 'signature' && kind !== 'initials') throw badRequest('That is not a picture.')
  const a = (await readAdoptions(d, r.envelope.id)).find((x: AdoptionRow) => x.recipient_id === r.recipient.id && x.kind === kind)
  if (!a?.image_key) throw notFound('Picture')
  const bytes = await getSealed(d.files, a.image_key, await dataKeyFor(d, r.envelope))
  if (!bytes) throw notFound('Picture')
  return { bytes, type: bytes[0] === 0x89 ? 'image/png' : 'image/jpeg' }
}

/** An earlier signer's signature picture, for a later signer to see in place. Only once that signer has signed. */
export async function pictureOf(d: CoreDeps, token: string, recipientId: string, kind: string): Promise<{ bytes: Uint8Array; type: string }> {
  const r = await resolveToken(d, token)
  if (stateOf(d, r) !== 'sign') throw gone('That is not available now.')
  if (kind !== 'signature' && kind !== 'initials') throw badRequest('That is not a picture.')
  if (r.envelope.typed_only === 1) throw notFound('Picture')
  const owner = r.recipients.find((p) => p.id === recipientId)
  if (!owner || owner.status !== 'signed') throw notFound('Picture')
  const a = (await readAdoptions(d, r.envelope.id)).find((x: AdoptionRow) => x.recipient_id === recipientId && x.kind === kind)
  if (!a?.image_key) throw notFound('Picture')
  const bytes = await getSealed(d.files, a.image_key, await dataKeyFor(d, r.envelope))
  if (!bytes) throw notFound('Picture')
  return { bytes, type: bytes[0] === 0x89 ? 'image/png' : 'image/jpeg' }
}

/** The finished document from a recipient's own link, for 90 days after completion. Every download is an event. */
export async function downloadFinished(d: CoreDeps, token: string, origin: Origin): Promise<{ bytes: Uint8Array; filename: string }> {
  const r: Resolved = await resolveToken(d, token)
  const e: EnvelopeRow = r.envelope
  if (stateOf(d, r) !== 'complete' || !e.finished_key || !e.completed_at) throw gone('The finished document is not ready.')
  if (linkEndsAt(e) <= d.now()) throw gone('This download link has run out. Ask the business that sent it for another copy.')
  const bytes = await getSealed(d.files, e.finished_key, await dataKeyFor(d, e))
  if (!bytes) throw gone('The finished document is no longer in storage.')
  await appendEvents(d.db, e, [eventFor({ kind: 'recipient', id: r.recipient.id, email: r.recipient.email, name: r.recipient.name }, origin, { action: 'copy-downloaded', details: { recipient_id: r.recipient.id }, docHash: e.finished_sha256 })], { now: d.now() })
  return { bytes, filename: `${e.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'signed-document'}.pdf` }
}

/** A signer's own certificate page, once complete. */
export async function signerCertificate(d: CoreDeps, token: string) {
  const r = await resolveToken(d, token)
  if (stateOf(d, r) !== 'complete') throw gone('The certificate is made when everyone has signed.')
  // It names every signer's address, IP and device, so it is shown for as long as the finished document can be downloaded and no longer.
  if (linkEndsAt(r.envelope) <= d.now()) throw gone('This link has run out. Ask the business that sent it for a copy.')
  return certificateView(d, r.envelope.id)
}
