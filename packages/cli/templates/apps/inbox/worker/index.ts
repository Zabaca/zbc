/**
 * Inbox Worker: an agent-accessible email inbox.
 *
 * - `email()` handler: Email Routing (catch-all) delivers inbound mail here.
 *   Raw MIME → R2; parsed metadata + bodies → the Inbox Durable Object.
 * - `/api/*`: bearer-authed JSON API — handled by `api.ts`.
 * - `/mcp`: the MCP server over the same operations — handled by `mcp.ts`.
 * - Everything else: the static UI in public/ (ASSETS binding).
 *
 * This file is the runtime entry only: the Env, the bearer check, inbound mail
 * and the dispatch. Both adapters live beside it so a test can load them —
 * see the note atop `api.ts`.
 */
import PostalMime from 'postal-mime'
import { type ApiEnv, handleApi, json } from './api'
import { Inbox, type InboxStore } from './inbox-do'
import { handleMcp } from './mcp'
import { type SendEmailBinding, emitWebhook, makeSnippet, newId, normalizeMsgId } from './shared'

export { Inbox }

export interface Env extends ApiEnv {
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

function inboxStub(env: Env) {
  return env.INBOX.get(env.INBOX.idFromName('inbox'))
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

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const { pathname } = url

    if (pathname !== '/mcp' && !pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request)
    }

    if (!(await authorized(request, env))) {
      return json({ error: 'unauthorized' }, 401)
    }

    // The DO stub reaches both adapters as an InboxStore: `DurableObjectStub<
    // Inbox>` expands workers-types' recursive RPC generics inside mcp.ts's
    // registerTool inference and trips TS2589. This is the one cast.
    const store = inboxStub(env) as unknown as InboxStore

    // POST/GET/DELETE /mcp — MCP server (Streamable HTTP), same bearer token
    if (pathname === '/mcp') {
      return handleMcp(request, { env, store })
    }

    return handleApi(request, { env, store })
  },
}
