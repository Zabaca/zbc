/**
 * Inbox Worker: an agent-accessible email inbox.
 *
 * - `email()` handler: Email Routing (catch-all) delivers inbound mail here.
 *   Raw MIME → R2; parsed metadata + bodies → the Inbox Durable Object.
 * - `/api/*`: bearer-authed JSON API (list / read / raw / delete / send).
 * - Everything else: the static UI in public/ (ASSETS binding).
 */
import PostalMime from 'postal-mime'
import { Inbox } from './inbox-do'

export { Inbox }

/**
 * Email Service send binding (the NEW object-based API, not the legacy
 * EmailMessage one). The legacy `new EmailMessage(from, to, raw)` path routes
 * through Email Routing and only delivers to VERIFIED destination addresses;
 * the object form goes through Email Sending and accepts any recipient as
 * long as the From domain is onboarded.
 */
interface SendEmailBinding {
  send(message: {
    from: string
    to: string
    subject: string
    text?: string
    html?: string
    headers?: Record<string, string>
  }): Promise<unknown>
}

export interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> }
  INBOX: DurableObjectNamespace<Inbox>
  RAW: R2Bucket
  EMAIL: SendEmailBinding
  /** Bearer token guarding /api/* (worker secret, pushed by zbc apply). */
  INBOX_TOKEN?: string
  /** Default From address for /api/send (wrangler var). */
  DEFAULT_FROM?: string
  /**
   * Optional webhook: POSTed a JSON event on every received/sent message.
   * Best-effort (one retry, never blocks mail handling). Signed with
   * WEBHOOK_SECRET when set (x-inbox-signature: sha256=<hex HMAC of body>).
   */
  WEBHOOK_URL?: string
  WEBHOOK_SECRET?: string
  /**
   * Optional inbound labeling: when both ANTHROPIC_API_KEY (worker secret)
   * and LABELS (comma-separated set, e.g. "billing,support,spam,other") are
   * set, each received message is classified into one label after insert.
   * Best-effort — a classifier failure just leaves label = ''.
   */
  ANTHROPIC_API_KEY?: string
  LABELS?: string
}

/** Time-ordered id: ms timestamp (base36, padded) + random suffix. Sortable as TEXT. */
function newId(): string {
  const time = Date.now().toString(36).padStart(9, '0')
  const rand = crypto.getRandomValues(new Uint8Array(8))
  const suffix = Array.from(rand, (b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 12)
  return `${time}-${suffix}`
}

/**
 * Normalize an RFC 5322 Message-ID to its bare form (no angle brackets or
 * whitespace) so stored ids and In-Reply-To references compare equal.
 */
function normalizeMsgId(id: string | undefined | null): string {
  return (id ?? '').replace(/[\s<>]/g, '')
}

/** Constant-time bearer check: compare SHA-256 digests so length never leaks. */
async function authorized(request: Request, env: Env): Promise<boolean> {
  if (!env.INBOX_TOKEN) return false
  const header = request.headers.get('authorization') ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(presented)),
    crypto.subtle.digest('SHA-256', enc.encode(env.INBOX_TOKEN)),
  ])
  return crypto.subtle.timingSafeEqual(a, b)
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } })
}

function inboxStub(env: Env) {
  return env.INBOX.get(env.INBOX.idFromName('inbox'))
}

/**
 * Dispatch via the Email Sending binding. In-Reply-To/References are the only
 * threading headers Cloudflare accepts (a custom Message-ID is rejected).
 */
async function sendMail(
  env: Env,
  msg: {
    from: string
    to: string
    subject: string
    text?: string
    html?: string
    inReplyTo?: string
  },
): Promise<void> {
  const inReplyTo = normalizeMsgId(msg.inReplyTo)
  await env.EMAIL.send({
    from: msg.from,
    to: msg.to,
    subject: msg.subject,
    ...(msg.text ? { text: msg.text } : {}),
    ...(msg.html ? { html: msg.html } : {}),
    ...(inReplyTo
      ? { headers: { 'In-Reply-To': `<${inReplyTo}>`, References: `<${inReplyTo}>` } }
      : {}),
  })
}

/** First 200 chars of the text (or tag-stripped html) body. */
function makeSnippet(text: string, html: string): string {
  return (text || html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 200)
}

/**
 * POST an event to WEBHOOK_URL (if configured): fire-and-forget with one
 * retry, run inside ctx.waitUntil so it never delays mail handling. Body is
 * `{ event, message }`; signed when WEBHOOK_SECRET is set.
 */
async function emitWebhook(
  env: Env,
  event: 'message.received' | 'message.sent',
  message: Record<string, unknown>,
): Promise<void> {
  if (!env.WEBHOOK_URL) return
  const body = JSON.stringify({ event, message })
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (env.WEBHOOK_SECRET) {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(env.WEBHOOK_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
    headers['x-inbox-signature'] =
      `sha256=${Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('')}`
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(env.WEBHOOK_URL, { method: 'POST', headers, body })
      if (res.ok) return
    } catch {
      // fall through to retry
    }
  }
  console.warn(`webhook delivery failed after 2 attempts: ${event}`)
}

/**
 * Classify an inbound message into one of env.LABELS via the Anthropic API.
 * Returns '' (no label) on any failure or an answer outside the label set —
 * labeling is strictly best-effort and must never block ingestion.
 */
async function classify(env: Env, subject: string, snippet: string): Promise<string> {
  if (!env.ANTHROPIC_API_KEY || !env.LABELS) return ''
  const labels = env.LABELS.split(',')
    .map((l) => l.trim())
    .filter(Boolean)
  if (labels.length === 0) return ''
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 16,
        messages: [
          {
            role: 'user',
            content:
              `Classify this email into exactly one of these labels: ${labels.join(', ')}.\n` +
              `Reply with the label only.\n\nSubject: ${subject}\nBody: ${snippet}`,
          },
        ],
      }),
    })
    if (!res.ok) return ''
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
    const answer = (data.content?.find((b) => b.type === 'text')?.text ?? '').trim().toLowerCase()
    return labels.find((l) => l.toLowerCase() === answer) ?? ''
  } catch {
    return ''
  }
}

interface SendBody {
  to: string
  subject: string
  text?: string
  html?: string
  from?: string
  /** RFC 5322 Message-ID of the message being replied to → In-Reply-To/References. */
  inReplyTo?: string
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const id = newId()
    const r2Key = `msgs/${id}`

    // Raw MIME first (source of truth), then parse.
    const raw = await new Response(message.raw).arrayBuffer()
    await env.RAW.put(r2Key, raw, {
      customMetadata: { from: message.from, to: message.to },
    })

    const parsed = await PostalMime.parse(raw)
    const text = parsed.text ?? ''
    const snippet = makeSnippet(text, parsed.html ?? '')

    const stub = inboxStub(env)
    const fromAddr = parsed.from?.address ?? message.from
    const subject = parsed.subject ?? ''
    const { threadId } = await stub.insert({
      id,
      direction: 'inbound',
      in_reply_to: normalizeMsgId(parsed.inReplyTo),
      message_id: normalizeMsgId(parsed.messageId),
      // Prefer the header From (what the sender shows as) over the SMTP
      // envelope sender (often a bounce address like bounces@cf-bounce.…).
      from_addr: fromAddr,
      to_addr: message.to,
      subject,
      date: parsed.date ?? new Date().toISOString(),
      snippet,
      text_body: text,
      html_body: parsed.html ?? '',
      r2_key: r2Key,
      attachments_json: JSON.stringify(
        (parsed.attachments ?? []).map((a) => ({
          filename: a.filename ?? 'attachment',
          mimeType: a.mimeType,
          size: typeof a.content === 'string' ? a.content.length : (a.content?.byteLength ?? 0),
        })),
      ),
      size: raw.byteLength,
    })

    // Post-insert extras, off the critical path: webhook push + optional
    // labeling. waitUntil keeps the email handler's completion independent of
    // either — a webhook receiver outage or classifier failure never bounces
    // mail.
    ctx.waitUntil(
      emitWebhook(env, 'message.received', {
        id,
        threadId,
        from: fromAddr,
        to: message.to,
        subject,
        snippet,
        direction: 'inbound',
      }),
    )
    ctx.waitUntil(
      classify(env, subject, snippet).then((label) =>
        label ? stub.setLabel(id, label) : undefined,
      ),
    )
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const { pathname } = url

    if (!pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request)
    }

    if (!(await authorized(request, env))) {
      return json({ error: 'unauthorized' }, 401)
    }

    const stub = inboxStub(env)

    // GET /api/messages?limit=&cursor=&label=
    if (pathname === '/api/messages' && request.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? '50')
      const cursor = url.searchParams.get('cursor') ?? undefined
      const label = url.searchParams.get('label') ?? undefined
      return json(await stub.list(Number.isFinite(limit) ? limit : 50, cursor, label))
    }

    // GET /api/search?q=&limit= — keyword match over subject + text body
    if (pathname === '/api/search' && request.method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      if (!q.trim()) return json({ error: 'required: q' }, 400)
      const limit = Number(url.searchParams.get('limit') ?? '50')
      return json({ messages: await stub.search(q.trim(), Number.isFinite(limit) ? limit : 50) })
    }

    // GET /api/threads?limit=&cursor= — newest-first, one row per thread
    if (pathname === '/api/threads' && request.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? '50')
      const cursor = url.searchParams.get('cursor') ?? undefined
      return json(await stub.listThreads(Number.isFinite(limit) ? limit : 50, cursor))
    }

    // GET /api/threads/:id — all messages in the thread, oldest-first
    const threadMatch = pathname.match(/^\/api\/threads\/([^/]+)$/)
    if (threadMatch && request.method === 'GET') {
      const messages = await stub.getThread(threadMatch[1]!)
      return messages.length ? json({ messages }) : json({ error: 'not found' }, 404)
    }

    // POST /api/send
    if (pathname === '/api/send' && request.method === 'POST') {
      let body: SendBody
      try {
        body = (await request.json()) as SendBody
      } catch {
        return json({ error: 'invalid JSON body' }, 400)
      }
      if (!body.to || !body.subject || (!body.text && !body.html)) {
        return json({ error: 'required: to, subject, and text or html' }, 400)
      }
      const from = body.from ?? env.DEFAULT_FROM
      if (!from) return json({ error: 'no from address (set DEFAULT_FROM or pass from)' }, 400)

      // Email Sending only accepts whitelisted custom headers (a Message-ID
      // of our own is rejected), so the wire Message-ID is provider-chosen
      // and unknown to us. We store a synthetic one for OUR send chain;
      // recipient replies thread via the subject+participant fallback.
      const id = newId()
      const messageId = `${id}@${from.split('@')[1] ?? 'localhost'}`
      const inReplyTo = normalizeMsgId(body.inReplyTo)

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
        return json({ error: `send failed: ${(err as Error).message}` }, 502)
      }

      // Record the outbound message so the inbox shows both sides of a
      // conversation. No raw MIME (we never see the provider's final wire
      // form), so r2_key stays empty and /raw 404s for these.
      const text = body.text ?? ''
      const snippet = makeSnippet(text, body.html ?? '')
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
      ctx.waitUntil(
        emitWebhook(env, 'message.sent', {
          id,
          threadId,
          from,
          to: body.to,
          subject: body.subject,
          snippet,
          direction: 'outbound',
        }),
      )
      return json({ ok: true, id, from, to: body.to, messageId, threadId })
    }

    // POST /api/drafts — store an outbound message without sending it
    if (pathname === '/api/drafts' && request.method === 'POST') {
      let body: SendBody
      try {
        body = (await request.json()) as SendBody
      } catch {
        return json({ error: 'invalid JSON body' }, 400)
      }
      // Drafts may be partial — completeness is enforced at send time.
      const id = newId()
      const from = body.from ?? env.DEFAULT_FROM ?? ''
      const text = body.text ?? ''
      await stub.insert({
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
      return json({ ok: true, id, status: 'draft' }, 201)
    }

    // GET /api/drafts
    if (pathname === '/api/drafts' && request.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? '50')
      return json({ drafts: await stub.listDrafts(Number.isFinite(limit) ? limit : 50) })
    }

    // PUT /api/drafts/:id | POST /api/drafts/:id/send
    const draftMatch = pathname.match(/^\/api\/drafts\/([^/]+)(\/send)?$/)
    if (draftMatch) {
      const [, draftId, sendSuffix] = draftMatch

      if (!sendSuffix && request.method === 'PUT') {
        let body: SendBody
        try {
          body = (await request.json()) as SendBody
        } catch {
          return json({ error: 'invalid JSON body' }, 400)
        }
        const text = body.text
        const html = body.html
        const updated = await stub.updateDraft(draftId!, {
          ...(body.from !== undefined ? { from_addr: body.from } : {}),
          ...(body.to !== undefined ? { to_addr: body.to } : {}),
          ...(body.subject !== undefined ? { subject: body.subject } : {}),
          ...(text !== undefined ? { text_body: text } : {}),
          ...(html !== undefined ? { html_body: html } : {}),
          ...(body.inReplyTo !== undefined ? { in_reply_to: normalizeMsgId(body.inReplyTo) } : {}),
          ...(text !== undefined || html !== undefined
            ? { snippet: makeSnippet(text ?? '', html ?? '') }
            : {}),
        })
        return updated ? json({ ok: true, id: draftId }) : json({ error: 'not a draft' }, 404)
      }

      if (sendSuffix && request.method === 'POST') {
        const draft = await stub.get(draftId!)
        if (!draft || draft.status !== 'draft') return json({ error: 'not a draft' }, 404)
        const from = draft.from_addr || env.DEFAULT_FROM
        if (!from)
          return json({ error: 'no from address (set DEFAULT_FROM or the draft from)' }, 400)
        if (!draft.to_addr || !draft.subject || (!draft.text_body && !draft.html_body)) {
          return json({ error: 'draft incomplete: needs to, subject, and text or html' }, 400)
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
          return json({ error: `send failed: ${(err as Error).message}` }, 502)
        }
        // Persist the from that was actually used (may have come from
        // DEFAULT_FROM), then flip the row to sent — thread resolves NOW.
        if (from !== draft.from_addr) await stub.updateDraft(draftId!, { from_addr: from })
        const sent = await stub.markDraftSent(draftId!, new Date().toISOString())
        if (!sent) return json({ error: 'draft vanished during send' }, 500)
        ctx.waitUntil(
          emitWebhook(env, 'message.sent', {
            id: draftId,
            threadId: sent.threadId,
            from,
            to: draft.to_addr,
            subject: draft.subject,
            snippet: draft.snippet,
            direction: 'outbound',
          }),
        )
        return json({ ok: true, id: draftId, from, to: draft.to_addr, threadId: sent.threadId })
      }
      if (!sendSuffix && request.method === 'GET') {
        const draft = await stub.get(draftId!)
        return draft && draft.status === 'draft' ? json(draft) : json({ error: 'not a draft' }, 404)
      }
      if (!sendSuffix && request.method === 'DELETE') {
        const draft = await stub.get(draftId!)
        if (!draft || draft.status !== 'draft') return json({ error: 'not a draft' }, 404)
        await stub.delete(draftId!)
        return json({ ok: true })
      }
    }

    // GET /api/messages/:id/attachments/:n — raw bytes of one attachment.
    // Re-parses the R2 MIME blob per request (cheap at the 5 MiB cap) rather
    // than pre-splitting attachments at write time.
    const attMatch = pathname.match(/^\/api\/messages\/([^/]+)\/attachments\/(\d+)$/)
    if (attMatch && request.method === 'GET') {
      const msg = await stub.get(attMatch[1]!)
      if (!msg) return json({ error: 'not found' }, 404)
      if (!msg.r2_key) return json({ error: 'no raw MIME (outbound message)' }, 404)
      const obj = await env.RAW.get(msg.r2_key)
      if (!obj) return json({ error: 'raw MIME missing from R2' }, 404)
      const parsed = await PostalMime.parse(await obj.arrayBuffer())
      const n = Number(attMatch[2])
      const att = (parsed.attachments ?? [])[n]
      if (!att) return json({ error: `no attachment at index ${n}` }, 404)
      const body =
        typeof att.content === 'string' ? new TextEncoder().encode(att.content) : att.content
      return new Response(body, {
        headers: {
          'content-type': att.mimeType || 'application/octet-stream',
          'content-disposition': `attachment; filename="${(att.filename ?? 'attachment').replace(/["\r\n]/g, '')}"`,
          'cache-control': 'no-store',
        },
      })
    }

    // /api/messages/:id[/raw]
    const match = pathname.match(/^\/api\/messages\/([^/]+)(\/raw)?$/)
    if (match) {
      const [, id, rawSuffix] = match

      if (rawSuffix && request.method === 'GET') {
        const msg = await stub.get(id!)
        if (!msg) return json({ error: 'not found' }, 404)
        if (!msg.r2_key) return json({ error: 'no raw MIME (outbound message)' }, 404)
        const obj = await env.RAW.get(msg.r2_key)
        if (!obj) return json({ error: 'raw MIME missing from R2' }, 404)
        return new Response(obj.body, {
          headers: { 'content-type': 'message/rfc822', 'cache-control': 'no-store' },
        })
      }

      if (!rawSuffix && request.method === 'GET') {
        const msg = await stub.get(id!)
        return msg ? json(msg) : json({ error: 'not found' }, 404)
      }

      if (!rawSuffix && request.method === 'DELETE') {
        const r2Key = await stub.delete(id!)
        if (!r2Key) return json({ error: 'not found' }, 404)
        await env.RAW.delete(r2Key)
        return json({ ok: true })
      }
    }

    return json({ error: 'not found' }, 404)
  },
}
