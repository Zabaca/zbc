import type { Result } from '../store/store'
import type { ArrivalFile, ArrivalOutcome, RawBucket } from './arrivals'
import { type DeclaredMailbox, mailboxFor } from './declared'

/**
 * The Worker's email entrance, as a function: what Cloudflare Email Routing calls with each message it hands over.
 * src/entrances.ts (`takeEmail`) is the thin shell that supplies the real message, bucket and Durable Object; everything decided is here, so
 * `bun test` drives it with a bucket and a store that can fail.
 *
 * ── THE ORDER IS THE DESIGN ──────────────────────────────────────────────
 *   1. A message is accepted only for a declared domain. Anything else is refused outright and nothing is kept, so routing
 *      another domain at this Worker by mistake cannot make the inbox a catch-all for it.
 *   2. The RAW message is written to the bucket FIRST, before it is parsed and before the store hears of it, and not behind
 *      `waitUntil`. The copy is the only exact record: if the inbox's own filing is broken, the message is still there.
 *   3. Only then is the store asked to file it, from that copy (arrivals.ts). That never fails the entrance: a failure is
 *      recorded as owed and the Durable Object's alarm files it later.
 *
 * ── WHEN IT DOES THROW ───────────────────────────────────────────────────
 * Writing the raw copy failed, or the store is unreachable so not even the debt could be written. Throwing is what
 * makes Cloudflare treat the delivery as failed. How the sender is told (a temporary failure that its server retries, as
 * one would hope, or something else) is NOT documented by Cloudflare and is checked on the real account: see
 * the runbook for a business mailbox's mail. It never calls `setReject` for a failure of ours: a bounce is a permanent
 * answer, and mail a customer wrote must never be bounced because the inbox hiccuped ("the handler
 * never rejects", applied to everything but a domain nobody declared).
 *
 * ── THE RAW COPY'S KEY IS ITS HASH ───────────────────────────────────────
 * `in/<sha-256 of the bytes>`, so a delivery that happens twice (Cloudflare retrying a Worker call that failed) writes
 * the same key and never a second object, and an existing object is left exactly as it was. The envelope sender and
 * recipient ride on the object as metadata.
 */

/** What Email Routing hands the handler: the envelope, the raw stream, its size, and the one way to refuse. */
export interface InboundEmail {
  from: string
  to: string
  raw: ReadableStream<Uint8Array>
  rawSize: number
  setReject(reason: string): void
}

/** The most a message can be. Cloudflare's own limit on inbound mail; a bigger one is not read into memory. */
export const MAX_RAW_BYTES = 25 * 1024 * 1024

export interface EntranceDeps {
  mailboxes: readonly DeclaredMailbox[]
  bucket: RawBucket
  /** The Durable Object's `fileArrival`. */
  file: (input: ArrivalFile) => Promise<Result<{ outcome: ArrivalOutcome }>>
  now: () => Date
}

export type Entered = 'refused' | ArrivalOutcome

export const REFUSED_UNKNOWN_DOMAIN = 'This address is not served here.'
export const REFUSED_TOO_LARGE = 'This message is larger than the mailbox accepts.'

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function receiveEmail(message: InboundEmail, deps: EntranceDeps): Promise<Entered> {
  if (!mailboxFor(deps.mailboxes, message.to)) {
    message.setReject(REFUSED_UNKNOWN_DOMAIN)
    return 'refused'
  }
  if (message.rawSize > MAX_RAW_BYTES) {
    message.setReject(REFUSED_TOO_LARGE)
    return 'refused'
  }

  const receivedAt = deps.now().toISOString()
  const raw = await new Response(message.raw).arrayBuffer()
  const rawKey = `in/${await sha256Hex(raw)}`
  // Written before anything else, and awaited. A copy already there (the same bytes delivered again) is left alone.
  if ((await deps.bucket.head(rawKey)) === null) {
    await deps.bucket.put(rawKey, raw, { customMetadata: { from: message.from, to: message.to, receivedAt } })
  }

  // The raw copy is kept, so a failure past this point leaves a message in `in/` that nothing has filed. The log line names the key, so a sitting that moves the store (the space's runbook for the move)
  // can count these in the tail and compare them with the keys written; a retry of the same bytes makes the same key and files it (the arrival key is idempotent).
  let filed: Awaited<ReturnType<EntranceDeps['file']>>
  try {
    filed = await deps.file({ rawKey, envelopeFrom: message.from, envelopeTo: message.to, receivedAt })
  } catch (error) {
    console.error(
      `email: kept ${rawKey} but the inbox could not be asked to file it: ${error instanceof Error ? error.message : String(error)}`,
    )
    throw error
  }
  if (!filed.ok) {
    console.error(`email: kept ${rawKey} but the inbox would not file it (${filed.status}): ${filed.error}`)
    throw new Error(`The inbox would not file the message (${filed.status}): ${filed.error}`)
  }
  console.log(`email: ${filed.value.outcome} ${rawKey}`)
  return filed.value.outcome
}
