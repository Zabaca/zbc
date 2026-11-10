/**
 * Completion: when the last signer finishes, the envelope is marked sealing and the PDF engine opens the prepared document,
 * writes every value into place, flattens every field, appends the certificate of completion, attaches the event log
 * and seals it. The result is stored encrypted, the `completed` event records its hash, and every party is mailed their copy.
 *
 * Idempotent and safe to repeat: the envelope stays `sealing` if any step fails and the hourly sweep tries again, and
 * the write that completes it names `sealing` as the state it expects, so two attempts racing for one envelope complete it
 * once (the loser's file is deleted).
 */
import { sha256Hex } from '../bytes'
import { logoType } from '../clients'
import { type EventRow, appendEvents, readEvents } from '../events'
import { consentHashOf, consentTextFor } from '../consent'
import { type ConsentPrint, certificateBlocks, certificateModel } from '../pdf/certificate'
import { type FinishPlan, type Stamp, finish } from '../pdf/engine'
import { SEALING_MAX_TRIES, SEALING_RETRY_MINUTES, UNFINISHED_RETENTION_DAYS } from '../settings'
import { type ServiceWords, sealReason, viaSuffix } from '../service'
import { getSealed, putSealed } from '../vault'
import { flushAll, queueMail } from './mail'
import {
  type Anchor,
  Guarded,
  type ClientRow,
  type CoreDeps,
  type EnvelopeRow,
  LIVE,
  type RecipientRow,
  addDays,
  clientZoneDate,
  dataKeyFor,
  eventFor,
  isoAt,
  jsonOrEmpty,
  loadClient,
  loadEnvelope,
  loadFields,
  loadRecipients,
  printedAs,
} from './support'
import { readAdoptions, readValues } from './values'

const hexRgb = (h: string): [number, number, number] => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h)
  return m ? [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255] : [0.12, 0.31, 0.47]
}

const addYears = (ms: number, years: number): number => {
  const d = new Date(ms)
  d.setUTCFullYear(d.getUTCFullYear() + years)
  return d.getTime()
}

/** After a signer finishes: when every signer has signed, move the envelope to sealing and seal it. */
export async function maybeSeal(d: CoreDeps, envelopeId: string): Promise<'signed' | 'sealing' | 'complete'> {
  const e = await loadEnvelope(d.db, envelopeId)
  const signers = (await loadRecipients(d.db, envelopeId)).filter((r) => r.kind === 'signer')
  if (e.status === 'completed') return 'complete'
  if (e.status === 'sealing') return 'sealing'
  if (!(LIVE as string[]).includes(e.status) || signers.some((r) => r.status !== 'signed')) return 'signed'
  const now = d.now()
  // Two signers finishing at once both arrive here; the guard lets one of them begin sealing.
  const began = await appendEvents(d.db, e, [eventFor({ kind: 'system' }, {}, { action: 'sealing', details: { signers: signers.length }, docHash: e.prepared_sha256 })], {
    now,
    changes: (a: Anchor) => Guarded.onEvent(d.db, envelopeId, a).mutate('UPDATE envelopes SET status = ?, sealing_at = ?, purge_at = ? WHERE id = ?', 'sealing', isoAt(now), isoAt(addDays(now, UNFINISHED_RETENTION_DAYS)), envelopeId).stmts,
    whenStatus: [...LIVE],
  })
  if (!began.applied) return (await loadEnvelope(d.db, envelopeId)).status === 'completed' ? 'complete' : 'sealing'
  try {
    await completeEnvelope(d, envelopeId)
    return 'complete'
  } catch (err) {
    console.error(`sealing ${envelopeId} failed; the sweep will try again`, err)
    return 'sealing'
  }
}

/**
 * Envelopes that have been sealing too long: the sweep's retry, oldest first. Each try is counted; after SEALING_MAX_TRIES the
 * operator is told once and the sweep stops (the envelope has a purge time from the moment it began sealing, so it is deleted
 * one day even if nobody comes for it).
 */
export async function retryStuck(d: CoreDeps): Promise<number> {
  const cutoff = isoAt(d.now() - SEALING_RETRY_MINUTES * 60_000)
  const rows = (
    await d.db
      .prepare("SELECT id, sealing_attempts AS tries FROM envelopes WHERE status = 'sealing' AND sealing_attempts < ? AND (sealing_at IS NULL OR sealing_at <= ?) ORDER BY sealing_at LIMIT 10")
      .bind(SEALING_MAX_TRIES, cutoff)
      .all<{ id: string; tries: number }>()
  ).results
  let n = 0
  for (const { id, tries } of rows) {
    // Claim the try: two sweeps must not both take it, and the next try waits its interval from now.
    const claim = (await d.db.prepare("UPDATE envelopes SET sealing_attempts = sealing_attempts + 1, sealing_at = ? WHERE id = ? AND status = 'sealing' AND sealing_attempts = ?").bind(isoAt(d.now()), id, tries).run()) as { meta?: { changes?: number } }
    if (claim.meta?.changes === 0) continue
    try {
      await completeEnvelope(d, id)
      n++
    } catch (err) {
      console.error(`sealing ${id} failed (try ${tries + 1} of ${SEALING_MAX_TRIES})`, err)
      if (tries + 1 >= SEALING_MAX_TRIES) await giveUp(d, id, String((err as Error)?.message ?? err))
    }
  }
  return n
}

async function giveUp(d: CoreDeps, id: string, why: string): Promise<void> {
  const e = await loadEnvelope(d.db, id)
  if (e.status !== 'sealing') return
  const client = await loadClient(d.db, e.client_id)
  const g = Guarded.onState(d.db, id, ['sealing'])
  const mailId = queueMail(g, d, {
    envelope: e,
    client,
    to: d.notice,
    kind: 'notice',
    data: { headline: `Could not finish ${e.title} (${client.display_name})`, body: `Everyone signed ${e.title} for ${client.display_name}, but sealing it failed ${SEALING_MAX_TRIES} times in a row, so the sweep has stopped trying. The reason on the last try: ${why.slice(0, 300)}. Look at Workers Logs for "sealing ${id}". It will be deleted automatically in ${UNFINISHED_RETENTION_DAYS} days.` },
  })
  await d.db.batch(g.stmts)
  await flushAll(d, [mailId])
}

type Picture = { bytes: Uint8Array; format: 'png' | 'jpeg' }

/**
 * The consent text of each version a signer on this envelope recorded, rebuilt from the version's own wording with the names the envelope was sent under (`printedAs`), so each recorded fingerprint (the hash of what the signer
 * was shown) is checked against it. It differs only when the business's reply address changed since or, for an envelope sent before the names were kept (`snapshot` false), when the business was renamed since; the certificate then
 * says that the printed words are the version's, not a copy of the screen.
 */
async function consentPrints(e: EnvelopeRow, client: ClientRow, snapshot: boolean, recipients: RecipientRow[], log: EventRow[], service: ServiceWords): Promise<ConsentPrint[]> {
  const versions = [...new Set(recipients.filter((r) => r.kind === 'signer' && r.consent_version).map((r) => r.consent_version!))].sort()
  const recorded = log.filter((ev) => ev.action === 'consented').map((ev) => jsonOrEmpty(ev.details) as { version?: unknown; text_sha256?: unknown })
  const changed = snapshot
    ? "The business's reply address has changed since a signer agreed, so the address below is the current one."
    : "The business's name or address has changed since a signer agreed, so the names and address below are the current ones."
  return Promise.all(
    versions.map(async (version) => {
      const paragraphs = consentTextFor(version, { ...client, title: e.title, service })
      if (!paragraphs) return { version, paragraphs: null, note: null }
      const hash = await consentHashOf(version, paragraphs)
      const differs = recorded.some((r) => r.version === version && r.text_sha256 !== hash)
      return { version, paragraphs, note: differs ? `${changed} The wording is the version's own; the log holds the fingerprint of exactly what that signer was shown.` : null }
    }),
  )
}

async function imageOf(d: CoreDeps, key: Uint8Array, objectKey: string | null): Promise<Picture | null> {
  const bytes = objectKey ? await getSealed(d.files, objectKey, key) : null
  const type = bytes ? logoType(bytes) : null
  return bytes && type ? { bytes, format: type === 'image/png' ? 'png' : 'jpeg' } : null
}

/**
 * The certificate of completion's content for an envelope: the model, each signer's signature picture and the client's
 * branding. The events are those up to and including `sealing`, so the page in the PDF and the page on the web match.
 */
export async function gatherCertificate(d: CoreDeps, e: EnvelopeRow, row: ClientRow, key: Uint8Array, at: Date, seal: { subject: string; rootFingerprint: string }) {
  // The names the envelope was sent under, so the page on the web and the page in the sealed PDF say the same however the business was renamed since.
  const { client, snapshot } = printedAs(e, row)
  const recipients = await loadRecipients(d.db, e.id)
  const adoptions = await readAdoptions(d, e.id)
  const events = await readEvents(d.db, e.id)
  const sealing = events.filter((ev) => ev.action === 'sealing').pop()
  const log = sealing ? events.filter((ev) => ev.seq <= sealing.seq) : events
  const images = new Map<string, Picture>()
  // Typed name only: no picture is placed or shown; the typed name is on the certificate as text.
  for (const a of e.typed_only === 1 ? [] : adoptions.filter((x) => x.kind === 'signature')) {
    const image = await imageOf(d, key, a.image_key)
    if (image) images.set(a.recipient_id, image)
  }
  const source = e.source_document_id ? await d.db.prepare('SELECT original_sha256 FROM source_documents WHERE id = ?').bind(e.source_document_id).first<{ original_sha256: string }>() : null
  const sent = log.find((ev) => ev.action === 'sent')
  const sentDetails = sent ? (JSON.parse(sent.details) as Record<string, unknown>) : {}
  const by = (email: string, action: string) => log.find((ev) => ev.action === action && ev.actor_kind === 'recipient' && ev.actor_email === email)
  const model = certificateModel({
    client,
    consents: await consentPrints(e, client, snapshot, recipients, log, d.service),
    envelope: { id: e.id, title: e.title, kind: e.kind, order_mode: e.order_mode, created_at: e.created_at, sent_at: e.sent_at, completed_at: at.toISOString(), prepared_sha256: e.prepared_sha256!, original_sha256: source?.original_sha256 ?? null },
    sent: { by: e.sent_by ?? 'unknown', agent: sent?.actor_kind === 'agent', instruction_sha256: typeof sentDetails.instruction_sha256 === 'string' ? sentDetails.instruction_sha256 : null },
    recipients: recipients.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      kind: r.kind,
      position: r.position,
      opened_at: r.opened_at,
      consent_at: r.consent_at,
      consent_version: r.consent_version,
      signed_at: r.signed_at,
      consent_ip: by(r.email, 'consented')?.ip ?? null,
      signed_ip: by(r.email, 'signed')?.ip ?? null,
      signed_device: by(r.email, 'signed')?.device ?? null,
      adoptions: adoptions.filter((a) => a.recipient_id === r.id).map((a) => ({ kind: a.kind, method: a.method, typed_text: a.typed_text })),
    })),
    events: log,
    seal,
    principal: d.owner.mailName,
    service: d.service,
  })
  return { model, images, log, recipients, adoptions }
}


export type Placement = { kind: 'picture' } | { kind: 'fill'; name: string; value: string | boolean } | { kind: 'stamp'; text: string } | { kind: 'check' } | { kind: 'none' }

/**
 * Where a signer's value goes in the finished PDF. A field that fills one of the PDF's own fields (it has `pdf_field_name`) is
 * written INTO that field, whatever its type (a date too), and then flattened with the rest; any other is stamped at its box. A
 * signature or initials is a picture, stamped. An unchecked box places nothing.
 */
export function placeValue(f: { type: string; pdf_field_name: string | null }, v: unknown): Placement {
  if (f.type === 'signature' || f.type === 'initials') return { kind: 'picture' }
  // The file's own checkbox may already be ticked (its /AS says so), and flattening keeps whatever is there: an unchecked answer is
  // written into it as false, so it is unticked. A box of our own has nothing under it and stamps nothing.
  if (f.type === 'checkbox') return f.pdf_field_name ? { kind: 'fill', name: f.pdf_field_name, value: v === true } : v === true ? { kind: 'check' } : { kind: 'none' }
  const text = f.type === 'date' ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'medium' }).format(new Date(`${String(v)}T12:00:00Z`)) : String(v)
  return f.pdf_field_name ? { kind: 'fill', name: f.pdf_field_name, value: text } : { kind: 'stamp', text }
}

/** Seals a sealing envelope. Throws if any step fails, leaving it sealing. */
export async function completeEnvelope(d: CoreDeps, envelopeId: string): Promise<void> {
  const e = await loadEnvelope(d.db, envelopeId)
  if (e.status !== 'sealing') return
  const client = await loadClient(d.db, e.client_id)
  const fields = await loadFields(d.db, envelopeId)
  const key = await dataKeyFor(d, e)
  const prepared = e.prepared_key ? await getSealed(d.files, e.prepared_key, key) : null
  if (!prepared) throw new Error('The prepared document is missing from storage')
  const values = await readValues(d, e, key)
  const sealer = await d.sealer()
  const at = new Date(d.now())
  const cert = await gatherCertificate(d, e, client, key, at, sealer)
  if (!cert.log.some((ev) => ev.action === 'sealing')) throw new Error('The envelope has no sealing event')

  // Values into place. A field that fills one of the PDF's own fields is written into it; the rest are stamped.
  const stamps: Stamp[] = []
  const fieldFills: NonNullable<FinishPlan['fieldFills']> = []
  for (const f of fields) {
    const v = values.get(f.id)
    if (v === undefined || v === null) {
      // A checkbox the signer never touched is unchecked, and the file's own box may be ticked: write that, or flattening keeps the tick.
      if (f.type === 'checkbox' && f.pdf_field_name) fieldFills.push({ name: f.pdf_field_name, value: false })
      continue
    }
    const box = { x: f.x, y: f.y, width: f.width, height: f.height }
    const place = placeValue(f, v)
    if (place.kind === 'picture') {
      const a = cert.adoptions.find((x) => x.recipient_id === f.recipient_id && x.kind === f.type)
      // Typed name only: the signature is the name the signer typed, drawn here as text. The browser's picture is never placed, so a
      // request that claims a typed name and brings another picture puts nothing on the page.
      if (e.typed_only === 1) {
        if (!a || a.method !== 'typed' || !a.typed_text) throw new Error(`A ${f.type} was applied but no typed name is recorded`)
        stamps.push({ page: f.page, box, kind: 'text', text: a.typed_text, color: [0.06, 0.11, 0.25] })
        continue
      }
      const image = a ? await imageOf(d, key, a.image_key) : null
      if (!image) throw new Error(`A ${f.type} was applied but its picture is missing`)
      stamps.push({ page: f.page, box, kind: 'image', bytes: image.bytes, format: image.format })
    } else if (place.kind === 'fill') fieldFills.push({ name: place.name, value: place.value })
    else if (place.kind === 'check') stamps.push({ page: f.page, box, kind: 'check' })
    else if (place.kind === 'stamp') stamps.push({ page: f.page, box, kind: 'text', text: place.text })
  }

  const logo = client.logo_key ? await d.files.get(client.logo_key) : null
  const logoBytes = logo ? new Uint8Array(await logo.arrayBuffer()) : null
  const logoMime = logoBytes ? logoType(logoBytes) : null
  const pages = certificateBlocks(cert.model, { color: hexRgb(client.accent_color), via: viaSuffix(d.service), logo: logoBytes && logoMime ? { bytes: logoBytes, format: logoMime === 'image/png' ? 'png' : 'jpeg' } : undefined }, cert.images)

  const done = await finish(prepared, {
    fieldFills,
    stamps,
    appendBlocks: [pages],
    attachments: [{ name: 'events.json', data: new TextEncoder().encode(JSON.stringify({ envelope: e.id, chain_last: cert.model.chain.last, events: cert.log.map(plainEvent) }, null, 2)), mimeType: 'application/json', description: 'The event log of this envelope, each event chained to the one before' }],
    seal: { signer: sealer.signer, timestampAuthority: sealer.timestampAuthority, reason: sealReason(d.service), at },
  })
  if (!done.ok) throw new Error(done.refusal.message)
  const sha = await sha256Hex(done.value.bytes)
  const finishedKey = `envelopes/${envelopeId}/finished/${sha}`
  await putSealed(d.files, finishedKey, key, done.value.bytes, 'application/pdf')

  const completedAt = at.getTime()
  const everyone = cert.recipients
  const mailIds: string[] = []
  const build = (a: Anchor) => {
    mailIds.length = 0
    const g = Guarded.onEvent(d.db, envelopeId, a)
    for (const r of everyone) mailIds.push(queueMail(g, d, { envelope: e, client, recipient: r, kind: 'completed' }))
    mailIds.push(
      queueMail(g, d, {
        envelope: e,
        client,
        to: d.notice,
        kind: 'notice',
        data: { headline: `${e.title} is complete (${client.display_name})`, body: `Everyone has signed ${e.title} for ${client.display_name}. The sealed document went to ${everyone.length} ${everyone.length === 1 ? 'person' : 'people'}${e.sensitive ? ' by private link, because it holds private information' : ''}. You can download it from the envelope's page in the admin.` },
      }),
    )
    g.mutate('UPDATE envelopes SET status = ?, finished_key = ?, finished_sha256 = ?, finished_size = ?, completed_at = ?, purge_at = ? WHERE id = ?', 'completed', finishedKey, sha, done.value.bytes.length, at.toISOString(), isoAt(addYears(completedAt, client.retention_years)), envelopeId)
    return g.stmts
  }
  const written = await appendEvents(d.db, e, [eventFor({ kind: 'system' }, {}, { action: 'completed', details: { finished_sha256: sha, size: done.value.bytes.length, delivery: e.sensitive ? 'link' : 'attached', on: clientZoneDate(completedAt, client.time_zone) }, docHash: sha })], { now: completedAt, changes: build, whenStatus: ['sealing'] })
  if (!written.applied) {
    // Another attempt completed it first: its file stands, this one's is not wanted.
    const now = await loadEnvelope(d.db, envelopeId)
    if (now.finished_key !== finishedKey) await d.files.delete(finishedKey)
    return
  }
  await flushAll(d, mailIds)
}

const plainEvent = (ev: EventRow) => ({ seq: ev.seq, at: ev.at, actor_kind: ev.actor_kind, actor_email: ev.actor_email, actor_name: ev.actor_name, action: ev.action, ip: ev.ip, device: ev.device, details: JSON.parse(ev.details), doc_hash: ev.doc_hash, prev_hash: ev.prev_hash, hash: ev.hash })
