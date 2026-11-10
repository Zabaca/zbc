/**
 * The rules of signing that need no database, a browser or mail: the fingerprint of a draft, who may act now, which
 * reminders are due. Pure, so a change to any of them is checked before a customer sees it.
 */
import { sha256Hex } from '../bytes'
import { stableJson } from '../events'
import { REMINDER_HOURS } from '../settings'
import { ACTING, type EnvelopeRow, type RecipientRow, hourIn } from './support'

/**
 * The fingerprint of a draft as it stands: the document (prepared, or the form version or source it will be made from), who
 * is to sign in what order, the note, the expiry and the reminder schedule. The owner's word for a send covers exactly this;
 * a draft anyone edits afterwards no longer matches it.
 */
export function draftFingerprint(
  e: Pick<EnvelopeRow, 'client_id' | 'kind' | 'title' | 'order_mode' | 'note' | 'expires_in_days' | 'reminder_every_days' | 'reminder_max' | 'sensitive' | 'typed_only' | 'prepared_sha256' | 'form_version_id' | 'source_document_id'>,
  recipients: Pick<RecipientRow, 'position' | 'role' | 'name' | 'email' | 'kind'>[],
): Promise<string> {
  return sha256Hex(
    stableJson({
      client: e.client_id,
      kind: e.kind,
      title: e.title,
      document: e.prepared_sha256 ?? e.form_version_id ?? e.source_document_id,
      source: e.source_document_id,
      order: e.order_mode,
      note: e.note ?? '',
      expiresInDays: e.expires_in_days,
      reminder: [e.reminder_every_days, e.reminder_max],
      sensitive: e.sensitive,
      // Only when set, so a draft made before the mode existed keeps the fingerprint the owner's word was given for.
      ...(e.typed_only === 1 ? { typedOnly: 1 } : {}),
      recipients: recipients.map((r) => [r.position, r.kind, r.role, r.name, r.email.toLowerCase()]),
    }),
  )
}

/** The signers who may act now: in order only the first who has not finished, all at once everyone who has not. */
export function actingSigners<R extends Pick<RecipientRow, 'kind' | 'status' | 'position'>>(order: EnvelopeRow['order_mode'], recipients: R[]): R[] {
  const open = recipients.filter((r) => r.kind === 'signer' && (ACTING as string[]).includes(r.status)).sort((a, b) => a.position - b.position)
  return order === 'sequential' ? open.slice(0, 1) : open
}

/** Is it a time reminders may go: between 9:00 and 17:00 where the client is. */
export const inReminderHours = (ms: number, zone: string): boolean => {
  const h = hourIn(ms, zone)
  return h >= REMINDER_HOURS.from && h < REMINDER_HOURS.until
}

/** Which recipients are owed a scheduled reminder now: the ones who may act, within the count, past the interval, in the client's hours. */
export function dueReminders<R extends Pick<RecipientRow, 'kind' | 'status' | 'position' | 'reminder_count' | 'last_reminded_at' | 'notified_at'>>(
  e: Pick<EnvelopeRow, 'status' | 'order_mode' | 'reminder_every_days' | 'reminder_max' | 'expires_at'>,
  recipients: R[],
  now: number,
  zone: string,
): R[] {
  if (e.status !== 'sent' && e.status !== 'prepared') return []
  if (e.expires_at && Date.parse(e.expires_at) <= now) return []
  if (!inReminderHours(now, zone)) return []
  return actingSigners(e.order_mode, recipients).filter((r) => {
    if (r.reminder_count >= e.reminder_max) return false
    const since = r.last_reminded_at ?? r.notified_at
    return since !== null && now >= Date.parse(since) + e.reminder_every_days * 86_400_000
  })
}
