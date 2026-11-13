/**
 * The store's Cloudflare half: a mailbox fed by Cloudflare Email Routing, and turning a raw message that arrived into a
 * row. Synchronous SQL over the same ports as the rest of the store, so every rule here runs under plain `bun` against a
 * real SQLite; the entrance (src/cloudflare/entrance.ts) and the Durable Object's arrival work
 * (src/cloudflare/arrivals.ts) do the waiting and call these in short transactions.
 *
 * ── A SUBCLASS ONLY TO SHARE HELPERS ─────────────────────────────────────
 * `Inbox` → `ArrivalStore` → `MailStore`: this class sits between so it can use the base's `audit`, `identityFor` and
 * `touchConversation` without making them public, and so mail.ts (the Gmail half) is not made longer by a
 * second kind of mailbox. The Durable Object builds a `MailStore` and nothing else.
 *
 * ── THE MAIL LIVES HERE ──────────────────────────────────────────────────
 * Unlike Gmail's, a Cloudflare mailbox has no other copy to refill from: the inbox's store and the exact copy kept in
 * the raw-mail bucket are the whole record. So a message is stored once, with the key of its
 * raw copy, and nothing here deletes one.
 *
 * ── EVERY FILING IS AN UPSERT ────────────────────────────────────────────
 * A message is found by (mailbox, arrival key): its Message-ID, or the hash of its bytes when it has none. A delivery
 * that happens twice, and a retry from the kept copy of one that was already filed, store nothing the second time.
 *
 * ── READ AND CLOSED ARE THE INBOX'S OWN STAMPS ───────────────────────────
 * A message arrives with neither stamp, which is unread and open; the owner opening it and Close write them (the Gmail
 * half's `stampManual`, which a conversation with no Gmail side uses). A new message on a closed conversation has no
 * closed stamp, so it reopens it, and no read stamp, so it is unread again.
 */

import { keptCalendar } from '../calendar-summary'
import { type ParsedArrival, SNIPPET_CHARS } from '../cloudflare/parse'
import type { MailForModel } from '../cloudflare/spam-check'
import { bySubject, outsiders, referenceOrder, subjectKey } from '../cloudflare/thread'
import type { ParsedAddress } from '../gmail/types'
import { isBulk } from '../queue'
import {
  CLOUDFLARE_ACTOR,
  type ClefFacts,
  type CloudflareMailboxStatus,
  type IdentityKind,
  type MailboxMark,
} from '../types'
import { classifyAddress } from './address'
import { belongsToMailbox } from './kinds'
import { Inbox, spamCallOf, text, textOrNull } from './store'

/** A Cloudflare mailbox row. Nothing in it is secret. */
export interface CloudflareMailboxRow {
  id: string
  address: string
  name: string
  createdAt: string
  lastArrivalAt: string | null
  lastError: string | null
  lastErrorAt: string | null
  /** Whether the spam check runs on it (the column keeps its first name), and who last switched that (null while the deploy config's declaration decides). */
  assistant: boolean
  assistantSetBy: string | null
  assistantSetAt: string | null
}

/** What the entrance knows about a message beyond its bytes. */
export interface ArrivalMeta {
  /** The object in the raw-mail bucket that holds the message as it came. */
  rawKey: string
  /** What makes a second delivery of it the same message: its Message-ID, or `hash:` and the hash of its bytes. */
  arrivalKey: string
  /** When the Worker received it (ISO). A retry from the kept copy files it under this and not under the retry's own time. */
  receivedAt: string
  /** Whether an address is ours (the mailbox's, or any on its domain): never a participant, never what threading compares. */
  isOurs: (address: string) => boolean
}

export type Filed =
  | { stored: true; conversationId: string; messageId: string; newConversation: boolean }
  | { stored: false }

/** A kept raw copy the inbox owes a filing. */
export interface OwedArrival {
  rawKey: string
  mailboxId: string
  envelopeFrom: string
  envelopeTo: string
  receivedAt: string
  attempts: number
}

/**
 * How many times a kept copy is tried before it is given up on: 30 seconds doubling to an hour, so about six hours in all.
 * Long enough for any outage of ours to end; short enough that a message that can never be filed (the parser cannot
 * read it, it names nobody) is not tried every hour for ever. Giving up keeps the raw copy and leaves the message counted as unfiled.
 */
export const MAX_ARRIVAL_ATTEMPTS = 12

/** One line, short: it is shown to the owner. */
const brief = (message: string): string => message.replace(/\s+/g, ' ').trim().slice(0, 300)

interface Person {
  kind: IdentityKind
  address: string
  name: string
}

function emails(list: ParsedAddress[]): Person[] {
  return list.flatMap((p) => {
    const c = classifyAddress(p.address)
    return c && c.kind === 'email' ? [{ kind: c.kind, address: c.address, name: p.name }] : []
  })
}

export class ArrivalStore extends Inbox {
  // ─── the mailbox ─────────────────────────────────────────────────────

  /**
   * The row of a declared Cloudflare mailbox, made the first time it is needed and kept after. Its name follows the
   * declaration (the deploy config is where it is set), and a change of name is audited.
   */
  cloudflareMailbox(declared: { address: string; name: string; assistant?: boolean }): CloudflareMailboxRow {
    return this.ports.transaction(() => {
      const found = this.sql
        .exec(`SELECT * FROM mailbox WHERE kind = 'cloudflare' AND address = ?1`, declared.address)
        .toArray()[0]
      if (!found) {
        const id = this.ports.newId()
        this.sql.exec(
          `INSERT INTO mailbox (id, kind, address, display_name, connected_at, connected_by, assistant)
           VALUES (?1, 'cloudflare', ?2, ?3, ?4, ?5, ?6)`,
          id,
          declared.address,
          declared.name,
          this.now(),
          CLOUDFLARE_ACTOR,
          declared.assistant === true ? 1 : 0,
        )
        this.seatMailbox(id, 'cloudflare', declared.address, null)
        this.audit(CLOUDFLARE_ACTOR, 'mailbox.create', `mailbox:${id}`, null, {
          kind: 'cloudflare',
          address: declared.address,
          name: declared.name,
          assistant: declared.assistant === true,
        })
        return this.cloudflareRowById(id) as CloudflareMailboxRow
      }
      const id = text(found.id)
      // Whether the assistant runs follows the declaration until a person has switched it; after that the switch decides.
      const declaredAssistant = declared.assistant === true ? 1 : 0
      if (found.assistant_set_by === null && Number(found.assistant) !== declaredAssistant) {
        this.sql.exec(`UPDATE mailbox SET assistant = ?2 WHERE id = ?1`, id, declaredAssistant)
        this.audit(
          CLOUDFLARE_ACTOR,
          'mailbox.assistant-declared',
          `mailbox:${id}`,
          { assistant: Number(found.assistant) === 1 },
          { assistant: declaredAssistant === 1 },
        )
      }
      if (text(found.display_name) !== declared.name) {
        this.sql.exec(`UPDATE mailbox SET display_name = ?2 WHERE id = ?1`, id, declared.name)
        this.audit(
          CLOUDFLARE_ACTOR,
          'mailbox.rename',
          `mailbox:${id}`,
          { name: text(found.display_name) },
          {
            name: declared.name,
          },
        )
      }
      return this.cloudflareRowById(id) as CloudflareMailboxRow
    })
  }

  /**
   * The mark every Cloudflare mailbox gives its conversations, oldest first: what the queue makes one view of each from.
   * One read and nothing counted, because the queue asks it on every request.
   */
  cloudflareMailboxMarks(): MailboxMark[] {
    return this.sql
      .exec(`SELECT id, display_name, address FROM mailbox WHERE kind = 'cloudflare' ORDER BY rowid`)
      .toArray()
      .map((r) => ({ id: text(r.id), name: text(r.display_name), address: text(r.address) }))
  }

  private cloudflareRowById(id: string): CloudflareMailboxRow | null {
    const r = this.sql.exec(`SELECT * FROM mailbox WHERE id = ?1 AND kind = 'cloudflare'`, id).toArray()[0]
    return r
      ? {
          id: text(r.id),
          address: text(r.address),
          name: text(r.display_name),
          createdAt: text(r.connected_at),
          lastArrivalAt: textOrNull(r.last_arrival_at),
          lastError: textOrNull(r.last_error),
          lastErrorAt: textOrNull(r.last_error_at),
          assistant: Number(r.assistant) === 1,
          assistantSetBy: textOrNull(r.assistant_set_by),
          assistantSetAt: textOrNull(r.assistant_set_at),
        }
      : null
  }

  /** Every Cloudflare mailbox, oldest first, as the script shows it. Counts come from the same facts as the queue's. */
  cloudflareMailboxes(): CloudflareMailboxStatus[] {
    return this.sql
      .exec(`SELECT id FROM mailbox WHERE kind = 'cloudflare' ORDER BY rowid`)
      .toArray()
      .map((r) => this.cloudflareStatus(text(r.id)))
  }

  private cloudflareStatus(id: string): CloudflareMailboxStatus {
    const row = this.cloudflareRowById(id) as CloudflareMailboxRow
    const count = (table: string) =>
      Number(this.sql.exec(`SELECT count(*) AS n FROM ${table} WHERE mailbox_id = ?1`, id).one().n)
    // The mailbox's own view: open and not Bulk, so these are the numbers its menu entry shows (Gmail's, by contrast, count
    // Bulk because Gmail's Inbox does; there is no Gmail here to compare with).
    const open = this.queueFacts(id).filter((f) => f.open && !isBulk(f))
    const unfiled = this.sql
      .exec(
        `SELECT count(*) FILTER (WHERE gave_up_at IS NULL) AS owed, count(*) FILTER (WHERE gave_up_at IS NOT NULL) AS gave_up
           FROM arrival_owed WHERE mailbox_id = ?1`,
        id,
      )
      .one()
    const judged = Number(
      this.sql.exec(`SELECT count(*) AS n FROM message WHERE mailbox_id = ?1 AND clef_junk IS NOT NULL`, id).one().n,
    )
    const owed = Number(unfiled.owed)
    const gaveUp = Number(unfiled.gave_up)
    const plural = (n: number) => (n === 1 ? 'message is' : 'messages are')
    return {
      id,
      kind: 'cloudflare',
      address: row.address,
      name: row.name,
      createdAt: row.createdAt,
      lastArrivalAt: row.lastArrivalAt,
      lastFilingError: row.lastError,
      lastFilingErrorAt: row.lastErrorAt,
      owed,
      gaveUp,
      assistant: {
        enabled: row.assistant,
        changedAt: row.assistantSetAt,
        changedBy: row.assistantSetBy,
        judged,
      },
      messages: count('message'),
      conversations: count('conversation'),
      open: open.length,
      unreadOpen: open.filter((f) => f.unread).length,
      health: {
        amber: owed + gaveUp > 0,
        reasons: [
          ...(owed > 0
            ? [
                `${owed} ${plural(owed)} kept safe but not filed in the inbox yet. The inbox files them again by itself.`,
              ]
            : []),
          ...(gaveUp > 0
            ? [
                `${gaveUp} ${plural(gaveUp)} kept safe but could not be filed after ${MAX_ARRIVAL_ATTEMPTS} tries, and the inbox has stopped trying. The raw copies are in the bucket.`,
              ]
            : []),
        ],
      },
    }
  }

  // ─── the spam check ──────────────────────────────────────────────────

  /**
   * Whether the spam classifier is asked about a message just filed, and if so what it is shown. Not asked (with the reason, for the log) when:
   * the mailbox's switch is off; the message is our own (the mailbox's address or its domain); a Client's contact is on the
   * conversation (a Client is never judged spam, so nothing of theirs goes to a
   * model); a person has already called the conversation (the owner or Claude moved it, which decides); or a rule already settles
   * it as Bulk (a List-Unsubscribe header, an automated sender: since a category nobody reads
   * is not worth a call). The rules read THIS message's own facts, not the conversation's newest.
   */
  spamCheckGate(messageId: string): { ask: true; mailbox: string; mail: MailForModel } | { ask: false; why: string } {
    const r = this.sql
      .exec(
        `SELECT m.conversation_id, m.identity_id, m.subject, m.body, m.from_header, m.to_header, m.list_unsubscribe, m.direction,
                i.address AS sender, mb.kind, mb.assistant, mb.address AS mailbox_address
           FROM message m
           JOIN identity i ON i.id = m.identity_id
           JOIN mailbox mb ON mb.id = m.mailbox_id
          WHERE m.id = ?1`,
        messageId,
      )
      .toArray()[0]
    const no = (why: string) => ({ ask: false as const, why })
    if (r?.kind !== 'cloudflare' || text(r.direction) !== 'in')
      return no('it is not a message that came into a Cloudflare mailbox')
    if (Number(r.assistant) !== 1) return no('the spam check is switched off on this mailbox')
    if (!this.ports.content.hasSpamQuestions(text(r.mailbox_address)))
      return no('no spam questions are written for this mailbox')
    const sender = this.cloudflareSenderOf(text(r.conversation_id))
    if (!sender || belongsToMailbox(sender, text(r.sender).toLowerCase())) return no('it is our own mail')
    const conversationId = text(r.conversation_id)
    if (this.bulkFacts(conversationId).clientIds.length > 0) return no('a Client’s contact is on the conversation')
    const called = this.sql.exec(`SELECT sort, sort_by FROM conversation WHERE id = ?1`, conversationId).toArray()[0]
    if (called && spamCallOf(textOrNull(called.sort), textOrNull(called.sort_by)) !== undefined) {
      return no('a person has called this conversation')
    }
    if (Number(r.list_unsubscribe) === 1) return no('it carries a List-Unsubscribe header')
    if (this.senderJudgments([text(r.identity_id)]).size > 0) return no('its sender is an automated one')
    return {
      ask: true,
      mailbox: text(r.mailbox_address),
      mail: { from: text(r.from_header), to: text(r.to_header), subject: text(r.subject), body: text(r.body) },
    }
  }

  /**
   * What the spam classifier said of a message, stored as three facts on it (migration 11). Written once and never changed: a second answer
   * for the same message (a retry of a filing that was already judged) writes nothing. Audited as Cloudflare's, like the filing.
   */
  recordJudgment(messageId: string, facts: ClefFacts): boolean {
    return this.ports.transaction(() => {
      const wrote =
        this.sql.exec(
          `UPDATE message SET clef_junk = ?2, clef_category = ?3, clef_model = ?4 WHERE id = ?1 AND clef_junk IS NULL`,
          messageId,
          facts.junk,
          facts.category,
          facts.model,
        ).rowsWritten > 0
      if (wrote) this.audit(CLOUDFLARE_ACTOR, 'message.clef', `message:${messageId}`, null, { ...facts })
      return wrote
    })
  }

  // ─── filing a message ────────────────────────────────────────────────

  /**
   * File one parsed message, in ONE transaction: the message, the conversation it joins or makes, the people on it, the
   * mailbox's last arrival, and (when it was owed) the debt, which goes in the same transaction so a crash cannot leave
   * a filed message still owed or an owed one forgotten. A message already held (the same arrival key) stores nothing,
   * and still clears its debt.
   */
  fileArrival(mailboxId: string, parsed: ParsedArrival, meta: ArrivalMeta): Filed {
    return this.ports.transaction(() => {
      this.sql.exec(`DELETE FROM arrival_owed WHERE raw_key = ?1`, meta.rawKey)
      // A filing worked, so the last filing error is only still true while something is left owed for this mailbox.
      this.sql.exec(
        `UPDATE mailbox SET last_error = NULL, last_error_at = NULL
          WHERE id = ?1 AND last_error IS NOT NULL AND NOT EXISTS (SELECT 1 FROM arrival_owed WHERE mailbox_id = ?1)`,
        mailboxId,
      )
      const held = this.sql
        .exec(`SELECT id FROM message WHERE mailbox_id = ?1 AND arrival_key = ?2`, mailboxId, meta.arrivalKey)
        .toArray()[0]
      if (held) return { stored: false }

      const own = meta.isOurs
      const from = emails(parsed.from ? [parsed.from] : [])
      const to = emails(parsed.to)
      const cc = emails(parsed.cc)
      const others = (list: Person[]) => list.filter((p) => !own(p.address))

      const key = subjectKey(parsed.subject)
      const outside = outsiders(
        [...from, ...to, ...cc].map((p) => p.address),
        own,
      )
      let conversationId = this.byReference(mailboxId, parsed) ?? this.bySubjectRule(mailboxId, key, outside, own)
      const newConversation = conversationId === null
      const at = this.now()
      if (conversationId === null) {
        conversationId = this.ports.newId()
        this.sql.exec(
          `INSERT INTO conversation (id, created_at, last_activity_at, mailbox_id, subject_key)
           VALUES (?1, ?2, ?3, ?4, ?5)`,
          conversationId,
          at,
          meta.receivedAt,
          mailboxId,
          key === '' ? null : key,
        )
      }

      const identity = (p: Person) => this.identityFor({ kind: p.kind, address: p.address }, p.name, CLOUDFLARE_ACTOR)
      // Who the message is FROM; with no outside sender, whoever it was written to; else the first address there is.
      const primary = from[0] ?? others(to)[0] ?? to[0] ?? cc[0]
      if (!primary) {
        // A message with no address anywhere on it has nobody to be filed under. Refused as a failure, so it stays
        // owed (visible, with its raw copy kept) and is not filed as a conversation with nobody on it.
        throw new Error('The message names no email address.')
      }
      const primaryIdentity = identity(primary)

      const participants: { who: Person; role: 'from' | 'to' | 'cc' }[] = [
        ...others(from).map((who) => ({ who, role: 'from' as const })),
        ...others(to).map((who) => ({ who, role: 'to' as const })),
        ...others(cc).map((who) => ({ who, role: 'cc' as const })),
      ]
      if (participants.length === 0) participants.push({ who: primary, role: 'from' })
      for (const { who, role } of participants) {
        this.sql.exec(
          `INSERT OR IGNORE INTO participant (conversation_id, identity_id, role) VALUES (?1, ?2, ?3)`,
          conversationId,
          identity(who).id,
          role,
        )
      }

      const messageId = this.ports.newId()
      const snippet = parsed.body.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS)
      this.sql.exec(
        `INSERT INTO message (id, conversation_id, identity_id, direction, status, subject, body, why,
                              created_at, created_by, updated_at, updated_by, sent_at, sent_by, source_ref,
                              mailbox_id, gmail_id, rfc_message_id, in_reply_to, from_header, to_header, cc_header,
                              sender_date, snippet, body_truncated, attachments, labels, list_unsubscribe,
                              read_at, read_by, closed_at, closed_by, reply_to_header, arrival_key, raw_key, event_key, event_kind, calendar)
         VALUES (?1, ?2, ?3, 'in', 'sent', ?4, ?5, '', ?6, ?7, ?6, ?7, ?8, ?7, NULL,
                 ?9, NULL, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, '[]', ?19,
                 NULL, NULL, NULL, NULL, ?20, ?21, ?22, ?23, ?24, ?25)`,
        messageId,
        conversationId,
        primaryIdentity.id,
        parsed.subject,
        parsed.body,
        at,
        CLOUDFLARE_ACTOR,
        meta.receivedAt,
        mailboxId,
        parsed.messageId,
        parsed.inReplyTo,
        parsed.fromHeader,
        parsed.toHeader,
        parsed.ccHeader,
        parsed.senderDate,
        snippet,
        parsed.bodyTruncated ? 1 : 0,
        JSON.stringify(parsed.attachments),
        parsed.listUnsubscribe ? 1 : 0,
        parsed.replyToHeader,
        meta.arrivalKey,
        meta.rawKey,
        parsed.event?.key ?? null,
        parsed.event?.kind ?? null,
        keptCalendar(parsed.calendar),
      )
      this.touchConversation(conversationId)
      this.sql.exec(
        `UPDATE mailbox SET last_arrival_at = CASE WHEN last_arrival_at IS NULL OR last_arrival_at < ?2 THEN ?2 ELSE last_arrival_at END
          WHERE id = ?1`,
        mailboxId,
        meta.receivedAt,
      )
      return { stored: true, conversationId, messageId, newConversation }
    })
  }

  /** Rule 1: a conversation holding a message this one names, the one answered first. */
  private byReference(mailboxId: string, parsed: ParsedArrival): string | null {
    for (const id of referenceOrder(parsed.messageId, parsed.inReplyTo, parsed.references)) {
      const hit = this.sql
        .exec(
          `SELECT conversation_id FROM message
            WHERE mailbox_id = ?1 AND rfc_message_id = ?2 AND conversation_id IS NOT NULL
            ORDER BY rowid LIMIT 1`,
          mailboxId,
          id,
        )
        .toArray()[0]
      if (hit) return text(hit.conversation_id)
    }
    return null
  }

  /** Rule 2: the same subject and an outside participant in common, the newest conversation first. */
  private bySubjectRule(
    mailboxId: string,
    key: string,
    outside: string[],
    own: (address: string) => boolean,
  ): string | null {
    if (key === '' || outside.length === 0) return null
    const candidates = this.sql
      .exec(
        `SELECT id FROM conversation WHERE mailbox_id = ?1 AND subject_key = ?2
          ORDER BY last_activity_at DESC, rowid DESC LIMIT 50`,
        mailboxId,
        key,
      )
      .toArray()
      .map((c) => ({
        id: text(c.id),
        outside: outsiders(
          this.sql
            .exec(
              `SELECT i.address FROM participant p JOIN identity i ON i.id = p.identity_id
                WHERE p.conversation_id = ?1 AND i.kind = 'email'`,
              text(c.id),
            )
            .toArray()
            .map((r) => text(r.address)),
          own,
        ),
      }))
    return bySubject(outside, candidates)
  }

  // ─── what is owed ────────────────────────────────────────────────────

  /**
   * A raw copy was kept and filing it failed: note it as owed, with the envelope and the arrival time the Worker saw, and
   * when to try again. A second failure of the same copy counts the attempt and moves the time. The mailbox says it, too
   * (its last filing error), so a quiet mailbox that is broken is not mistaken for a quiet one.
   */
  recordOwed(
    mailboxId: string,
    owed: { rawKey: string; envelopeFrom: string; envelopeTo: string; receivedAt: string },
    error: string,
    nextTryAt: string,
  ): { gaveUp: boolean } {
    return this.ports.transaction(() => {
      const at = this.now()
      this.sql.exec(
        `INSERT INTO arrival_owed (raw_key, mailbox_id, envelope_from, envelope_to, received_at, owed_at, attempts,
                                   next_try_at, last_error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8)
         ON CONFLICT(raw_key) DO UPDATE SET attempts = attempts + 1, next_try_at = excluded.next_try_at,
                                            last_error = excluded.last_error`,
        owed.rawKey,
        mailboxId,
        owed.envelopeFrom,
        owed.envelopeTo,
        owed.receivedAt,
        at,
        nextTryAt,
        brief(error),
      )
      this.sql.exec(`UPDATE mailbox SET last_error = ?2, last_error_at = ?3 WHERE id = ?1`, mailboxId, brief(error), at)
      // Given up on, once the bound is reached: the row and the raw copy stay, and nothing retries it.
      const gaveUp =
        this.sql.exec(
          `UPDATE arrival_owed SET gave_up_at = ?2 WHERE raw_key = ?1 AND attempts >= ?3 AND gave_up_at IS NULL`,
          owed.rawKey,
          at,
          MAX_ARRIVAL_ATTEMPTS,
        ).rowsWritten > 0
      if (gaveUp)
        console.error(`arrival: giving up on ${owed.rawKey} after ${MAX_ARRIVAL_ATTEMPTS} attempts: ${brief(error)}`)
      return { gaveUp }
    })
  }

  /** The kept copies whose time to try again has come, oldest first. */
  owedArrivals(dueBy: string): OwedArrival[] {
    return this.sql
      .exec(`SELECT * FROM arrival_owed WHERE gave_up_at IS NULL AND next_try_at <= ?1 ORDER BY owed_at, rowid`, dueBy)
      .toArray()
      .map((r) => ({
        rawKey: text(r.raw_key),
        mailboxId: text(r.mailbox_id),
        envelopeFrom: text(r.envelope_from),
        envelopeTo: text(r.envelope_to),
        receivedAt: text(r.received_at),
        attempts: Number(r.attempts),
      }))
  }

  /** When the next owed copy is due, or null when nothing is owed: what the alarm is set for. */
  nextOwedAt(): string | null {
    return textOrNull(this.sql.exec(`SELECT min(next_try_at) AS t FROM arrival_owed WHERE gave_up_at IS NULL`).one().t)
  }
}
