/**
 * The push webhook: one signed HTTP POST per moved ref, to the one URL the
 * operator configured.
 *
 * It exists for a receiver that cannot hold the ref-event WebSocket open — a
 * serverless function is the case it was asked for — and it is the same
 * announcement, not a second source of truth. It is produced where the stream's
 * announcement is (`publish` in `src/announce.ts`, run by the detached
 * announcer `post-receive` spawns), from the same ref changes, so anything that
 * moves a ref through that path fires both and there is no way to move one
 * without the other.
 *
 * Unlike the stream, this side owes a delivery: a receiver behind a URL has no
 * handshake to catch up through. So it is AT LEAST ONCE, with a bounded retry,
 * and every event carries a stable `id` — generated once, sent identically on
 * every attempt — for the receiver to de-duplicate on. It is still not a log
 * (docs/adr/0009): an event whose attempts all fail is dropped — its line goes
 * to the announcer's stderr, which `post-receive` detaches from the client — and
 * nothing replays it; `index.json` holds the refs regardless.
 *
 * Signing is HMAC-SHA256 over `<timestamp>.<body>` with the shared secret. The
 * timestamp is signed so a receiver can refuse a replay of a captured request
 * by its age, and it is re-stamped on each attempt while the body stays the
 * same, so a late retry is still fresh and still the same event.
 *
 * Runtime-neutral (WebCrypto and `fetch` only) so the Worker could deliver the
 * same thing if a ref ever moves from the edge; the clock, the sleep and the
 * fetch are all injected so the retry policy is tested without waiting on it.
 */

import { eventsFromChanges } from './events'
import { ZERO_OID } from './protocol'
import { ulid } from './ulid'

export interface WebhookConfig {
  /** Where every event is POSTed (`WALGIT_WEBHOOK_URL`). */
  url: string
  /** The HMAC key (`WALGIT_WEBHOOK_SECRET`). Never logged, never sent. */
  secret: string
}

/** What one POST carries. Field names are the ref-event stream's, plus `oldSha`. */
export interface WebhookEvent {
  /** Stable across retries — de-duplicate on it. A ULID, so it also sorts by time. */
  id: string
  repo: string
  ref: string
  /** Where the ref was before this push. `null` when the push created it. */
  oldSha: string | null
  /** Where it is now. `null` when the push deleted it — as on the stream. */
  sha: string | null
  /** The Proposals this move merged (docs/adr/0018); absent when none, as on the stream. */
  merged?: string[]
  /** When the ref moved, ISO 8601. */
  timestamp: string
}

export const SIGNATURE_HEADER = 'X-Walgit-Signature'
export const TIMESTAMP_HEADER = 'X-Walgit-Timestamp'
export const EVENT_ID_HEADER = 'X-Walgit-Event'

/**
 * How old a signed timestamp a receiver should accept, in seconds — the
 * default `verifyWebhook` applies. Generous enough for clock skew and one
 * slow attempt; every retry is re-stamped, so backoff never ages a request.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300

/**
 * The retry policy. Five attempts, backing off 1, 2, 4 and 8 seconds, each
 * attempt bounded: an unreachable receiver costs the detached announcer well
 * under a minute and the push nothing at all.
 */
export const WEBHOOK_ATTEMPTS = 5
export const WEBHOOK_BACKOFF_MS = 1_000
export const WEBHOOK_TIMEOUT_MS = 5_000
/**
 * At most this many events of one push in flight at once. A mirror push moves
 * hundreds of refs, and a receiver should not meet all of them at once.
 */
export const WEBHOOK_CONCURRENCY = 4

/**
 * The webhook's configuration, or null when this deployment has none.
 *
 * Both halves, as with the stream: an unsigned webhook is one a receiver cannot
 * tell from a stranger's POST, so a URL without a secret is not a webhook.
 */
export function webhookConfigFromEnv(
  env: Record<string, string | undefined>,
): WebhookConfig | null {
  const url = (env.WALGIT_WEBHOOK_URL ?? '').trim()
  const secret = env.WALGIT_WEBHOOK_SECRET ?? ''
  // Blank reads as unset, but a real secret is the HMAC key VERBATIM: the
  // receiver holds its own copy, and one trimmed here would never verify there.
  if (!url || !secret.trim()) return null
  return { url, secret }
}

/**
 * The events one push's ref changes become. The same refs the stream
 * announces (`eventsFromChanges`), each given its previous sha and an id.
 */
export function webhookEventsFromChanges(
  repo: string,
  changes: readonly { ref: string; oldOid: string; newOid: string }[],
  merged: Readonly<Record<string, string[]>> = {},
  now: number = Date.now(),
): WebhookEvent[] {
  const before = new Map(changes.map((change) => [change.ref, change.oldOid]))
  const timestamp = new Date(now).toISOString()
  return eventsFromChanges(repo, changes, merged).map((event) => {
    const old = before.get(event.ref)
    return {
      id: ulid(now),
      repo: event.repo,
      ref: event.ref,
      oldSha: !old || old === ZERO_OID ? null : old,
      sha: event.sha,
      ...(event.merged ? { merged: event.merged } : {}),
      timestamp,
    }
  })
}

const encoder = new TextEncoder()

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))
  let hex = ''
  for (const byte of mac) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** `sha256=<hex>` over `<timestamp>.<body>`, the value of `X-Walgit-Signature`. */
export async function signWebhook(
  secret: string,
  timestamp: string,
  body: string,
): Promise<string> {
  return `sha256=${await hmacHex(secret, `${timestamp}.${body}`)}`
}

/** Compared in full whatever the first difference, so the time taken says nothing. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * The receiver's check: is this request walgit's, and recent?
 *
 * `body` must be the RAW request body, byte for byte — a body parsed and
 * re-serialized is a different string and will not verify. False on any
 * missing header, a timestamp outside `toleranceSeconds` of `now`, or a
 * signature that does not match.
 */
export async function verifyWebhook(input: {
  secret: string
  body: string
  signature: string | null
  timestamp: string | null
  now?: number
  toleranceSeconds?: number
}): Promise<boolean> {
  const { secret, body, signature, timestamp } = input
  if (!signature || !timestamp || !/^\d+$/.test(timestamp)) return false
  const now = Math.floor((input.now ?? Date.now()) / 1000)
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
  if (Math.abs(now - Number(timestamp)) > tolerance) return false
  return constantTimeEqual(signature, await signWebhook(secret, timestamp, body))
}

/** Worth trying again: the receiver is down or overloaded, not refusing. */
function retryable(status: number): boolean {
  return status >= 500 || status === 429 || status === 408
}

export interface DeliverOptions {
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  attempts?: number
  backoffMs?: number
  timeoutMs?: number
  log?: (line: string) => void
}

/**
 * Deliver every event of one push, at most `WEBHOOK_CONCURRENCY` at a time.
 * Never throws; resolves once every event is delivered or given up on.
 */
export async function deliverWebhooks(
  config: WebhookConfig,
  events: readonly WebhookEvent[],
  options: DeliverOptions = {},
  concurrency: number = WEBHOOK_CONCURRENCY,
): Promise<void> {
  let next = 0
  const lane = async () => {
    while (next < events.length) {
      const event = events[next]!
      next += 1
      await deliverWebhook(config, event, options)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, events.length) }, lane))
}

/**
 * POST one event until a 2xx, a refusal that is not worth repeating, or the
 * attempts run out. Never throws; true when the receiver accepted it.
 *
 * What is logged names the event and the status, never the secret, the
 * signature or the URL's query (which is where a receiver's own token tends
 * to live).
 */
export async function deliverWebhook(
  config: WebhookConfig,
  event: WebhookEvent,
  options: DeliverOptions = {},
): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = options.now ?? Date.now
  const attempts = options.attempts ?? WEBHOOK_ATTEMPTS
  const backoffMs = options.backoffMs ?? WEBHOOK_BACKOFF_MS
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS
  const log = options.log ?? ((line: string) => console.error(line))
  const body = JSON.stringify(event)

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let outcome: string
    try {
      const timestamp = String(Math.floor(now() / 1000))
      const response = await fetchImpl(config.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'walgit-webhook',
          [EVENT_ID_HEADER]: event.id,
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: await signWebhook(config.secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
        // Never followed: a 307 would re-send the signed body to whatever host
        // the receiver names, and a 301 would turn it into a GET that "succeeds".
        redirect: 'manual',
      })
      // Drained so a kept-alive connection is free for the next attempt.
      await response.body?.cancel().catch(() => {})
      if (response.ok) return true
      outcome = `refused (${response.status})`
      if (!retryable(response.status)) {
        log(`walgit: webhook ${event.id} ${outcome}; not retried`)
        return false
      }
    } catch (err) {
      outcome = `failed: ${(err as Error).name}`
    }
    if (attempt === attempts) {
      log(`walgit: webhook ${event.id} ${outcome}; giving up after ${attempts} attempts`)
      return false
    }
    // Jittered, so the events of one large push that all met the same outage
    // do not all come back at the same instant.
    const base = backoffMs * 2 ** (attempt - 1)
    await sleep(Math.round(base * (0.75 + Math.random() * 0.5)))
  }
  return false
}
