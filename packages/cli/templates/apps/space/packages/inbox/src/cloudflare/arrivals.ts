import { readDeliveryEvent } from '../delivery'
import { backoffMs } from '../gmail/mailroom'
import type { MailboxContent } from '../mailbox-content'
import type { MailStore } from '../store/mail'
import { fail, ok, type Result } from '../store/store'
import { type DeclaredMailbox, mailboxFor } from './declared'
import { parseRaw } from './parse'
import { type AiPort, classifyMail } from './spam-check'

/**
 * Filing a message Cloudflare delivered, from its kept raw copy: the Durable Object's half of arrival (the entrance,
 * entrance.ts, is the Worker's half and writes the copy first).
 *
 * ── ONE PATH FOR THE FIRST FILING AND EVERY RETRY ────────────────────────
 * The entrance does not hand over the parsed message. It hands over where the raw copy is, and this reads it back from
 * the bucket, parses it and files it. So the first filing and a retry by the alarm are the same code over the same bytes,
 * and a copy that was kept is a copy that can always be filed later.
 *
 * ── AFTER THE RAW COPY IS KEPT, FILING NEVER FAILS THE ENTRANCE ──────────
 * If reading it back, parsing it or filing it fails, the copy is recorded as owed (arrival_owed: with the envelope and
 * the time the Worker received it) and the alarm files it again, with the Gmail side's backoff (30 seconds, doubling, an
 * hour at most), up to MAX_ARRIVAL_ATTEMPTS times; then it is given up on, kept and counted as unfiled, and nothing retries it. The sender is never asked to send twice for the inbox's trouble. The one
 * failure that still reaches the entrance is the store being unreachable altogether, when even the debt cannot be written;
 * the raw copy is kept and the entrance fails, as it does when the copy cannot be written.
 *
 * ── ARCHIVE, THEN FILE, THEN ASK THE SPAM CLASSIFIER, THEN NOTIFY ────────
 * Once a message is filed it may be put to the spam classifier, Cloudflare's decision model on Workers AI, for the spam check
 * (the inbox's ADR 0001): the raw copy is in the bucket and the row is in the
 * store, so nothing the model does can cost the message. `judge` never throws, a call is cut off after a few seconds, and a
 * message nothing judged (the switch is off, the binding is missing, the call failed or timed out) is stored with NULL
 * and is in the Inbox. THEN the notification rule is asked, once, with the score stored: Inbox mail notifies and Bulk does not.
 * The classifier is not asked of mail a rule has already settled (a List-Unsubscribe header, an automated sender, a Client's contact, a
 * person's call, our own mail): `spamCheckGate` says which.
 */
export interface RawBucket {
  head(key: string): Promise<unknown>
  /** `size` is the object's, known before its body is read (R2's `size`): a caller that must bound what it reads checks it first. */
  get(
    key: string,
    options?: { range: { offset: number; length: number } },
  ): Promise<{ size?: number; arrayBuffer(): Promise<ArrayBuffer> } | null>
  /** A Telegram file is put as a stream (`ReadableStream`), which R2 takes only of a known length (src/telegram/media.ts); mail is put as bytes. */
  put(
    key: string,
    value: ArrayBuffer | ReadableStream<Uint8Array>,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<unknown>
  /** Only a Telegram file is ever deleted (`tg/<message id>`): mail's raw copies are kept for good. */
  delete(key: string): Promise<unknown>
}

/** What the entrance tells the store about a raw copy it has kept. */
export interface ArrivalFile {
  rawKey: string
  envelopeFrom: string
  envelopeTo: string
  /** When the Worker received it (ISO): what the message's received time is, however late it is filed. */
  receivedAt: string
}

export type ArrivalOutcome = 'filed' | 'duplicate' | 'owed'

export interface ArrivalsPorts {
  store: MailStore
  bucket: RawBucket
  mailboxes: readonly DeclaredMailbox[]
  now: () => Date
  /** Ask for the alarm at `at`, without replacing an earlier one (the Gmail side shares the Durable Object's one alarm). */
  scheduleAlarm: (at: Date) => void | Promise<void>
  /**
   * Hands a notification on once a message is filed (src/notify/deliver.ts). Optional: Arrivals without one notify nobody. A
   * bell never holds up mail: whatever goes wrong is logged and the filing stands.
   */
  notifications?: { deliverOwed(): Promise<void> } | null
  /** The install's mailbox content: the questions each mailbox's mail is put to (a mailbox with none is not asked). */
  content: MailboxContent
  /** Workers AI, for the spam check. Null or absent in a Worker deployed without the binding: nothing is judged, and mail arrives all the same. */
  ai?: AiPort | null
  /** How long the classifier may take before it counts as no answer (spam-check.ts has the default). */
  clefTimeoutMs?: number
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The hash a raw copy's key ends in, which names a message that has no Message-ID. */
const hashOf = (rawKey: string): string => rawKey.slice(rawKey.lastIndexOf('/') + 1)

export class Arrivals {
  constructor(private readonly ports: ArrivalsPorts) {}

  /**
   * File one kept raw copy. The route in: the entrance calls it through the Durable Object. Answers what happened to the
   * message, and a 422 only for an address on no declared domain (the entrance has already refused those, so this is a
   * config that changed under it).
   */
  async fileArrival(input: ArrivalFile): Promise<Result<{ outcome: ArrivalOutcome }>> {
    const declared = mailboxFor(this.ports.mailboxes, input.envelopeTo)
    if (!declared) return fail(422, 'No mailbox is declared for that address, so nothing was filed.')
    // Recording the row is the store's own work: if it throws the store is not reachable, which is the entrance's to fail.
    const mailbox = this.ports.store.cloudflareMailbox(declared)
    let outcome: ArrivalOutcome
    try {
      outcome = await this.file(mailbox.id, declared, input)
    } catch (error) {
      await this.owe(mailbox.id, input, error, 1)
      return ok({ outcome: 'owed' as const })
    }
    // No notification is delivered here: this runs inside Cloudflare's email handler, which has a time limit, and a push service
    // can take its whole timeout per device. The Worker asks for `deliverNotifications` after the handler has answered
    // (src/entrances.ts, `ctx.waitUntil`); a filing that is marked owed and never handed on is handed on by the next delivery run.
    return ok({ outcome })
  }

  /**
   * Keep the reports Cloudflare's Email Sending published about mail this inbox sent (src/delivery.ts): the queue handler's one call, a batch of
   * the messages it was handed. A body that is not a report from one of our mailboxes is dropped, not kept and not an error (the same domain also
   * sends mail that is not ours). Answers how many were new and how many were dropped; a store that throws fails the call, and the queue then
   * delivers the batch again, which is safe because a report is kept once however many times it arrives.
   */
  keepDeliveryEvents(bodies: readonly unknown[]): {
    kept: number
    repeated: number
    dropped: number
    unmatched: number
  } {
    const senders = this.ports.mailboxes.map((m) => m.address)
    const now = this.ports.now()
    let kept = 0
    let repeated = 0
    let dropped = 0
    let unmatched = 0
    for (const body of bodies) {
      const event = readDeliveryEvent(body, senders, now)
      if (!event) dropped += 1
      else if (this.ports.store.keepDeliveryEvent(event, now.toISOString())) kept += 1
      else repeated += 1
      // A report no sent message is filed under yet. Early reports are expected and wait; a report that stays here after its send is filed means the id Cloudflare
      // reports is not the one the send was filed under, which is the first thing the live check reads (the Worker logs it, src/entrances.ts).
      if (event && !this.ports.store.holdsSentMessage(event.providerId)) unmatched += 1
    }
    return { kept, repeated, dropped, unmatched }
  }

  /** The alarm's part: file every kept copy whose retry has come, and ask for the next alarm if any is still owed. */
  async runOwed(): Promise<void> {
    for (const owed of this.ports.store.owedArrivals(this.ports.now().toISOString())) {
      const declared = mailboxFor(this.ports.mailboxes, owed.envelopeTo)
      try {
        if (!declared) throw new Error('No mailbox is declared for the address this was sent to.')
        await this.file(owed.mailboxId, declared, owed)
      } catch (error) {
        await this.owe(owed.mailboxId, owed, error, owed.attempts + 1)
      }
    }
    await this.deliverNotifications()
    const next = this.ports.store.nextOwedAt()
    if (next !== null) await this.ports.scheduleAlarm(new Date(Math.max(Date.parse(next), this.ports.now().getTime())))
  }

  private async file(mailboxId: string, declared: DeclaredMailbox, input: ArrivalFile): Promise<ArrivalOutcome> {
    const object = await this.ports.bucket.get(input.rawKey)
    if (!object) throw new Error('The raw copy is not in the bucket.')
    const parsed = await parseRaw(await object.arrayBuffer())
    const domains = this.ports.mailboxes.map((m) => m.domain)
    const filed = this.ports.store.fileArrival(mailboxId, parsed, {
      rawKey: input.rawKey,
      arrivalKey: parsed.messageId ?? `hash:${hashOf(input.rawKey)}`,
      receivedAt: input.receivedAt,
      isOurs: (address) => domains.includes(address.toLowerCase().split('@')[1] ?? '') || address === declared.address,
    })
    if (!filed.stored) return 'duplicate'
    // A newer update of a calendar event replaces the older ones. A failure is a meeting shown twice and never an unfiled message.
    try {
      this.ports.store.closeSupersededLocal()
    } catch (error) {
      console.warn(`arrival: could not close the calendar mail ${filed.messageId} replaces: ${describe(error)}`)
    }
    await this.judge(filed.messageId)
    // Marked owed here, after the filing's own transaction and the classifier's answer, once: a failure to mark is a missed bell and never
    // an unfiled message.
    try {
      this.ports.store.markFiledNotification(filed.messageId)
    } catch (error) {
      console.warn(`arrival: could not mark ${filed.messageId} for a notification: ${describe(error)}`)
    }
    return 'filed'
  }

  /**
   * Ask the spam classifier about a message that is filed, and store what it said. NEVER THROWS: not asking, the binding missing, the call
   * failing or timing out, an answer of a shape nobody promised and a store that refuses the write all leave the message not
   * judged, in the Inbox, and the log says which. What the score means is src/queue.ts, not here.
   */
  private async judge(messageId: string): Promise<void> {
    try {
      const gate = this.ports.store.spamCheckGate(messageId)
      if (!gate.ask) {
        console.log(`spam check: ${messageId} not judged: ${gate.why}`)
        return
      }
      if (!this.ports.ai) {
        console.warn(`spam check: ${messageId} not judged: the Worker has no Workers AI binding`)
        return
      }
      const facts = await classifyMail(this.ports.ai, gate.mail, {
        questions: this.ports.content.spamQuestions(gate.mailbox),
        ...(this.ports.clefTimeoutMs !== undefined && { timeoutMs: this.ports.clefTimeoutMs }),
      })
      if (!facts) {
        console.warn(`spam check: ${messageId} not judged: Clef gave no usable answer`)
        return
      }
      this.ports.store.recordJudgment(messageId, facts)
      console.log(`spam check: judged ${messageId}: ${facts.category} ${facts.junk.toFixed(2)}`)
    } catch (error) {
      console.warn(`spam check: ${messageId} not judged: ${describe(error)}`)
    }
  }

  /** Hand on what is owed: one delivery run, whose failure is logged and nothing more. */
  async deliverNotifications(): Promise<void> {
    try {
      await this.ports.notifications?.deliverOwed()
    } catch (error) {
      console.error(`arrival: notifications failed: ${describe(error)}`)
    }
  }

  private async owe(mailboxId: string, input: ArrivalFile, error: unknown, attempts: number): Promise<void> {
    const at = new Date(this.ports.now().getTime() + backoffMs(attempts))
    console.warn(`arrival: ${input.rawKey} kept but not filed (attempt ${attempts}): ${describe(error)}`)
    const { gaveUp } = this.ports.store.recordOwed(mailboxId, input, describe(error), at.toISOString())
    if (!gaveUp) await this.ports.scheduleAlarm(at)
  }
}
