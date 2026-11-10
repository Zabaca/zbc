// The admin's side of the operator API, at /forms/api (the space hands it to forms, src/forms.ts). Every call is same-origin, so Access's cookie rides along; a session that has ended
// makes Access answer a redirect to its sign-in page, which a fetch cannot read, and that shows as a network error
// (`SignedOut`): the page reloads itself to sign in again (session.ts), or, if it has just tried, says to reload.

import type { ConversationApp, ConversationRef } from '@space/workspace'
import type { EnvelopeStatus } from '@space/forms/src/vocab'
import { API_BASE, LOGO_BASE, reloadToSignIn, signInEnded } from './session'

/**
 * A client of Forms is a Client's SIGNING SETTINGS: its id is Forms' own and never changes; `client_number` is the Client of the space it belongs to, or null for a row made before the
 * Clients part existed ("not linked to a Client"). Its names are Forms' copy of the Client's, changed in Settings, never here. `client_archived` is whether that Client is archived (null: not linked, or the Clients list could not be read).
 */
export interface Client {
  id: string
  slug: string
  client_number: number | null
  client_archived: boolean | null
  display_name: string
  legal_name: string
  accent_color: string
  reply_to: string
  copy_addresses: string[]
  time_zone: string
  retention_years: number
  has_logo: boolean
  logo_type: 'image/png' | 'image/jpeg' | null
  logo_sha256: string | null
  created_at: string
  updated_at: string
}

export type ClientInput = Partial<Pick<Client, 'accent_color' | 'reply_to' | 'copy_addresses' | 'time_zone' | 'retention_years'>> & { slug?: string; client_number?: number }

/** An active Client that has no signing settings yet: what Set up signing and Link offer. */
export interface UnsetClient {
  number: number
  name: string
  legalName: string | null
}

export interface AuditRow {
  id: number
  at: string
  actor: string
  action: string
  client_id: string | null
  entity: string
  entity_id: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

export type SealStatus =
  | { configured: true; subject: string; notAfter: string; daysLeft: number; rootFingerprint: string; certFingerprint: string; level: 'B-B' | 'B-T' }
  | { configured: false; reason: string }

export interface SealCheckReport {
  input: { bytes: number; synthetic: boolean }
  inspection: { pageCount: number; scannedPages: number[]; xfa: string; recovered: boolean }
  workingBytes: number
  outputBytes: number
  outputSha256: string
  seal: { subject: string; rootFingerprint: string; level: string }
  stagesMs: Record<string, number>
}

export interface StorageCheck {
  masterVersion: number
  roundTrip: boolean
  refusedWithoutKey: boolean | string
  refusedWithAnotherKey: boolean | string
}

export class SignedOut extends Error {
  /**
   * `confirmed` is whether Access is known to have ended the sign-in (a 401, a redirect, an answer that is not JSON). Then the page
   * reloads, which Access can send to its sign-in, and brings the person back (session.ts). Unconfirmed (a call that failed with
   * nothing to show why) only says so on the page, which keeps what the person typed.
   */
  constructor(confirmed = true) {
    super('Your sign-in has ended. Reload the page to sign in again.')
    if (confirmed) reloadToSignIn()
  }
}

/**
 * A call that failed to complete. A fetch cannot tell a dropped connection from Access's sign-in redirect (both are a network error),
 * and reloading the page on a blip as the person presses Save would throw away what they typed. So ask: `/me` with the redirect left
 * unfollowed. Only a redirect or a 401 is the sign-in ending; anything else (including no answer) is a blip, and the page keeps its state.
 */
export async function lostConnection(): Promise<SignedOut> {
  return new SignedOut(await signInEnded())
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function call<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), ...init })
  } catch {
    throw await lostConnection()
  }
  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    // Not JSON: Access's own page, most likely.
  }
  if (!res.ok) {
    const message = (parsed as { error?: string } | null)?.error
    if (res.status === 401 || (!message && res.redirected)) throw new SignedOut()
    throw new ApiError(message ?? `The request failed (${res.status})`, res.status)
  }
  if (parsed === null && text) throw new SignedOut()
  return parsed as T
}

export interface EnvelopeSummary {
  id: string
  client_id: string
  client_name: string
  kind: 'form' | 'document'
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
  /** The conversation it was sent from. Absent from a forms that predates conversations. */
  conversation_app?: ConversationApp | null
  conversation_id?: string | null
  created_by: string
  sent_by: string | null
  created_at: string
  sent_at: string | null
  completed_at: string | null
  purge_at: string | null
  finished_size: number | null
  signers?: number
  signed?: number
}

export interface RecipientView {
  id: string
  role: string
  name: string
  email: string
  kind: 'signer' | 'copy'
  position: number
  status: 'waiting' | 'sent' | 'opened' | 'consented' | 'signed' | 'declined'
  consent_at: string | null
  opened_at: string | null
  signed_at: string | null
  declined_at: string | null
  decline_reason: string | null
  reminder_count: number
  last_reminded_at: string | null
  notified_at: string | null
  fields: number
}

export interface EventView {
  seq: number
  at: string
  actor_kind: 'operator' | 'recipient' | 'system' | 'agent'
  actor_email: string | null
  actor_name: string | null
  action: string
  ip: string | null
  device: string | null
  details: Record<string, unknown>
  doc_hash: string | null
  hash: string
}

export interface InstructionView {
  id: string
  action: string
  words: string
  channel: string
  said_at: string
  recorded_at: string
  recorded_by: string
  sha256: string
  used: boolean
}

export interface MailView {
  id: string
  recipient_id: string | null
  kind: string
  to_email: string
  subject: string
  status: 'pending' | 'sent' | 'failed'
  error: string | null
  attempts: number
  instruction_id: string | null
  created_at: string
  sent_at: string | null
}

export interface EnvelopeView {
  envelope: EnvelopeSummary
  recipients: RecipientView[]
  events: EventView[]
  chain: { ok: true; count: number; last: string } | { ok: false; brokenAt: number; why: string }
  mail: MailView[]
  instructions: InstructionView[]
  agentSending: boolean
}

export interface CertificateModel {
  title: string
  client: { name: string; legalName: string }
  summary: [string, string][]
  recipients: { id: string; heading: string; rows: [string, string][]; signatures: { kind: string; method: string; typed: string | null }[] }[]
  copies: string[]
  events: { n: number; at: string; actor: string; action: string; ip: string | null; device: string | null; detail: string }[]
  chain: { count: number; last: string }
  sealParagraph: string
  viewNote: string
}

export interface MailPreview {
  from: string
  replyTo: string
  to: string
  subject: string
  html: string
  text: string
}

export interface RecipientInput {
  role: string
  name: string
  email: string
  kind?: 'signer' | 'copy'
}

export interface DraftInput {
  client_id: string
  /** What to send: `type` names a builder in src/sources.ts. */
  source: { type: string; [key: string]: unknown }
  title?: string
  recipients: RecipientInput[]
  order: 'sequential' | 'parallel'
  note?: string
  expires_in_days?: number
  reminder_every_days?: number
  reminder_max?: number
  sensitive?: boolean
  typed_only?: boolean
  /** The conversation in the space this is sent from. A forms that predates conversations ignores it. */
  conversation?: ConversationRef
}

export const api = {
  envelopes: (filter: { client?: string; status?: string } = {}) => call<EnvelopeSummary[]>('GET', `/envelopes?${new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][])}`),
  envelope: (id: string) => call<EnvelopeView>('GET', `/envelopes/${id}`),
  createEnvelope: (input: DraftInput) => call<EnvelopeView>('POST', '/envelopes', input),
  sendEnvelope: (id: string) => call<EnvelopeView>('POST', `/envelopes/${id}/send`, {}),
  remind: (id: string, recipientId?: string) => call<EnvelopeView>('POST', `/envelopes/${id}/remind`, { recipient_id: recipientId }),
  cancel: (id: string, reason: string) => call<EnvelopeView>('POST', `/envelopes/${id}/cancel`, { reason }),
  correct: (id: string, recipientId: string, email: string, name?: string) => call<EnvelopeView>('POST', `/envelopes/${id}/recipients/${recipientId}/correct`, { email, name }),
  purge: (id: string) => call<{ purged: boolean }>('POST', `/envelopes/${id}/purge`, {}),
  preview: (id: string) => call<MailPreview>('GET', `/envelopes/${id}/preview-email`),
  certificate: (id: string) => call<CertificateModel>('GET', `/envelopes/${id}/certificate`),
  finishedUrl: (id: string) => `${API_BASE}/envelopes/${id}/finished.pdf`,
  clients: () => call<Client[]>('GET', '/clients'),
  client: (id: string) => call<Client>('GET', `/clients/${id}`),
  /** The active Clients with no signing settings; `available` is false when the Clients list could not be read. */
  clientsNotSetUp: () => call<{ available: boolean; clients: UnsetClient[] }>('GET', '/clients-not-set-up'),
  createClient: (input: ClientInput) => call<Client>('POST', '/clients', input),
  /** Link a row made before the Clients part to a Client the operator picked. */
  linkClient: (id: string, clientNumber: number) => call<Client>('PUT', `/clients/${id}/link`, { client_number: clientNumber }),
  updateClient: (id: string, input: ClientInput) => call<Client>('PATCH', `/clients/${id}`, input),
  uploadLogo: (id: string, file: File) => call<Client>('PUT', `/clients/${id}/logo`, undefined, { body: file }),
  audit: (client?: string) => call<AuditRow[]>('GET', `/audit${client ? `?client=${client}` : ''}`),
  seal: () => call<SealStatus>('GET', '/seal'),
  sealCheck: (mb?: number) => call<SealCheckReport>('POST', `/seal-check?report=1${mb ? `&mb=${mb}` : ''}`),
  storageCheck: () => call<StorageCheck>('POST', '/storage-check'),
  sampleUrl: (id: string) => `${API_BASE}/clients/${id}/sample.pdf`,
}

export const logoUrl = (c: Pick<Client, 'id' | 'logo_sha256'>) => `${LOGO_BASE}/${c.id}?v=${c.logo_sha256 ?? ''}`
