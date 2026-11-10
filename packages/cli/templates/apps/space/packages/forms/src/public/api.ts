// The signer's side of /api/s/<token>: the recipient's private link is the credential, so there is no sign-in and no cookie.
// A link that leads nowhere answers 404 with one message; a link in the wrong state answers 410 with its reason.

import type { FieldType } from '../fields'
import { SIGNER_API } from '../paths'
import type { ServiceWords } from '../service'
import type { AdoptionKind, AdoptionMethod } from '../vocab'

export interface Brand {
  name: string
  legalName: string
  accent: string
  logo: string | null
  replyTo: string
}

export interface SignerField {
  id: string
  type: FieldType
  page: number
  box: { x: number; y: number; width: number; height: number }
  required: boolean
  label: string | null
  value?: string | boolean | null
  done: boolean
}

export interface OtherField {
  id: string
  type: SignerField['type']
  page: number
  box: SignerField['box']
  by: string
  value: string | boolean | null
  picture: string | null
}

export interface View {
  /** A form's link asks the filler's questions (src/public/Filler.tsx); a document's does not. */
  kind?: 'form' | 'document'
  state: 'consent' | 'preparing' | 'sign' | 'waiting-turn' | 'waiting-others' | 'signed' | 'sealing' | 'complete' | 'declined' | 'cancelled' | 'expired'
  brand: Brand
  title: string
  note: string | null
  recipient: { name: string; role: string }
  message: string | null
  expiresOn: string | null
  consent?: { version: string; paragraphs: string[] }
  fields?: SignerField[]
  others?: OtherField[]
  adopted?: { signature: boolean; initials: boolean }
  today?: string
  isoToday?: string
  intent?: string
  /** The signer adopts a signature only by typing their own name into a blank field. */
  typedOnly?: boolean
  download?: { available: boolean; until: string; sensitive: boolean }
  certificate?: boolean
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** A file the customer uploaded, as the business's copy link lists it. */
export interface UploadedFile {
  id: string
  name: string
  size: number
  content_type: string
}

export interface Certificate {
  title: string
  summary: [string, string][]
  recipients: { id: string; heading: string; rows: [string, string][] }[]
  consents: { heading: string; paragraphs: string[]; note: string | null }[]
  chain: { last: string }
  sealParagraph: string
  viewNote: string
}

export function signerApi(token: string) {
  const base = `${SIGNER_API}/s/${token}`
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${base}${path}`, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), referrerPolicy: 'no-referrer', credentials: 'omit' })
    } catch {
      throw new ApiError('The connection was lost. Check your signal and try again.', 0)
    }
    const text = await res.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      // Not JSON.
    }
    if (!res.ok) throw new ApiError((parsed as { error?: string } | null)?.error ?? `Something went wrong (${res.status})`, res.status)
    return parsed as T
  }
  return {
    view: () => call<View>('GET', ''),
    open: () => call<{ ok: true }>('POST', '/open'),
    consent: () => call<View>('POST', '/consent'),
    adopt: (input: { kind: AdoptionKind; method: AdoptionMethod; image: string; typed_text?: string; typed_font?: string }) => call<View>('POST', '/adopt', input),
    save: (fieldId: string, value: unknown) => call<{ ok: true }>('PUT', `/fields/${fieldId}`, { value }),
    finish: () => call<{ outcome: string }>('POST', '/finish', { intent: true }),
    decline: (reason: string) => call<{ ok: true }>('POST', '/decline', { reason }),
    certificate: () => call<Certificate>('GET', '/certificate'),
    uploads: () => call<{ files: UploadedFile[] }>('GET', '/uploads'),
    uploadUrl: (id: string) => `${base}/uploads/${encodeURIComponent(id)}`,
    documentUrl: `${base}/document`,
    sampleUrl: `${base}/sample.pdf`,
    termsUrl: `${base}/terms.pdf`,
    downloadUrl: `${base}/download`,
    ownPicture: (kind: string, v: string) => `${base}/me/${kind}?v=${encodeURIComponent(v)}`,
  }
}

/**
 * The names the service says about itself (src/service.ts): the one public call that is not a link's. The signer's header and the landing and privacy pages take every name from it; a page that
 * could not read it says nothing of a service rather than a wrong name.
 */
export async function fetchService(): Promise<ServiceWords | null> {
  try {
    const res = await fetch(`${SIGNER_API}/service`, { referrerPolicy: 'no-referrer', credentials: 'omit' })
    return res.ok ? ((await res.json()) as ServiceWords) : null
  } catch {
    return null
  }
}
