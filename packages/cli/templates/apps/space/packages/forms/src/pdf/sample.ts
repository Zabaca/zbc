/**
 * The sealed sample document: a one-page letter in a client's branding (its name, accent color and
 * logo), a mock signature, a page that says what a certificate of completion will carry, an attached event log,
 * and the seal. The owner downloads it from a client's page, opens it in Acrobat Reader and sees "Signed by <service name>
 * Seal, validity unknown, and the document has not been modified since the signature was applied".
 *
 * It is made from the same engine calls a real completion uses, so it proves the seal, not a lookalike. It signs
 * nobody's name and says so on its face.
 */
import { PDF, rgb } from '@libpdf/core'
import { FIELD_CATALOG, type FieldType, type PreparedDocument, type PreparedField } from '../fields'
import { type FinishPlan, type Result, finish } from './engine'
import { type ServiceWords, sealReason, sealRootName, viaSuffix } from '../service'
import type { Sealer } from '../seal/sealer'

export interface SampleClient {
  display_name: string
  legal_name: string
  accent_color: string
  reply_to: string
  time_zone: string
}

export interface SampleLogo {
  bytes: Uint8Array
  type: 'image/png' | 'image/jpeg'
}

const hexToRgb = (h: string): [number, number, number] => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h)
  return m ? [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255] : [0.12, 0.31, 0.47]
}

/** The unsealed sample: a branded letter with a signature block left blank for the stamps. */
/** The client's band across the top of a page: its color, its logo, its name and "via <service name>". */
function drawHeader(pdf: PDF, page: ReturnType<PDF['addPage']>, client: SampleClient, logo: SampleLogo | null, service: ServiceWords): void {
  const [r, g, b] = hexToRgb(client.accent_color)
  page.drawRectangle({ x: 0, y: 792 - 96, width: 612, height: 96, color: rgb(r, g, b) })
  let textX = 54
  if (logo) {
    const img = logo.type === 'image/png' ? pdf.embedPng(logo.bytes) : pdf.embedJpeg(logo.bytes)
    const scale = Math.min(60 / img.height, 160 / img.width)
    page.drawImage(img, { x: 54, y: 792 - 96 + (96 - img.height * scale) / 2, width: img.width * scale, height: img.height * scale })
    textX = 54 + img.width * scale + 18
  }
  page.drawText(client.display_name, { x: textX, y: 792 - 56, size: 22, font: 'Helvetica-Bold', color: rgb(1, 1, 1) })
  const via = viaSuffix(service)
  if (via) page.drawText(via, { x: textX, y: 792 - 76, size: 10, font: 'Helvetica', color: rgb(1, 1, 1) })
}

export async function buildSampleBase(client: SampleClient, logo: SampleLogo | null, service: ServiceWords): Promise<Uint8Array> {
  const pdf = PDF.create()
  const page = pdf.addPage({ size: 'letter' })
  drawHeader(pdf, page, client, logo, service)

  page.drawText('Sample document', { x: 54, y: 792 - 150, size: 18, font: 'Helvetica-Bold' })
  const body = [
    `This is a sample made by ${service.name} for ${client.legal_name}. It carries no agreement and nobody has signed it.`,
    'It shows what a finished document looks like: the client\'s name and colors on top, the signer\'s values placed on the page, a page that lists who signed and when, the event log attached inside the file, and a digital seal over all of it.',
    `Open it in Adobe Reader and look at the signature panel. The seal reads "validity unknown", because ${sealRootName(service)} is not on Adobe's trust list, and it tells you whether anything changed after sealing. Change one byte and it says so.`,
  ]
  let y = 792 - 190
  for (const para of body) {
    page.drawText(para, { x: 54, y, size: 11, font: 'Helvetica', maxWidth: 504, lineHeight: 15 })
    y -= 15 * (Math.ceil(para.length / 88) + 1) + 6
  }
  page.drawText('Signature', { x: 54, y: 230, size: 9, font: 'Helvetica', color: rgb(0.4, 0.4, 0.4) })
  page.drawLine({ start: { x: 54, y: 224 }, end: { x: 300, y: 224 }, thickness: 0.8, color: rgb(0.2, 0.2, 0.2) })
  page.drawText('Date', { x: 340, y: 230, size: 9, font: 'Helvetica', color: rgb(0.4, 0.4, 0.4) })
  page.drawLine({ start: { x: 340, y: 224 }, end: { x: 520, y: 224 }, thickness: 0.8, color: rgb(0.2, 0.2, 0.2) })
  return pdf.save()
}

/** The most signers the built-in sample has room for: two columns of two blocks. */
export const SAMPLE_MAX_SIGNERS = 4

/**
 * The built-in sample to SEND: a branded page with a block per signer holding one field of each of the five types, as a
 * prepared document (src/fields.ts). It is what the owner sends to themselves and a second address to see the whole thing work: the
 * links, the consent, the guided signer for every field type, the finished document. It carries no agreement.
 */
export async function buildSampleDocument(client: SampleClient, logo: SampleLogo | null, signers: { role: string }[], service: ServiceWords): Promise<PreparedDocument> {
  if (signers.length < 1 || signers.length > SAMPLE_MAX_SIGNERS) throw new Error(`The sample has room for 1 to ${SAMPLE_MAX_SIGNERS} signers`)
  const pdf = PDF.create()
  const page = pdf.addPage({ size: 'letter' })
  drawHeader(pdf, page, client, logo, service)
  page.drawText('Sample document', { x: 54, y: 792 - 140, size: 18, font: 'Helvetica-Bold' })
  page.drawText(`This is a sample sent by ${service.name} for ${client.legal_name}. It carries no agreement. Each signer below has a signature, initials, a date, a line of text and a checkbox, so the whole signing experience can be tried. Nothing here binds anyone.`, { x: 54, y: 792 - 166, size: 10.5, font: 'Helvetica', maxWidth: 504, lineHeight: 14 })
  const fields: PreparedField[] = []
  const gray = rgb(0.4, 0.4, 0.4)
  const colW = 252
  signers.forEach((s, i) => {
    const left = 54 + (i % 2) * (colW + 0)
    const top = 250 + Math.floor(i / 2) * 250
    const y = (fromTop: number) => 792 - (top + fromTop)
    page.drawText(`Signer ${i + 1}: ${s.role}`, { x: left, y: y(0), size: 11, font: 'Helvetica-Bold' })
    const row = (label: string, at: number, w: number, dx = 0) => {
      page.drawText(label, { x: left + dx, y: y(at + 6), size: 8, font: 'Helvetica', color: gray })
      page.drawLine({ start: { x: left + dx, y: y(at) }, end: { x: left + dx + w, y: y(at) }, thickness: 0.6, color: rgb(0.25, 0.25, 0.25) })
    }
    row('Signature', 56, 200)
    row('Initials', 100, 70)
    row('Date', 100, 100, 110)
    row('Printed name', 144, 200)
    page.drawRectangle({ x: left, y: y(196), width: 18, height: 18, borderColor: rgb(0.25, 0.25, 0.25), borderWidth: 0.8 })
    page.drawText('I have read this sample', { x: left + 26, y: y(188), size: 9.5, font: 'Helvetica' })
    const at = (type: FieldType, x: number, bottom: number) => {
      const size = FIELD_CATALOG[type].defaultSize
      return { x: x / 612, y: (top + bottom - size.height) / 792, width: size.width / 612, height: size.height / 792 }
    }
    const recipient = i + 1
    fields.push(
      { recipient, type: 'signature', page: 0, box: at('signature', left, 54), required: true, label: 'Signature' },
      { recipient, type: 'initials', page: 0, box: at('initials', left, 98), required: true, label: 'Initials' },
      { recipient, type: 'date', page: 0, box: at('date', left + 110, 98), required: true, label: 'Date' },
      { recipient, type: 'text', page: 0, box: at('text', left, 142), required: true, label: 'Printed name' },
      { recipient, type: 'checkbox', page: 0, box: at('checkbox', left, 196), required: true, label: 'I have read this sample' },
    )
  })
  return { bytes: await pdf.save(), pages: [{ index: 0, width: 612, height: 792, rotation: 0 }], fields }
}

export interface SampleOptions {
  client: SampleClient
  logo: SampleLogo | null
  sealer: Sealer
  /** The install's names for the service. */
  service: ServiceWords
  at: Date
  /** The sealed sample's id, printed on the certificate page so two downloads can be told apart. */
  id: string
}

const dateIn = (at: Date, zone: string) => new Intl.DateTimeFormat('en-US', { timeZone: zone, dateStyle: 'long' }).format(at)

/** The sealed sample, ready to download. */
export async function sealedSample(o: SampleOptions): Promise<Result<{ bytes: Uint8Array }>> {
  const base = await buildSampleBase(o.client, o.logo, o.service)
  const plan: FinishPlan = {
    // A mock signature and date on the lines left for them, in the page-fraction coordinates real fields use.
    stamps: [
      { page: 0, kind: 'text', text: 'Sample Signer', size: 18, color: [0.05, 0.1, 0.4], box: { x: 0.1, y: 0.7, width: 0.4, height: 0.04 } },
      { page: 0, kind: 'text', text: dateIn(o.at, o.client.time_zone), size: 11, box: { x: 0.56, y: 0.7, width: 0.28, height: 0.03 } },
    ],
    appendPages: [
      {
        title: 'Certificate of completion (sample)',
        lines: [
          `Document: Sample document for ${o.client.display_name}`,
          `Sample id: ${o.id}`,
          `Sealed: ${o.at.toISOString()} (${dateIn(o.at, o.client.time_zone)} in ${o.client.time_zone})`,
          '',
          'A real certificate lists each recipient, how they were reached, when they consented and signed, from where and on what device, and every event with its time.',
          'It also prints the last link of the event chain, so a copy held by anyone can be matched against the record.',
          '',
          `Sealed by: ${o.sealer.subject}`,
          `Seal root fingerprint (SHA-256): ${o.sealer.rootFingerprint}`,
          o.service.ownCompanyOnly ? `${o.service.name} sealed this document.` : `${o.service.name} is the service that sealed this document. It is never a party to it.`,
        ],
      },
    ],
    attachments: [{ name: 'events.json', data: new TextEncoder().encode(JSON.stringify({ sample: true, id: o.id, sealedAt: o.at.toISOString(), events: [] }, null, 2)), mimeType: 'application/json', description: 'The event log of this sample' }],
    seal: { signer: o.sealer.signer, timestampAuthority: o.sealer.timestampAuthority, reason: sealReason(o.service), at: o.at },
  }
  const done = await finish(base, plan)
  return done.ok ? { ok: true, value: { bytes: done.value.bytes } } : done
}
