import type { Inbox } from './inbox-do'
import { type MailEnv, emitWebhook, makeSnippet, newId, normalizeMsgId, sendMail } from './shared'

/**
 * The one send operation, shared by POST /api/send and the MCP send_email
 * tool (a Worker cannot fetch its own routes, so this is a function, not a
 * self-request). Validates, dispatches now or queues for the DO alarm
 * (sendAt), records the outbound row, and emits the message.sent webhook.
 */

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

export interface SendOutcome {
  status: number
  body: Record<string, unknown>
}

export async function performSend(
  env: SendEnv,
  stub: DurableObjectStub<Inbox>,
  body: SendBody,
): Promise<SendOutcome> {
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
    await stub.insert({
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
  const { threadId } = await stub.insert({
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
export async function performDraftSend(
  env: SendEnv,
  stub: DurableObjectStub<Inbox>,
  draftId: string,
): Promise<SendOutcome> {
  const draft = await stub.get(draftId)
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
  if (from !== draft.from_addr) await stub.updateDraft(draftId, { from_addr: from })
  const sent = await stub.markDraftSent(draftId, new Date().toISOString())
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
