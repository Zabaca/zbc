/**
 * The certificate of completion: the pages appended to the finished PDF, and the same content as a web page behind each
 * recipient's link and in the admin. One MODEL (`certificateModel`, plain data, no bytes) feeds both: `certificateBlocks`
 * lays it out as PDF pages, and the pages in the browser render the model as JSON.
 *
 * The install's service is named as the service, never as a party (and where the install's Forms sends only for its own company, the certificate says nothing of a second party at all). When Claude sent the envelope on the owner's instruction, the certificate says
 * so in those words, and carries the instruction's fingerprint but not the owner's words (which stay in the instruction row).
 */
import type { EventRow } from '../events'
import { type ServiceWords, sealRootName } from '../service'
import type { AdoptionKind, AdoptionMethod } from '../vocab'
import { type Block, type BlockPages, type Rgb, drawable } from './blocks'

export interface CertificateRecipient {
  id: string
  name: string
  email: string
  role: string
  kind: 'signer' | 'copy'
  position: number
  opened_at: string | null
  consent_at: string | null
  consent_version: string | null
  signed_at: string | null
  /** From the events: where they consented and signed from, and on what. */
  consent_ip: string | null
  signed_ip: string | null
  signed_device: string | null
  adoptions: { kind: AdoptionKind; method: AdoptionMethod; typed_text: string | null }[]
}

/** The consent text of one version a signer on this envelope agreed to, for the certificate to print. */
export interface ConsentPrint {
  version: string
  /** Null for a version this code no longer holds. */
  paragraphs: string[] | null
  /** Said under the heading when the text printed may differ from what a signer saw. */
  note: string | null
}

export interface CertificateInput {
  client: { display_name: string; legal_name: string; time_zone: string }
  envelope: {
    id: string
    title: string
    kind: 'form' | 'document'
    order_mode: 'sequential' | 'parallel'
    created_at: string
    sent_at: string | null
    /** The moment of sealing. */
    completed_at: string
    prepared_sha256: string
    /** For a PDF send, the upload as received. */
    original_sha256: string | null
  }
  /** Who sent it: an operator's address, or an agent. */
  sent: { by: string; agent: boolean; instruction_sha256: string | null }
  recipients: CertificateRecipient[]
  /** The consent text of each version a signer agreed to. */
  consents: ConsentPrint[]
  /** Every event up to and including `sealing`. */
  events: EventRow[]
  seal: { subject: string; rootFingerprint: string }
  /** The install's names for the service and who runs it: what the certificate calls the service that sealed the document, and the install's own company, which Claude acts for in the record of a send (`service.company`, src/service.ts). */
  service: ServiceWords
  /** Who Claude acts for: the name the install's owner is mailed under (`CoreDeps.owner.mailName`), named in the record of a send Claude made on their instruction. */
  principal: string
}

export interface CertificateModel {
  title: string
  client: { name: string; legalName: string }
  summary: [string, string][]
  recipients: { id: string; heading: string; rows: [string, string][]; signatures: { kind: AdoptionKind; method: string; typed: string | null }[] }[]
  copies: string[]
  consents: { heading: string; paragraphs: string[]; note: string | null }[]
  events: { n: number; at: string; actor: string; action: string; ip: string | null; device: string | null; detail: string }[]
  chain: { count: number; last: string }
  sealParagraph: string
  /** Said above the page when it is shown on the web (the PDF pages leave it out): this page is rebuilt, the sealed PDF is the record. */
  viewNote: string
}

const stamp = (iso: string | null, zone: string): string =>
  iso ? `${new Intl.DateTimeFormat('en-US', { timeZone: zone, dateStyle: 'medium', timeStyle: 'long' }).format(new Date(iso))} (${iso.replace('.000Z', 'Z')} UTC)` : 'not reached'

const METHOD = { drawn: 'drawn on screen', typed: 'typed and shown in a script font', uploaded: 'uploaded as a picture' } as const

function actorName(e: EventRow, principal: string, service: ServiceWords): string {
  switch (e.actor_kind) {
    case 'operator':
      return `${e.actor_name ?? 'An operator'} (${e.actor_email ?? 'operator'})`
    case 'recipient':
      return `${e.actor_name ?? 'A recipient'} (${e.actor_email ?? 'recipient'})`
    case 'agent':
      return `Claude, an AI assistant made by Anthropic, for ${service.company.legalName}, on the recorded instruction of ${principal}`
    case 'system':
      return service.name
  }
}

function detailOf(e: EventRow): string {
  let d: Record<string, unknown> = {}
  try {
    d = JSON.parse(e.details) as Record<string, unknown>
  } catch {
    return ''
  }
  const bits: string[] = []
  if (typeof d.to === 'string') bits.push(`to ${d.to}`)
  if (typeof d.kind === 'string') bits.push(String(d.kind))
  if (typeof d.method === 'string') bits.push(String(d.method))
  if (typeof d.version === 'string') bits.push(`version ${d.version}`)
  if (typeof d.fields === 'number') bits.push(`${d.fields} fields`)
  if (typeof d.instruction_sha256 === 'string') bits.push(`instruction ${d.instruction_sha256.slice(0, 16)}`)
  if (e.doc_hash) bits.push(`document ${e.doc_hash.slice(0, 12)}`)
  return bits.join(', ')
}

export function certificateModel(i: CertificateInput): CertificateModel {
  const zone = i.client.time_zone
  const e = i.envelope
  const summary: [string, string][] = [
    ['Envelope', e.id],
    ['Title', e.title],
    ['Business', `${i.client.display_name} (${i.client.legal_name})`],
    ['Created', stamp(e.created_at, zone)],
    ['Sent', stamp(e.sent_at, zone)],
    ['Completed', stamp(e.completed_at, zone)],
    ['Signing order', e.order_mode === 'sequential' ? 'One after another, in the order below' : 'All at once'],
    ['Document fingerprint (SHA-256)', e.prepared_sha256],
    ...(e.original_sha256 ? ([['Original upload (SHA-256)', e.original_sha256]] as [string, string][]) : []),
    ['Sent by', i.sent.agent ? `Sent by Claude, an AI assistant made by Anthropic and used by ${i.service.company.legalName}, on the recorded instruction of ${i.principal}, ${i.service.company.legalName}, for ${i.client.display_name}${i.sent.instruction_sha256 ? ` (instruction ${i.sent.instruction_sha256})` : ''}` : i.sent.by],
  ]
  const signers = i.recipients.filter((r) => r.kind === 'signer').sort((a, b) => a.position - b.position)
  return {
    title: 'Certificate of completion',
    client: { name: i.client.display_name, legalName: i.client.legal_name },
    summary,
    recipients: signers.map((r, n) => ({
      id: r.id,
      heading: `${n + 1}. ${r.name} (${r.role})`,
      rows: [
        ['Email', r.email],
        ['Reached', `By email to ${r.email}, with a private link`],
        ['First opened', stamp(r.opened_at, zone)],
        ['Agreed to sign electronically', r.consent_at ? `${stamp(r.consent_at, zone)}, consent text version ${r.consent_version ?? 'unknown'}${r.consent_ip ? `, from ${r.consent_ip}` : ''}` : 'not reached'],
        ['Signed', `${stamp(r.signed_at, zone)}${r.signed_ip ? `, from ${r.signed_ip}` : ''}${r.signed_device ? ` on ${r.signed_device}` : ''}`],
      ],
      signatures: r.adoptions.map((a) => ({ kind: a.kind, method: METHOD[a.method], typed: a.typed_text })),
    })),
    copies: i.recipients.filter((r) => r.kind === 'copy').map((r) => r.email),
    consents: i.consents.map((c) => ({ heading: `The consent text, version ${c.version}`, paragraphs: c.paragraphs ?? [], note: c.paragraphs ? c.note : 'The words of this version are not held by this service any more; the recorded fingerprint of what the signer was shown is in the event log.' })),
    events: i.events.map((ev) => ({ n: ev.seq, at: ev.at, actor: actorName(ev, i.principal, i.service), action: ev.action, ip: ev.ip, device: ev.device, detail: detailOf(ev) })),
    chain: { count: i.events.length, last: i.events[i.events.length - 1]?.hash ?? '' },
    viewNote: 'This page is rebuilt from the record each time it is opened. The certificate pages inside the sealed PDF are the record; for a document sealed before November 1, 2026 they may word some lines differently and may not print the consent text.',
    sealParagraph: `This document was sealed by ${i.service.name} on ${stamp(e.completed_at, zone)}.${i.service.ownCompanyOnly ? '' : ` ${i.service.name} is the service that sealed it and is never a party to it.`} A PDF reader's signature panel shows whether anything changed after sealing. The seal's certificate (${i.seal.subject}) was issued by ${sealRootName(i.service)}, whose SHA-256 fingerprint is ${i.seal.rootFingerprint}; the root is not on any reader's trust list, so a reader shows the signer's validity as unknown. The event log is attached to this PDF as events.json, and its last link is printed above.`,
  }
}

/** The model as PDF pages, in the client's branding. `images` maps a recipient's id to their signature picture. */
export function certificateBlocks(model: CertificateModel, brand: { color: Rgb; /** "via <the service's name>", under the business's name. */ via: string; logo?: { bytes: Uint8Array; format: 'png' | 'jpeg' } }, images: Map<string, { bytes: Uint8Array; format: 'png' | 'jpeg' }>): BlockPages {
  const blocks: Block[] = []
  blocks.push({ kind: 'heading', text: 'The document' })
  for (const [label, value] of model.summary) blocks.push({ kind: 'row', label, value })
  blocks.push({ kind: 'space' }, { kind: 'rule' }, { kind: 'heading', text: 'Who signed' })
  for (const r of model.recipients) {
    blocks.push({ kind: 'text', text: r.heading, bold: true, size: 10.5 })
    for (const [label, value] of r.rows) blocks.push({ kind: 'row', label, value })
    for (const s of r.signatures) {
      blocks.push({ kind: 'row', label: s.kind === 'signature' ? 'Signature adopted' : 'Initials adopted', value: `${METHOD_OF(s.method)}${s.typed ? `: ${s.typed}` : ''}` })
    }
    const image = images.get(r.id)
    if (image) blocks.push({ kind: 'image', bytes: image.bytes, format: image.format, maxWidth: 160, maxHeight: 48, caption: 'The signature as applied' })
    blocks.push({ kind: 'space' })
  }
  if (model.copies.length > 0) blocks.push({ kind: 'row', label: 'Copies sent to', value: model.copies.join(', ') }, { kind: 'space' })
  for (const c of model.consents) {
    blocks.push({ kind: 'rule' }, { kind: 'heading', text: c.heading })
    if (c.note) blocks.push({ kind: 'text', size: 8.5, text: c.note, bold: true })
    for (const para of c.paragraphs) blocks.push({ kind: 'text', size: 8.5, text: para }, { kind: 'space', height: 3 })
  }
  blocks.push({ kind: 'rule' }, { kind: 'heading', text: 'Every event' })
  for (const ev of model.events) {
    blocks.push({ kind: 'text', size: 8, text: `${ev.n}. ${ev.at.replace('.000Z', 'Z')}  ${ev.action}  ${drawable(ev.actor)}${ev.ip ? `  ${ev.ip}` : ''}${ev.device ? `  ${ev.device}` : ''}${ev.detail ? `  ${ev.detail}` : ''}` })
  }
  blocks.push({ kind: 'space' }, { kind: 'row', label: 'Last link of the event chain (SHA-256)', value: model.chain.last }, { kind: 'space' }, { kind: 'text', size: 9, text: model.sealParagraph })
  return { title: model.title, brand: { name: model.client.name, via: brand.via, color: brand.color, logo: brand.logo }, blocks }
}

const METHOD_OF = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
