/**
 * Helpers shared by the Worker entry (index.ts) and the Inbox Durable Object
 * (inbox-do.ts — its alarm() dispatches scheduled sends). Lives apart from
 * both to avoid an import cycle.
 */

/**
 * Email Service send binding (the NEW object-based API, not the legacy
 * EmailMessage one). The legacy `new EmailMessage(from, to, raw)` path routes
 * through Email Routing and only delivers to VERIFIED destination addresses;
 * the object form goes through Email Sending and accepts any recipient as
 * long as the From domain is onboarded.
 */
export interface SendEmailBinding {
  send(message: {
    from: string
    to: string
    subject: string
    text?: string
    html?: string
    headers?: Record<string, string>
  }): Promise<unknown>
}

/** The env slice mail dispatch + webhooks need (subset of the worker Env). */
export interface MailEnv {
  EMAIL: SendEmailBinding
  WEBHOOK_URL?: string
  WEBHOOK_SECRET?: string
}

/** Time-ordered id: ms timestamp (base36, padded) + random suffix. Sortable as TEXT. */
export function newId(): string {
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
export function normalizeMsgId(id: string | undefined | null): string {
  return (id ?? '').replace(/[\s<>]/g, '')
}

/** First 200 chars of the text (or tag-stripped html) body. */
export function makeSnippet(text: string, html: string): string {
  return (text || html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 200)
}

/**
 * Dispatch via the Email Sending binding. In-Reply-To/References are the only
 * threading headers Cloudflare accepts (a custom Message-ID is rejected).
 */
export async function sendMail(
  env: MailEnv,
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

/**
 * POST an event to WEBHOOK_URL (if configured): fire-and-forget with one
 * retry — callers run it inside ctx.waitUntil so it never delays mail
 * handling. Body is `{ event, message }`; signed when WEBHOOK_SECRET is set.
 */
export async function emitWebhook(
  env: MailEnv,
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
