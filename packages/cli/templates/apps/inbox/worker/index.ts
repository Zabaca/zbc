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
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const id = newId()
    const r2Key = `msgs/${id}`

    // Raw MIME first (source of truth), then parse.
    const raw = await new Response(message.raw).arrayBuffer()
    await env.RAW.put(r2Key, raw, {
      customMetadata: { from: message.from, to: message.to },
    })

    const parsed = await PostalMime.parse(raw)
    const text = parsed.text ?? ''
    const snippet = (text || (parsed.html ?? '').replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200)

    await inboxStub(env).insert({
      id,
      direction: 'inbound',
      in_reply_to: normalizeMsgId(parsed.inReplyTo),
      message_id: normalizeMsgId(parsed.messageId),
      // Prefer the header From (what the sender shows as) over the SMTP
      // envelope sender (often a bounce address like bounces@cf-bounce.…).
      from_addr: parsed.from?.address ?? message.from,
      to_addr: message.to,
      subject: parsed.subject ?? '',
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
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const { pathname } = url

    if (!pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request)
    }

    if (!(await authorized(request, env))) {
      return json({ error: 'unauthorized' }, 401)
    }

    const stub = inboxStub(env)

    // GET /api/messages?limit=&cursor=
    if (pathname === '/api/messages' && request.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? '50')
      const cursor = url.searchParams.get('cursor') ?? undefined
      return json(await stub.list(Number.isFinite(limit) ? limit : 50, cursor))
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
      const headers: Record<string, string> | undefined = inReplyTo
        ? { 'In-Reply-To': `<${inReplyTo}>`, References: `<${inReplyTo}>` }
        : undefined

      try {
        await env.EMAIL.send({
          from,
          to: body.to,
          subject: body.subject,
          ...(body.text ? { text: body.text } : {}),
          ...(body.html ? { html: body.html } : {}),
          ...(headers ? { headers } : {}),
        })
      } catch (err) {
        return json({ error: `send failed: ${(err as Error).message}` }, 502)
      }

      // Record the outbound message so the inbox shows both sides of a
      // conversation. No raw MIME (we never see the provider's final wire
      // form), so r2_key stays empty and /raw 404s for these.
      const text = body.text ?? ''
      const snippet = (text || (body.html ?? '').replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200)
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
      return json({ ok: true, id, from, to: body.to, messageId, threadId })
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
