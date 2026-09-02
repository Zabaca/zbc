import type { DraftFields, InboxStore } from './inbox-do'
import { type MailEnv, emitWebhook, makeSnippet, newId, normalizeMsgId, sendMail } from './shared'

/**
 * Every mutation the inbox supports, once. The two adapters — `api.ts` (the
 * JSON routes) and `mcp.ts` (the MCP tools) — parse their own input shape,
 * call one of these, and render the `Outcome`; neither holds mutation logic
 * of its own. A Worker cannot fetch its own routes, so this is a module of
 * functions rather than one adapter calling the other.
 *
 * The shape is uniform: `(env?, store, input) -> Outcome`, where `Outcome`
 * carries the HTTP status the JSON route answers with. The MCP adapter reads
 * the same status: >= 400 becomes a tool error, anything else the tool result.
 *
 * Reads (list/search/get/…) are NOT here — they are single `store.*` calls
 * and both adapters make them directly.
 */

/**
 * A command's result, in the JSON adapter's vocabulary because that adapter
 * is the reference: `status` is the HTTP status `/api/*` answers with, `body`
 * the JSON it renders.
 */
export interface Outcome {
  status: number
  body: Record<string, unknown>
}

export interface SendBody {
  to: string
  subject: string
  text?: string
  html?: string
  from?: string
  /** RFC 5322 Message-ID of the message being replied to → In-Reply-To/References. */
  inReplyTo?: string
  /**
   * ISO timestamp: instead of sending now, queue the message for the DO
   * alarm to dispatch at (or shortly after) this time.
   */
  sendAt?: string
}

export interface SendEnv extends MailEnv {
  DEFAULT_FROM?: string
}

/**
 * Send now, or queue for the DO alarm when `sendAt` is set. Validates,
 * dispatches, records the outbound row, and emits the message.sent webhook.
 */
export async function send(env: SendEnv, store: InboxStore, body: SendBody): Promise<Outcome> {
  if (!body.to || !body.subject || (!body.text && !body.html)) {
    return { status: 400, body: { error: 'required: to, subject, and text or html' } }
  }
  const from = body.from ?? env.DEFAULT_FROM
  if (!from) {
    return { status: 400, body: { error: 'no from address (set DEFAULT_FROM or pass from)' } }
  }

  // Email Sending only accepts whitelisted custom headers (a Message-ID of
  // our own is rejected), so the wire Message-ID is provider-chosen and
  // unknown to us. We store a synthetic one for OUR send chain; recipient
  // replies thread via the subject+participant fallback.
  const id = newId()
  const messageId = `${id}@${from.split('@')[1] ?? 'localhost'}`
  const inReplyTo = normalizeMsgId(body.inReplyTo)
  const text = body.text ?? ''
  const snippet = makeSnippet(text, body.html ?? '')

  // sendAt → queue for the DO alarm instead of dispatching now.
  if (body.sendAt !== undefined) {
    const at = new Date(body.sendAt)
    if (Number.isNaN(at.getTime())) {
      return { status: 400, body: { error: 'sendAt is not a valid date' } }
    }
    await store.insert({
      id,
      status: 'scheduled',
      scheduled_at: at.toISOString(),
      direction: 'outbound',
      in_reply_to: inReplyTo,
      message_id: messageId,
      from_addr: from,
      to_addr: body.to,
      subject: body.subject,
      date: at.toISOString(),
      snippet,
      text_body: text,
      html_body: body.html ?? '',
      r2_key: '',
      attachments_json: '[]',
      size: text.length + (body.html?.length ?? 0),
    })
    return { status: 202, body: { ok: true, id, status: 'scheduled', sendAt: at.toISOString() } }
  }

  try {
    await sendMail(env, {
      from,
      to: body.to,
      subject: body.subject,
      text: body.text,
      html: body.html,
      inReplyTo,
    })
  } catch (err) {
    return { status: 502, body: { error: `send failed: ${(err as Error).message}` } }
  }

  // Record the outbound message so the inbox shows both sides of a
  // conversation. No raw MIME (we never see the provider's final wire form),
  // so r2_key stays empty and /raw 404s for these.
  const { threadId } = await store.insert({
    id,
    direction: 'outbound',
    in_reply_to: inReplyTo,
    message_id: messageId,
    from_addr: from,
    to_addr: body.to,
    subject: body.subject,
    date: new Date().toISOString(),
    snippet,
    text_body: text,
    html_body: body.html ?? '',
    r2_key: '',
    attachments_json: '[]',
    size: text.length + (body.html?.length ?? 0),
  })
  await emitWebhook(env, 'message.sent', {
    id,
    threadId,
    from,
    to: body.to,
    subject: body.subject,
    snippet,
    direction: 'outbound',
  })
  return { status: 200, body: { ok: true, id, from, to: body.to, messageId, threadId } }
}

/** Send an existing draft: validate completeness, dispatch, flip to sent. */
export async function sendDraft(
  env: SendEnv,
  store: InboxStore,
  draftId: string,
): Promise<Outcome> {
  const draft = await store.get(draftId)
  if (!draft || draft.status !== 'draft') return { status: 404, body: { error: 'not a draft' } }
  const from = draft.from_addr || env.DEFAULT_FROM
  if (!from) {
    return { status: 400, body: { error: 'no from address (set DEFAULT_FROM or the draft from)' } }
  }
  if (!draft.to_addr || !draft.subject || (!draft.text_body && !draft.html_body)) {
    return { status: 400, body: { error: 'draft incomplete: needs to, subject, and text or html' } }
  }
  try {
    await sendMail(env, {
      from,
      to: draft.to_addr,
      subject: draft.subject,
      text: draft.text_body || undefined,
      html: draft.html_body || undefined,
      inReplyTo: draft.in_reply_to,
    })
  } catch (err) {
    return { status: 502, body: { error: `send failed: ${(err as Error).message}` } }
  }
  // Persist the from that was actually used (may have come from
  // DEFAULT_FROM), then flip the row to sent — thread resolves NOW.
  if (from !== draft.from_addr) await store.updateDraft(draftId, { from_addr: from })
  const sent = await store.markDraftSent(draftId, new Date().toISOString())
  if (!sent) return { status: 500, body: { error: 'draft vanished during send' } }
  await emitWebhook(env, 'message.sent', {
    id: draftId,
    threadId: sent.threadId,
    from,
    to: draft.to_addr,
    subject: draft.subject,
    snippet: draft.snippet,
    direction: 'outbound',
  })
  return {
    status: 200,
    body: { ok: true, id: draftId, from, to: draft.to_addr, threadId: sent.threadId },
  }
}

/**
 * A draft's fields as an adapter hands them in. Every one is optional: a
 * draft may be partial, and completeness is enforced at send time by
 * {@link sendDraft}.
 */
export interface DraftBody {
  to?: string
  subject?: string
  text?: string
  html?: string
  from?: string
  /** RFC 5322 Message-ID of the message being replied to. */
  inReplyTo?: string
}

/** Store an outbound message without sending it. */
export async function createDraft(
  env: SendEnv,
  store: InboxStore,
  body: DraftBody,
): Promise<Outcome> {
  const id = newId()
  const from = body.from ?? env.DEFAULT_FROM ?? ''
  const text = body.text ?? ''
  await store.insert({
    id,
    status: 'draft',
    direction: 'outbound',
    in_reply_to: normalizeMsgId(body.inReplyTo),
    message_id: `${id}@${from.split('@')[1] || 'localhost'}`,
    from_addr: from,
    to_addr: body.to ?? '',
    subject: body.subject ?? '',
    date: new Date().toISOString(),
    snippet: makeSnippet(text, body.html ?? ''),
    text_body: text,
    html_body: body.html ?? '',
    r2_key: '',
    attachments_json: '[]',
    size: text.length + (body.html?.length ?? 0),
  })
  return { status: 201, body: { ok: true, id, status: 'draft' } }
}

/**
 * Patch an unsent draft: only the fields present change, and `snippet` is
 * recomputed whenever either body was touched. Which rows may be patched at
 * all is the DO's rule (`updateDraft` refuses anything but a draft), not this
 * command's — the command only translates the adapter's field names.
 */
export async function updateDraft(
  store: InboxStore,
  id: string,
  patch: DraftBody,
): Promise<Outcome> {
  const { text, html } = patch
  const fields: DraftFields = {
    ...(patch.from !== undefined ? { from_addr: patch.from } : {}),
    ...(patch.to !== undefined ? { to_addr: patch.to } : {}),
    ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
    ...(text !== undefined ? { text_body: text } : {}),
    ...(html !== undefined ? { html_body: html } : {}),
    ...(patch.inReplyTo !== undefined ? { in_reply_to: normalizeMsgId(patch.inReplyTo) } : {}),
    ...(text !== undefined || html !== undefined
      ? { snippet: makeSnippet(text ?? '', html ?? '') }
      : {}),
  }
  const updated = await store.updateDraft(id, fields)
  return updated
    ? { status: 200, body: { ok: true, id } }
    : { status: 404, body: { error: 'not a draft' } }
}

/**
 * Delete a message of any status, plus its raw MIME blob.
 *
 * `store.delete` answers with three distinct values and all three matter:
 * `null` (no such row), `''` (deleted, but it never had raw MIME — a draft,
 * a scheduled row, or anything outbound) and a key (delete the R2 object
 * too). The JSON route used to test `!r2Key`, which folded `''` into "not
 * found" and answered 404 for a row it had just deleted; the MCP tool tested
 * `=== null` and was right. This command takes the MCP reading.
 */
export async function deleteMessage(
  env: { RAW: R2Bucket },
  store: InboxStore,
  id: string,
): Promise<Outcome> {
  const r2Key = await store.delete(id)
  if (r2Key === null) return { status: 404, body: { error: 'not found' } }
  if (r2Key) await env.RAW.delete(r2Key)
  return { status: 200, body: { ok: true } }
}

/** Cancel a pending scheduled send, or dismiss a failed one. Deletes the row. */
export async function cancelScheduled(store: InboxStore, id: string): Promise<Outcome> {
  const cancelled = await store.cancelScheduled(id)
  return cancelled
    ? { status: 200, body: { ok: true } }
    : { status: 404, body: { error: 'not a scheduled send' } }
}
