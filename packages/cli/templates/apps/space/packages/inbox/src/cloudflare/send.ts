import { INBOX_MOST_FILE_BYTES, INBOX_MOST_FILES, plainFilename } from '@space/workspace'
import { isBareAddress, MESSAGE_ID, MimeError } from '../gmail/mime'
import type { CloudflareSendPlan } from '../store/mail'
import type { AttachmentInfo } from '../types'

/**
 * Sending as a Cloudflare mailbox (a business address such as `hello@northfield.example`): what the inbox hands the Worker's `send_email` binding, and what it makes
 * of the binding's answer. Pure over plain data, so what leaves and what each failure means is a table test with no network.
 * The order around the call (plan, claim, send, keep the copy, file) is the Mailroom's (gmail/mailroom.ts, `sendViaCloudflare`);
 * the inbox's ADR 0001 says why it is built this way.
 *
 * ── THE STRUCTURED FORM, AND WHAT THAT COSTS ─────────────────────────────
 * The binding takes either a structured message (`from`, `to`, `subject`, `text`, `headers`) or raw MIME. The structured form is
 * the one Cloudflare recommends and the one other senders on the same account use (a site's sign-in mail, an app's
 * replies). Its price: Cloudflare composes the message and sets `Message-ID` and `Date` itself, and a request that names either
 * is refused whole (its headers reference lists both as platform-controlled, `E_HEADER_NOT_ALLOWED`). So the inbox cannot choose
 * the Message-ID of a reply, as the option hoped: it keeps the one the binding reports (`messageId`), and a customer's reply
 * that names a different one still joins the conversation by its subject and the customer as the outside person (threading
 * rule 2). The raw form would let the inbox choose, but is the legacy path and nothing here shows it accepts any recipient.
 *
 * ── THE FROM IS THE MAILBOX'S, ENFORCED TWICE ────────────────────────────
 * Without a limit, the binding lets a Worker claim any address on an onboarded domain. The code limits it: the plan's `from` is
 * the conversation's mailbox row, never anything typed (a draft names recipients, subject and body, and nothing else), and
 * `buildOutgoing` refuses a sender that is not a bare address with a plain name. The binding limits it too, in
 * the Worker's settings (`allowed_sender_addresses`, in wrangler's config schema though not on Cloudflare's documentation page for the
 * binding), which a test pins to the declared mailboxes. Whether Cloudflare applies it to this form of send is a live check.
 *
 * ── WHAT EACH FAILURE MEANS (the table is `REFUSALS`) ────────────────────
 *   - The binding THROWS an error whose code says it did not act (a payload it would not take, a sender or recipient it would
 *     not accept, a limit): nothing went out, the draft is a draft again, and the sender is told whether to fix what was typed (422)
 *     or to try later (502).
 *   - Any other failure (`E_DELIVERY_FAILED`, `E_INTERNAL_SERVER_ERROR`, a code the table does not know, no code at all, a
 *     thing that is not an Error) may have gone out: the draft stays `sending` and is never sent again by anything. Treating a
 *     delivery failure as unknown is the cautious reading of a code whose documentation does not say whether Cloudflare had
 *     already handed the message on.
 *   - The binding RESOLVES: Cloudflare accepted it, with an id. An answer with no id is still an acceptance (the contract is
 *     that a refusal throws); the message is then filed with no Message-ID.
 */

/** What goes to the binding: the structured form, plain text only, with the threading headers Cloudflare allows. */
export interface OutgoingEmail {
  /** `Name <address>`, or the bare address when the mailbox has no name. */
  from: string
  to: string
  /** Bare addresses; empty for none (the binding is then given no `cc` at all). */
  cc: string[]
  subject: string
  text: string
  /** `In-Reply-To` and `References` for a reply; empty for a new email. Never Message-ID or Date. */
  headers: Record<string, string>
  /** The files that go with it; empty for none (the binding is then given no `attachments` at all). */
  attachments: OutgoingFile[]
}

/** One file as the binding takes it (`attachments` in Cloudflare's Workers API for Email Service): its bytes, a clean name, a plain type, never inline. */
export interface OutgoingFile {
  filename: string
  type: string
  content: Uint8Array
  disposition: 'attachment'
}

/** A file the person chose, as it reaches the sender: the name and type their browser gave, and the bytes. Nothing in it is trusted yet. */
export interface ChosenFile {
  name: string
  type: string
  bytes: Uint8Array
}

/** A media type as `type/subtype` in the characters the standard allows, lower case; anything else is the generic type, which a mail client offers to save. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/

/**
 * The files of a send, checked and cleaned. Throws `MimeError` (its words are safe to show, and nothing has been sent) for too many files, too many bytes
 * or an empty file. A name has what is special in a header taken out (a person's file is named by what their machine called it, and the header it lands in
 * is one line of someone else's mail); a type that is not a plain `type/subtype` becomes `application/octet-stream`. A parameter after a `;` is dropped.
 */
export function cleanFiles(files: readonly ChosenFile[]): OutgoingFile[] {
  if (files.length > INBOX_MOST_FILES) throw new MimeError(`A message carries at most ${INBOX_MOST_FILES} files.`)
  let total = 0
  const out: OutgoingFile[] = []
  for (const f of files) {
    if (!(f.bytes instanceof Uint8Array) || f.bytes.length === 0) {
      throw new MimeError(`${plainFilename(String(f.name ?? ''))} is empty.`)
    }
    total += f.bytes.length
    if (total > INBOX_MOST_FILE_BYTES) {
      throw new MimeError(`The files come to more than ${INBOX_MOST_FILE_BYTES / (1024 * 1024)} MB together.`)
    }
    const declared =
      String(f.type ?? '')
        .split(';')[0]
        ?.trim()
        .toLowerCase() ?? ''
    out.push({
      filename: plainFilename(String(f.name ?? '')),
      type: MEDIA_TYPE.test(declared) ? declared : 'application/octet-stream',
      content: f.bytes,
      disposition: 'attachment',
    })
  }
  return out
}

/** What the store keeps of the files that went: names, sizes and the type sent, never a byte (the bytes are in the bucket beside the sent copy). */
export const infoOf = (files: readonly OutgoingFile[]): AttachmentInfo[] =>
  files.map((f) => ({ name: f.filename, size: f.content.length, mimeType: f.type }))

/** Where the bytes of the Nth file of a sent message are kept: beside the copy of the request, under `out/<id>/<n>`. */
export const sentFileKey = (messageRowId: string, index: number): string => `${sentCopyKey(messageRowId)}/${index}`

/** The binding as the Mailroom sees it: one send, the id Cloudflare gave it (or null), and a throw for anything else. */
export interface EmailSender {
  send(message: OutgoingEmail): Promise<{ messageId: string | null }>
}

/** The binding refused, in a way that says it did not act. `status` is what the sender is answered with. */
export class EmailRefused extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 422 | 502,
  ) {
    super(message)
  }
}

/** The error codes in Cloudflare's documentation (Email Service, Workers API) that mean nothing was sent, and who must act. */
const REFUSALS: Record<string, 422 | 502> = {
  // What was typed: a payload, a recipient or a size the binding would not take.
  E_VALIDATION_ERROR: 422,
  E_FIELD_MISSING: 422,
  E_TOO_MANY_RECIPIENTS: 422,
  E_TOO_MANY_ATTACHMENTS: 422,
  E_CONTENT_TOO_LARGE: 422,
  E_RECIPIENT_NOT_ALLOWED: 422,
  E_RECIPIENT_SUPPRESSED: 422,
  // Not what was typed: the account, the sender, a limit, or a header the inbox itself put there.
  E_SENDER_NOT_VERIFIED: 502,
  E_SENDER_DOMAIN_NOT_AVAILABLE: 502,
  E_ACCOUNT_SUSPENDED: 502,
  E_RATE_LIMIT_EXCEEDED: 502,
  E_DAILY_LIMIT_EXCEEDED: 502,
  E_HEADER_NOT_ALLOWED: 502,
  E_HEADER_USE_API_FIELD: 502,
  E_HEADER_VALUE_INVALID: 502,
  E_HEADER_VALUE_TOO_LONG: 502,
  E_HEADER_NAME_INVALID: 502,
  E_HEADERS_TOO_LARGE: 502,
  E_HEADERS_TOO_MANY: 502,
}

/** An error the binding threw, as a refusal when its code says nothing went out; null when it may have. */
export function refusalOf(error: unknown): EmailRefused | null {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string' || !Object.hasOwn(REFUSALS, code)) return null
  const said = error instanceof Error ? error.message : ''
  return new EmailRefused(
    `Cloudflare would not send it${said === '' ? '' : `: ${said.replace(/\s+/g, ' ').trim().slice(0, 200)}`} (${code}).`,
    code,
    REFUSALS[code] as 422 | 502,
  )
}

/** The binding as an `EmailSender`: one structured send, an answer or a throw, nothing retried. */
export function bindingSender(binding: SendEmail): EmailSender {
  return {
    async send(message) {
      let result: { messageId?: unknown } | undefined
      try {
        result = await binding.send({
          from: message.from,
          to: message.to,
          ...(message.cc.length > 0 && { cc: message.cc }),
          subject: message.subject,
          text: message.text,
          ...(Object.keys(message.headers).length > 0 && { headers: message.headers }),
          ...(message.attachments.length > 0 && { attachments: message.attachments }),
        })
      } catch (error) {
        throw refusalOf(error) ?? error
      }
      const id = typeof result?.messageId === 'string' ? result.messageId.trim() : ''
      return { messageId: id === '' ? null : id }
    },
  }
}

/** A display name that can be composed into `Name <address>` unquoted: the characters that mean something there, or let a name pose as an address, are refused. */
const DISPLAY_NAME = /^[^<>"'\\,;:@()]+$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse control characters
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/** The most a header value may carry (Cloudflare's limit is 2,048 bytes; the inbox stays well inside it). */
const MAX_HEADER = 1800

/**
 * The structured message for a plan. Throws `MimeError` (its message is safe to show) for anything that must not be sent:
 * an address that is not bare printable ASCII, a subject with a control character (a stranger's text must never add a
 * header), a sender name that would pose as an address, a Message-ID that is not one.
 */
export function buildOutgoing(plan: CloudflareSendPlan, files: readonly ChosenFile[] = []): OutgoingEmail {
  const address = (label: string, value: string): string => {
    if (!isBareAddress(value))
      throw new MimeError(`${label} is not an email address: ${JSON.stringify(value).slice(0, 80)}`)
    return value
  }
  if (CONTROL.test(plan.subject)) throw new MimeError('The subject must be one plain line.')
  const name = plan.fromName.trim()
  if (name !== '' && (CONTROL.test(name) || !DISPLAY_NAME.test(name))) {
    throw new MimeError('The mailbox’s name cannot be used as a sender name.')
  }
  const from = address('From', plan.from)

  const ids = [...plan.references, ...(plan.inReplyTo === null ? [] : [plan.inReplyTo])]
  for (const id of ids) if (!MESSAGE_ID.test(id)) throw new MimeError('The message it answers has no valid Message-ID.')
  const chain = [...new Set(plan.references)]
  // The newest ids are the ones a client matches on; a chain too long for a header loses its oldest.
  while (chain.length > 1 && chain.join(' ').length > MAX_HEADER) chain.shift()

  return {
    from: name === '' ? from : `${name} <${from}>`,
    to: address('To', plan.to),
    cc: plan.cc.map((a) => address('Cc', a)),
    subject: plan.subject,
    text: plan.body,
    headers: {
      ...(plan.inReplyTo !== null && { 'In-Reply-To': plan.inReplyTo }),
      ...(chain.length > 0 && { References: chain.join(' ') }),
    },
    attachments: cleanFiles(files),
  }
}

/**
 * The Message-ID a sent message is filed under: the id Cloudflare reported, in angle brackets as a Message-ID is written (an
 * id already in them is kept), or null when it reported none or one that could not be a Message-ID. It is what a customer's
 * reply must name to join the conversation by In-Reply-To; whether it is the header Cloudflare really wrote is a live check.
 */
export function messageIdOf(reported: string | null): string | null {
  const id = (reported ?? '').trim()
  if (id === '') return null
  const bare = id.startsWith('<') && id.endsWith('>') ? id.slice(1, -1) : id
  return bare === '' || /[\s<>]/.test(bare) ? null : `<${bare}>`
}

/** Where the copy of a sent message is kept in the raw-mail bucket, beside the received mail under `in/`. */
export const sentCopyKey = (messageRowId: string): string => `out/${messageRowId}`

/**
 * The copy kept when Cloudflare accepts a message: exactly what was handed to it, and what it answered. It is the request and
 * not the MIME, because with the structured form Cloudflare composes the MIME and the inbox never sees it.
 */
export function sentCopy(input: {
  id: string
  request: OutgoingEmail
  reportedId: string | null
  sentAt: string
  sentBy: string
}): string {
  return JSON.stringify(
    {
      kind: 'sent-through-cloudflare',
      id: input.id,
      sentAt: input.sentAt,
      sentBy: input.sentBy,
      reportedMessageId: input.reportedId,
      // The files' bytes are kept as their own objects (sentFileKey); the copy names them.
      request: { ...input.request, attachments: infoOf(input.request.attachments) },
    },
    null,
    2,
  )
}
