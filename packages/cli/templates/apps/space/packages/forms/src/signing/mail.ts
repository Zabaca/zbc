/**
 * Recording a message and sending it. No mail leaves without its row first: the row is written as `pending` in the SAME batch
 * as the state change that caused it (so a change that lands always has its message on record, and a Worker that stops
 * between the two leaves a pending row the hourly sweep sends), then `flushMail` sends it and marks it sent or failed with the
 * reason, and a sent message is an event on the envelope. A message is built from its row each time it is sent, from the
 * envelope's current state and a few non-secret facts in `mail.data`, so a retry sends what the first try would have.
 */
import { appendEvents } from '../events'
import { type MailKind, type MailSpec, renderMail, senderFor } from '../mail'
import { SIGNER_API } from '../paths'
import { type Row, newId } from '../records'
import { MAIL_ATTACH_MAX_BYTES } from '../settings'
import { getSealed } from '../vault'
import {
  type ClientRow,
  type CoreDeps,
  type EnvelopeRow,
  type Writer,
  type RecipientRow,
  clientZoneDate,
  dataKeyFor,
  decryptToken,
  isClientCopy,
  linkEndsAt,
  LIVE,
  isoAt,
  jsonOrEmpty,
} from './support'

export interface MailRequest {
  envelope: Pick<EnvelopeRow, 'id' | 'client_id'>
  client: Pick<ClientRow, 'display_name' | 'reply_to'>
  /** The recipient it is for; absent for an operator's notice. */
  recipient?: Pick<RecipientRow, 'id' | 'email' | 'name'>
  kind: MailKind
  /** For a message to someone who is not a recipient (the operator). */
  to?: { email: string; name: string }
  data?: Record<string, unknown>
  instructionId?: string | null
}

/** The pending row for a message, to be inserted with the change that causes it. Returns the row's id for the flush. */
export function queueMail(g: Writer, d: CoreDeps, m: MailRequest): string {
  const id = newId()
  const to = m.to ?? { email: m.recipient!.email, name: m.recipient!.name }
  g.insert('mail', {
    id,
    client_id: m.envelope.client_id,
    envelope_id: m.envelope.id,
    recipient_id: m.recipient?.id ?? null,
    kind: m.kind,
    to_email: to.email,
    to_name: to.name,
    from_name: senderFor(m.kind === 'notice' || m.kind === 'expired' ? null : m.client.display_name, d.service).name,
    reply_to: m.kind === 'notice' || m.kind === 'expired' ? null : m.client.reply_to,
    subject: '',
    status: 'pending',
    created_at: isoAt(d.now()),
    data: JSON.stringify(m.data ?? {}),
    instruction_id: m.instructionId ?? null,
  })
  return id
}

/** The messages that carry a recipient's private link to sign. */
const LINK_KINDS: MailKind[] = ['request', 'reminder', 'turn']

const fileName = (title: string) => `${title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'signed-document'}.pdf`

/** How many files a form's customer uploaded to this envelope. */
const uploadCount = async (d: CoreDeps, envelopeId: string): Promise<number> => (await d.db.prepare('SELECT COUNT(*) AS n FROM uploads WHERE envelope_id = ?').bind(envelopeId).first<{ n: number }>())?.n ?? 0

async function specFor(d: CoreDeps, row: Row, envelope: EnvelopeRow, client: ClientRow, recipient: RecipientRow | null): Promise<{ spec: MailSpec; attachment?: { filename: string; bytes: Uint8Array } }> {
  const data = jsonOrEmpty(row.data as string | null)
  const kind = row.kind as MailKind
  const brand = {
    name: client.display_name,
    accent: client.accent_color,
    logoUrl: client.logo_sha256 ? `${d.origin}${SIGNER_API}/logo/${client.id}?v=${client.logo_sha256}` : null,
    replyTo: client.reply_to,
  }
  const spec: MailSpec = { kind, brand, service: d.service, title: envelope.title, toName: String(row.to_name ?? ''), note: envelope.note, expiresOn: envelope.expires_at ? clientZoneDate(Date.parse(envelope.expires_at), client.time_zone) : null }
  let key: Uint8Array | null = null
  const link = async () => {
    key ??= await dataKeyFor(d, envelope)
    const token = recipient ? await decryptToken(key, recipient) : null
    return token ? `${d.origin}/s/${token}` : undefined
  }
  switch (kind) {
    case 'request':
    case 'reminder':
    case 'turn':
      spec.link = await link()
      return { spec }
    case 'completed': {
      // The client's own copy addresses also get the files its customer uploaded, by this same private link and never attached
      // (they are often ID images). The message carries the count and nothing else about them.
      const fileCount = recipient && isClientCopy(client, recipient) ? await uploadCount(d, envelope.id) : 0
      const byLink = envelope.sensitive === 1 || (envelope.finished_size ?? 0) > MAIL_ATTACH_MAX_BYTES
      if (fileCount > 0) spec.uploads = fileCount
      if (byLink || fileCount > 0) {
        spec.link = await link()
        spec.linkUntil = envelope.completed_at ? clientZoneDate(linkEndsAt(envelope), client.time_zone) : null
      }
      if (byLink) {
        spec.delivery = 'link'
        return { spec }
      }
      spec.delivery = 'attached'
      key ??= await dataKeyFor(d, envelope)
      const bytes = envelope.finished_key ? await getSealed(d.files, envelope.finished_key, key) : null
      if (!bytes) throw new Error('The finished document is not in storage')
      return { spec, attachment: { filename: fileName(envelope.title), bytes } }
    }
    case 'declined':
      spec.reason = (data.reason as string | undefined) ?? null
      spec.declinedBy = (data.declinedBy as string | undefined) ?? null
      return { spec }
    case 'cancelled':
      spec.reason = (data.reason as string | undefined) ?? null
      return { spec }
    case 'expired':
      return { spec }
    case 'notice':
      spec.headline = String(data.headline ?? '')
      spec.body = String(data.body ?? '')
      return { spec }
  }
}

/** Sends one recorded message and records the outcome. A refusal from the mail service is recorded, never thrown. */
export async function flushMail(d: CoreDeps, mailId: string): Promise<'sent' | 'failed' | 'pending' | 'skipped'> {
  const row = await d.db.prepare('SELECT * FROM mail WHERE id = ?').bind(mailId).first<Row>()
  if (!row || row.status !== 'pending') return 'skipped'
  // Claim it: two flushes (a request and the sweep) must not both send.
  const claim = (await d.db.prepare("UPDATE mail SET attempts = attempts + 1 WHERE id = ? AND status = 'pending' AND attempts = ?").bind(mailId, row.attempts).run()) as { meta?: { changes?: number } }
  if (claim.meta?.changes === 0) return 'skipped'
  const attempts = (row.attempts as number) + 1
  const fail = async (why: string, final: boolean) => {
    await d.db.prepare("UPDATE mail SET status = ?, error = ? WHERE id = ? AND status = 'pending'").bind(final ? 'failed' : 'pending', why.slice(0, 500), mailId).run()
    return final ? ('failed' as const) : ('pending' as const)
  }
  if (!d.mailer) return fail('The Worker has no email binding (EMAIL), so nothing was sent', true)
  try {
    const envelope = await d.db.prepare('SELECT * FROM envelopes WHERE id = ?').bind(row.envelope_id).first<EnvelopeRow>()
    if (!envelope) return fail('The envelope is gone', true)
    const client = await d.db.prepare('SELECT * FROM clients WHERE id = ?').bind(envelope.client_id).first<ClientRow>()
    const recipient = row.recipient_id ? await d.db.prepare('SELECT * FROM recipients WHERE id = ?').bind(row.recipient_id).first<RecipientRow>() : null
    if (!client) return fail('The client is gone', true)
    // A message that carries a signing link is sent only while the link is live, and only to the address it was recorded for:
    // a retry must never put a link in a hand that was corrected away, or open an envelope that has since ended.
    if (LINK_KINDS.includes(row.kind as MailKind)) {
      if (!recipient || recipient.email.toLowerCase() !== String(row.to_email).toLowerCase()) return fail("The recipient's address changed after this message was recorded", true)
      if (!(LIVE as string[]).includes(envelope.status) || (envelope.expires_at !== null && Date.parse(envelope.expires_at) <= d.now())) return fail('The envelope is no longer out for signature', true)
    }
    const { spec, attachment } = await specFor(d, row, envelope, client, recipient)
    const rendered = renderMail(spec)
    const operatorMail = row.kind === 'notice' || row.kind === 'expired'
    const sent = await d.mailer.send({
      from: senderFor(operatorMail ? null : client.display_name, d.service),
      to: { email: row.to_email as string, name: String(row.to_name ?? '') },
      ...(operatorMail ? {} : { replyTo: { email: client.reply_to, name: client.display_name } }),
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      ...(attachment ? { attachments: [{ disposition: 'attachment' as const, filename: attachment.filename, type: 'application/pdf', content: attachment.bytes.slice().buffer as ArrayBuffer }] } : {}),
    })
    const now = isoAt(d.now())
    await d.db.prepare("UPDATE mail SET status = 'sent', subject = ?, message_id = ?, sent_at = ?, error = NULL WHERE id = ?").bind(rendered.subject, sent.messageId, now, mailId).run()
    await appendEvents(d.db, { id: envelope.id, client_id: envelope.client_id }, [{ action: 'mailed', actorKind: 'system', details: { mail_id: mailId, kind: row.kind, to: row.to_email, recipient_id: row.recipient_id ?? null, ...(row.instruction_id ? { instruction_id: row.instruction_id } : {}) } }], { now: d.now() })
    return 'sent'
  } catch (e) {
    return fail(String((e as Error)?.message ?? e), attempts >= 3)
  }
}

export async function flushAll(d: CoreDeps, ids: string[]): Promise<void> {
  for (const id of ids) await flushMail(d, id)
}
