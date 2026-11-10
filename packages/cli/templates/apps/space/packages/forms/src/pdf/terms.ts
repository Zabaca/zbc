/**
 * The two small PDFs the consent step hands a signer: the terms they are agreeing to, to save, and the sample they open to
 * show their device can open a PDF (legal gate A2). Neither holds anything private; the terms carry the consent text of one
 * version, word for word, in the document's own font (src/pdf/font.ts), because a business's name may need its extended letters.
 */
import { PDF, rgb } from '@libpdf/core'
import type { ServiceWords } from '../service'
import { appendBlocks } from './blocks'

/** The consent text of one version as a PDF to save: the version, the business and the document it was shown for, then every paragraph. */
export async function buildTermsPdf(i: { version: string; business: string; documentTitle: string; paragraphs: string[] }): Promise<Uint8Array> {
  const pdf = PDF.create()
  appendBlocks(pdf, {
    title: 'Terms for signing electronically',
    blocks: [
      { kind: 'row', label: 'Business', value: i.business },
      { kind: 'row', label: 'Document', value: i.documentTitle },
      { kind: 'row', label: 'Version of these terms', value: i.version },
      { kind: 'rule' },
      ...i.paragraphs.flatMap((p) => [{ kind: 'text' as const, text: p, size: 10.5 }, { kind: 'space' as const, height: 6 }]),
    ],
  })
  return pdf.save()
}

/** One page that says what it is and carries nothing to sign. If a signer's device shows it, it shows a PDF. */
export async function buildConsentSample(service: Pick<ServiceWords, 'name'>): Promise<Uint8Array> {
  const pdf = PDF.create()
  const page = pdf.addPage({ size: 'letter' })
  page.drawText(`Sample PDF from ${service.name}`, { x: 54, y: 792 - 110, size: 20, font: 'Helvetica-Bold' })
  page.drawText('If you can read this page on your device, your device can open PDF files. There is nothing to sign here and nothing to send back. Go back to the page you came from and continue.', { x: 54, y: 792 - 146, size: 12, font: 'Helvetica', maxWidth: 504, lineHeight: 17 })
  page.drawText('To keep a finished document you will need to save a file like this one, or print it.', { x: 54, y: 792 - 220, size: 12, font: 'Helvetica', maxWidth: 504, lineHeight: 17, color: rgb(0.25, 0.25, 0.25) })
  return pdf.save()
}
