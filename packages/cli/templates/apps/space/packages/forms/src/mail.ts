/**
 * Every email the app sends: its templates (HTML and plain text together, the client's logo from the public logo route, no
 * tracking pixel) and the seam to Cloudflare's `send_email` binding. Recording a message before it leaves, and the
 * flush that sends it, are in src/signing/mail.ts, because they read and write the envelope's rows.
 *
 * Mail reads "<Client> via <the service's name>" (just "<Client>" where the install's Forms sends only for its own company, `ownCompanyOnly`) from the install's forms sender (`ServiceWords`, src/service.ts) with Reply-To set to the client, so a signer's question
 * reaches the business. The display name and the address go to the binding as separate fields, never as a composed header.
 * Sent through the binding's structured message: it takes the fields separately and answers with an id.
 *
 * The warnings, the completed-copy lines and the footer are the wording of a legal research pass.
 * The owner's sign-off on every email text still gates the first client.
 */
import { type ServiceWords, runnerPlace, viaSuffix } from './service'

export interface Address {
  email: string
  name: string
}

export interface Outgoing {
  from: Address
  to: Address
  replyTo?: Address
  subject: string
  text: string
  html: string
  attachments?: { disposition: 'attachment'; filename: string; type: string; content: ArrayBuffer }[]
}

export interface Mailer {
  send(message: Outgoing): Promise<{ messageId: string | null }>
}

/** Cloudflare's `send_email` binding as a Mailer. A refusal throws; an answer without an id is still an acceptance. */
export function bindingMailer(binding: { send(message: Outgoing): Promise<unknown> }): Mailer {
  return {
    async send(message) {
      const answer = (await binding.send(message)) as { messageId?: unknown } | undefined
      return { messageId: typeof answer?.messageId === 'string' ? answer.messageId : null }
    },
  }
}

export type MailKind = 'request' | 'reminder' | 'turn' | 'completed' | 'declined' | 'cancelled' | 'expired' | 'notice'

export interface Brand {
  /** The client's display name. */
  name: string
  accent: string
  /** An absolute URL to the public logo route, or null. */
  logoUrl: string | null
  replyTo: string
}

export interface MailSpec {
  kind: MailKind
  brand: Brand
  /** The install's names for the service, which the footer says. */
  service: ServiceWords
  /** The envelope's title. */
  title: string
  /** Who it is for, by name. */
  toName: string
  /** The recipient's private link. */
  link?: string
  /** The operator's note, on a request. */
  note?: string | null
  /** The expiry date, already written in the client's zone. */
  expiresOn?: string | null
  /** Completed: the PDF travels attached, or by this private link. */
  delivery?: 'attached' | 'link'
  /** Completed by link: how long it works, written out. */
  linkUntil?: string | null
  /** Completed, to a client's copy address: how many files the customer uploaded, reachable by the private link. A count only. */
  uploads?: number
  /** A cancel reason, or who declined and why. */
  reason?: string | null
  declinedBy?: string | null
  /** A notice to an operator, in two parts. */
  headline?: string
  body?: string
}

/** On every email that carries a signing link: the link is the credential, so it must not travel. */
const ALONE = (who: string) => `This link is for you alone. Anyone who has it can open this document and sign it as you, so do not forward this email. If you were not expecting it, do not open the link; contact ${who} directly.`

/** On every email: the service's runner is the service and says so, with who it is. A company that sends only for itself is the sender and the runner at once, and says only that. */
export const FOOTER = (who: string, service: ServiceWords) =>
  service.ownCompanyOnly
    ? `Sent through ${service.name} by ${runnerPlace(service).replace(/\.$/, '')}.`
    : `Sent through ${service.name} (${runnerPlace(service)}) on behalf of ${who}. ${service.runBy.name} runs the service and is not a party to the document.`

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** A name or title in a header: no line breaks. */
const oneLine = (s: string): string => s.replace(/[\r\n\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()

export const senderFor = (clientName: string | null, service: ServiceWords): Address => ({
  email: service.sender,
  name: clientName ? [oneLine(clientName), viaSuffix(service)].filter(Boolean).join(' ') : service.name,
})

interface Parts {
  subject: string
  paragraphs: string[]
  button?: { label: string; href: string }
  /** Lines under the button, small. */
  fine: string[]
}

function parts(s: MailSpec): Parts {
  const who = s.brand.name
  const t = s.title
  const hello = `Hello ${s.toName},`
  switch (s.kind) {
    case 'request':
      return {
        subject: `${who} sent you ${t} to sign`,
        paragraphs: [hello, `${who} has sent you ${t} to review and sign.`, ...(s.note ? [`A note from ${who}:`, s.note] : []), ALONE(who)],
        button: { label: 'Review and sign', href: s.link! },
        fine: [...(s.expiresOn ? [`This link works until ${s.expiresOn}.`] : []), `Questions? Reply to this email and it reaches ${who}.`],
      }
    case 'reminder':
      return {
        subject: `Reminder: ${who} is waiting for you to sign ${t}`,
        paragraphs: [hello, `${who} is still waiting for you to review and sign ${t}.`, ALONE(who)],
        button: { label: 'Review and sign', href: s.link! },
        fine: [...(s.expiresOn ? [`This link works until ${s.expiresOn}.`] : []), `Questions? Reply to this email and it reaches ${who}.`],
      }
    case 'turn':
      return {
        subject: `${who}: your turn to sign ${t}`,
        paragraphs: [hello, `It is your turn to sign ${t}. The people before you have signed.`, ALONE(who)],
        button: { label: 'Review and sign', href: s.link! },
        fine: [...(s.expiresOn ? [`This link works until ${s.expiresOn}.`] : []), `Questions? Reply to this email and it reaches ${who}.`],
      }
    case 'completed': {
      const n = s.uploads ?? 0
      const files = n === 1 ? 'The file the customer uploaded' : `The ${n} files the customer uploaded`
      const until = s.linkUntil ? [`The link works until ${s.linkUntil}, and each download is recorded. Download and save a copy before then; after that, ask ${who} for a copy.`] : []
      if (s.delivery === 'attached')
        return {
          subject: `${t} is signed and complete`,
          paragraphs: [hello, `Everyone has signed ${t}. The finished document is attached. Save a copy for your records.`, 'It carries a digital seal: a PDF reader shows whether anything changed after it was sealed.', ...(n > 0 ? [`${files} ${n === 1 ? 'is not attached, because it may be private' : 'are not attached, because they may be private'}. Use the button to see and download ${n === 1 ? 'it' : 'them'}.`, ...until] : [])],
          ...(n > 0 ? { button: { label: n === 1 ? 'See the uploaded file' : 'See the uploaded files', href: s.link! } } : {}),
          fine: [`Questions? Reply to this email and it reaches ${who}.`],
        }
      return {
        subject: `${t} is signed and complete`,
        paragraphs: [hello, `Everyone has signed ${t}. Because the document holds private information, it is not attached to this email. Use the button to download it.`, ...(n > 0 ? [`The same page lists ${n === 1 ? 'the file' : `the ${n} files`} the customer uploaded.`] : []), ...until],
        button: { label: 'Download the finished document', href: s.link! },
        fine: [`Questions? Reply to this email and it reaches ${who}.`],
      }
    }
    case 'declined':
      return {
        subject: `${t} was declined`,
        paragraphs: [hello, `${s.declinedBy ?? 'A recipient'} declined to sign ${t}, so it will not be completed.`, ...(s.reason ? ['Their reason:', s.reason] : [])],
        fine: [`Questions? Reply to this email and it reaches ${who}.`],
      }
    case 'cancelled':
      return {
        subject: `${t} was cancelled`,
        paragraphs: [hello, `${who} cancelled ${t}. Your link no longer works and there is nothing more for you to do.`, ...(s.reason ? ['The reason given:', s.reason] : [])],
        fine: [`Questions? Reply to this email and it reaches ${who}.`],
      }
    case 'expired':
      return { subject: `${t} expired before everyone signed`, paragraphs: [hello, `${t}, sent for ${who}, reached its expiry date before everyone had signed. Every link to it has stopped working.`], fine: [] }
    case 'notice':
      return { subject: s.headline ?? `${t}: a notice`, paragraphs: [hello, s.body ?? ''], fine: [] }
  }
}

/** The finished message: subject, HTML and plain text. */
export function renderMail(spec: MailSpec): { subject: string; html: string; text: string } {
  const p = parts(spec)
  const accent = /^#[0-9a-f]{6}$/i.test(spec.brand.accent) ? spec.brand.accent : '#1f4e79'
  const para = (s: string) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.5">${escapeHtml(s).replace(/\n/g, '<br>')}</p>`
  const via = viaSuffix(spec.service)
  const logo = spec.brand.logoUrl ? `<img src="${escapeHtml(spec.brand.logoUrl)}" alt="" height="36" style="display:block;max-height:36px;max-width:160px;margin:0 0 6px">` : ''
  const button = p.button
    ? `<p style="margin:22px 0"><a href="${escapeHtml(p.button.href)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:6px">${escapeHtml(p.button.label)}</a></p><p style="margin:0 0 14px;font-size:12px;color:#555555;word-break:break-all">${escapeHtml(p.button.href)}</p>`
    : ''
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden"><tr><td style="background:${accent};padding:18px 24px;color:#ffffff">${logo}<span style="font-size:18px;font-weight:700">${escapeHtml(spec.brand.name)}</span>${via ? `<br><span style="font-size:12px;opacity:.9">${escapeHtml(via)}</span>` : ''}</td></tr><tr><td style="padding:24px">${p.paragraphs.map(para).join('')}${button}${p.fine.map((f) => `<p style="margin:0 0 6px;font-size:12px;color:#555555">${escapeHtml(f)}</p>`).join('')}</td></tr></table><p style="max-width:560px;margin:14px 0 0;font-size:11px;color:#777777">${escapeHtml(FOOTER(spec.brand.name, spec.service))}</p></td></tr></table></body></html>`
  const text = [...p.paragraphs, ...(p.button ? [`${p.button.label}: ${p.button.href}`] : []), ...p.fine, FOOTER(spec.brand.name, spec.service)].join('\n\n')
  return { subject: oneLine(p.subject), html, text }
}
