/**
 * The store's JMAP half: the mailbox rows of the install's own mail server, their cursor, their resumable jobs, their push subscription, and a page of what the server said becoming rows. It sits beside `MailStore`'s
 * Gmail half (`JmapStore extends MailStore`, and `AssistStore extends JmapStore`) because a JMAP message becomes a row by the very path a Gmail one does: the JMAP module (src/jmap/) turns a message's server
 * state into the label words the store derives read and closed from, and hands over the same parsed message (`MailStore.ingest`, whose ids and whose "who is ours" come from the mailbox's kind, src/store/kinds.ts).
 * Everything here is synchronous SQL over the same ports as the rest, so every rule runs under plain `bun` against a real SQLite; the network is src/jmap/room.ts, which calls these in short transactions between
 * its awaits.
 *
 * ── WHAT A ROW USES (migration 18) ───────────────────────────────────────
 * `address` and `display_name` (the pill) are the declaration's; `history_id` holds the server's Email and Mailbox state strings as JSON, the cursor, written in the SAME transaction as the page it follows; `job`
 * is a fill or a resync; `push_seq`/`synced_seq`, `last_push_at`, `last_sync_at`, `last_error`, `last_error_at`, `retry_count` and `last_resync_at` mean what they mean for Gmail; `grant_lapsed_at` is when the server
 * refused the space's credential. No token: the credential is a secret of the Worker, never a row. The push subscription is a `setting` row, `jmap-push:<mailbox id>`, so the mailbox table gains no column.
 *
 * ── A REFUSED CREDENTIAL IS A STATE ──────────────────────────────────────
 * Marked once (audited), with a fingerprint of the credential that was refused (a hash, never the credential): nothing syncs, renews or sends for that mailbox, and nothing retries, so the server is not hammered
 * and no failed-sign-in ban is invited. A deploy that CHANGES the credential changes the fingerprint, and the next run clears the state and tries again.
 *
 * ── NOTHING IS DELETED ───────────────────────────────────────────────────
 * A message the server destroys is kept and counted as trashed (the labels become TRASH), as a message Gmail put in the trash is. A mailbox taken out of the declaration keeps its row and its mail.
 */

import type { ParsedMessage } from '../gmail/types'
import { DESTROYED_LABELS } from '../jmap/mapping'
import type { JmapCursor } from '../jmap/types'
import { JMAP_ACTOR } from '../types'
import { MailStore, type StoredMessage } from './mail'
import { text, textOrNull } from './store'

/** Work too long for one Worker invocation, kept in the mailbox row so the next alarm picks it up: a fill and a resync are the same walk (list a window of mail, store it), and a resync then reads the open conversations again. */
export interface JmapJob {
  kind: 'fill' | 'resync'
  stage: 'list' | 'labels'
  /** ISO: the window of Inbox and Sent mail starts here. */
  after: string
  /** How far into the window's list (oldest first) the walk has got. */
  position: number
  /** The states read BEFORE the window was listed: they become the cursor when the job completes, and a sync is owed, so nothing that changed during the walk is missed. */
  cursorAfter: JmapCursor
  /** The label stage's message ids still to be read again; null until that stage begins. */
  rereads: string[] | null
}

export interface JmapRow {
  id: string
  address: string
  /** The pill its conversations carry. */
  name: string
  cursor: JmapCursor | null
  job: JmapJob | null
  connectedAt: string
  lastPushAt: string | null
  lastSyncAt: string | null
  lastError: string | null
  lastErrorAt: string | null
  lastResyncAt: string | null
  retryCount: number
  pushSeq: number
  syncedSeq: number
  /** When the server refused the space's credential; null while it works. */
  refusedAt: string | null
}

/** The push subscription the inbox holds on the server for a mailbox, as the `jmap-push:<mailbox id>` setting row keeps it. */
export interface JmapPushState {
  /** The server's id of the subscription; empty while the call that makes it is still on its way (the server may call the push address before it has answered that call). */
  id: string
  /** Random, in the address the server is told to call; a push is accepted only on the path that carries it. */
  token: string
  /** The server's verification code, once it has called with it and until the inbox has completed the subscription with it. */
  code: string | null
  /** Whether the inbox completed the verification. Until then the server sends nothing. */
  verified: boolean
  /** ISO. */
  expires: string | null
  madeAt: string
  /** A verification that came while `id` was still empty: the subscription it names and its code, matched with the id the server answers with. */
  early: { id: string; code: string } | null
}

const PUSH_PREFIX = 'jmap-push:'
const REFUSED_PREFIX = 'jmap-refused:'

function parseCursor(v: unknown): JmapCursor | null {
  if (typeof v !== 'string') return null
  try {
    const c = JSON.parse(v) as Partial<JmapCursor>
    return typeof c.email === 'string' && typeof c.mailbox === 'string' ? { email: c.email, mailbox: c.mailbox } : null
  } catch {
    return null
  }
}

function parseJob(v: unknown): JmapJob | null {
  if (typeof v !== 'string') return null
  try {
    const job = JSON.parse(v) as JmapJob
    return job &&
      typeof job === 'object' &&
      (job.kind === 'fill' || job.kind === 'resync') &&
      parseCursor(JSON.stringify(job.cursorAfter))
      ? job
      : null
  } catch {
    return null
  }
}

function jmapFrom(r: Record<string, unknown>): JmapRow {
  return {
    id: text(r.id),
    address: text(r.address),
    name: text(r.display_name) || text(r.address),
    cursor: parseCursor(r.history_id),
    job: parseJob(r.job),
    connectedAt: text(r.connected_at),
    lastPushAt: textOrNull(r.last_push_at),
    lastSyncAt: textOrNull(r.last_sync_at),
    lastError: textOrNull(r.last_error),
    lastErrorAt: textOrNull(r.last_error_at),
    lastResyncAt: textOrNull(r.last_resync_at),
    retryCount: Number(r.retry_count),
    pushSeq: Number(r.push_seq),
    syncedSeq: Number(r.synced_seq),
    refusedAt: textOrNull(r.grant_lapsed_at),
  }
}

const brief = (message: string): string => message.replace(/\s+/g, ' ').trim().slice(0, 300)

/** What a page of the server's changes carries into the store. Ids are the server's. */
export interface JmapPage {
  mailboxId: string
  /** Messages new to the inbox, parsed. */
  messages: ParsedMessage[]
  /** Messages already held, with the labels the server's state of them maps to now. */
  labels: { id: string; labels: string[] }[]
  /** Messages the server destroyed. */
  destroyed: string[]
}

export class JmapStore extends MailStore {
  // ─── the rows ────────────────────────────────────────────────────────

  /** Every JMAP mailbox the store holds, oldest first (the declared ones, and any taken out of the declaration since). */
  jmapRows(): JmapRow[] {
    return this.sql.exec(`SELECT * FROM mailbox WHERE kind = 'jmap' ORDER BY rowid`).toArray().map(jmapFrom)
  }

  jmapRow(id: string): JmapRow | null {
    const r = this.sql.exec(`SELECT * FROM mailbox WHERE kind = 'jmap' AND id = ?1`, id).toArray()[0]
    return r ? jmapFrom(r) : null
  }

  jmapRowAt(address: string): JmapRow | null {
    const r = this.sql
      .exec(`SELECT * FROM mailbox WHERE kind = 'jmap' AND address = ?1`, address.trim().toLowerCase())
      .toArray()[0]
    return r ? jmapFrom(r) : null
  }

  /** The JMAP mailbox a conversation is in, or null (any other kind, or a manual conversation). */
  jmapRowOfConversation(conversationId: string): JmapRow | null {
    const r = this.sql
      .exec(
        `SELECT mb.* FROM conversation c JOIN mailbox mb ON mb.id = c.mailbox_id WHERE c.id = ?1 AND mb.kind = 'jmap'`,
        conversationId,
      )
      .toArray()[0]
    return r ? jmapFrom(r) : null
  }

  /**
   * Make the rows the deploy declares: a mailbox declared for the first time gets its row (the first alarm after the deploy starts its fill), and one declared under a new name is renamed. A row whose mailbox
   * is no longer declared is left exactly as it is. Answers every row, declared or not.
   */
  declareJmap(declared: readonly { address: string; name: string }[]): JmapRow[] {
    return this.ports.transaction(() => {
      for (const d of declared) {
        const address = d.address.trim().toLowerCase()
        const held = this.sql
          .exec(`SELECT id, display_name FROM mailbox WHERE kind = 'jmap' AND address = ?1`, address)
          .toArray()[0]
        if (!held) {
          const id = this.ports.newId()
          this.sql.exec(
            `INSERT INTO mailbox (id, kind, address, display_name, connected_at, connected_by) VALUES (?1, 'jmap', ?2, ?3, ?4, ?5)`,
            id,
            address,
            d.name,
            this.now(),
            JMAP_ACTOR,
          )
          this.seatMailbox(id, 'jmap', address, null)
          this.audit(JMAP_ACTOR, 'mailbox.declare', `mailbox:${id}`, null, { address, name: d.name })
        } else if (text(held.display_name) !== d.name) {
          this.sql.exec(`UPDATE mailbox SET display_name = ?2 WHERE id = ?1`, text(held.id), d.name)
          this.audit(
            JMAP_ACTOR,
            'mailbox.rename',
            `mailbox:${text(held.id)}`,
            { name: text(held.display_name) },
            { name: d.name },
          )
        }
      }
      return this.jmapRows()
    })
  }

  /** How many messages, conversations, open and unread-open conversations a mailbox holds, by the queue's own rules (the same as a Gmail account's header). */
  jmapCounts(id: string): { messages: number; conversations: number; open: number; unreadOpen: number } {
    const count = (table: string) =>
      Number(this.sql.exec(`SELECT count(*) AS n FROM ${table} WHERE mailbox_id = ?1`, id).one().n)
    const open = this.queueFacts(id).filter((f) => f.open)
    return {
      messages: count('message'),
      conversations: count('conversation'),
      open: open.length,
      unreadOpen: open.filter((f) => f.unread).length,
    }
  }

  // ─── what is owed ────────────────────────────────────────────────────

  /** A push arrived for this mailbox: remember when, and that changes are owed. Not for a mailbox the server refused. */
  recordJmapPush(id: string): void {
    this.sql.exec(
      `UPDATE mailbox SET last_push_at = ?2, push_seq = push_seq + 1 WHERE id = ?1 AND kind = 'jmap' AND grant_lapsed_at IS NULL`,
      id,
      this.now(),
    )
  }

  /** Someone asked for a sync (of one mailbox, or of every one with none named): changes are owed, and it is not a push. */
  markJmapSyncOwed(id?: string): void {
    this.sql.exec(
      `UPDATE mailbox SET push_seq = push_seq + 1, retry_count = 0
        WHERE kind = 'jmap' AND grant_lapsed_at IS NULL AND (?1 IS NULL OR id = ?1)`,
      id ?? null,
    )
  }

  /** A successful step. `syncedSeq` is recorded only when the sync COMPLETED, so a budget-limited run leaves the rest owed. */
  recordJmapSuccess(id: string, syncedSeq: number | null): void {
    this.sql.exec(
      `UPDATE mailbox SET last_sync_at = ?2, retry_count = 0, last_error = NULL, last_error_at = NULL,
              synced_seq = CASE WHEN ?3 IS NULL THEN synced_seq ELSE max(synced_seq, ?3) END
        WHERE id = ?1`,
      id,
      this.now(),
      syncedSeq,
    )
  }

  /** A failed step. Answers the new retry count, which the caller turns into a backoff. The time stays the one trouble BEGAN at (the card says "not answering since"): only a success clears it. */
  recordJmapFailure(id: string, message: string): number {
    this.sql.exec(
      `UPDATE mailbox SET last_error = ?2, last_error_at = CASE WHEN last_error IS NULL OR last_error_at IS NULL THEN ?3 ELSE last_error_at END,
            retry_count = retry_count + 1 WHERE id = ?1`,
      id,
      brief(message),
      this.now(),
    )
    return Number(this.sql.exec(`SELECT retry_count AS n FROM mailbox WHERE id = ?1`, id).one().n)
  }

  /**
   * The server refused the space's credential. Stamped once (the first finding stands until the credential changes), audited, with a fingerprint of what was refused; the work it was doing is dropped.
   * Nothing retries: a deploy that changes the credential is what ends it (`clearJmapRefusalIfChanged`).
   */
  markJmapRefused(id: string, fingerprint: string, message: string): void {
    this.ports.transaction(() => {
      const row = this.jmapRow(id)
      if (!row) return
      this.sql.exec(
        `UPDATE mailbox SET grant_lapsed_at = coalesce(grant_lapsed_at, ?2), last_error = ?3, last_error_at = ?2, retry_count = 0, synced_seq = push_seq WHERE id = ?1`,
        id,
        this.now(),
        brief(message),
      )
      this.setting(`${REFUSED_PREFIX}${id}`, fingerprint)
      if (row.refusedAt === null)
        this.audit(JMAP_ACTOR, 'mailbox.refused', `mailbox:${id}`, null, { address: row.address })
    })
  }

  /** The refusal ends when the credential in use is not the one that was refused (a deploy changed it). Answers whether it ended. */
  clearJmapRefusalIfChanged(id: string, fingerprint: string): boolean {
    return this.ports.transaction(() => {
      const row = this.jmapRow(id)
      if (!row || row.refusedAt === null) return false
      if (this.settingValue(`${REFUSED_PREFIX}${id}`) === fingerprint) return false
      this.sql.exec(
        `UPDATE mailbox SET grant_lapsed_at = NULL, last_error = NULL, last_error_at = NULL, retry_count = 0, push_seq = push_seq + 1 WHERE id = ?1`,
        id,
      )
      this.sql.exec(`DELETE FROM setting WHERE key = ?1`, `${REFUSED_PREFIX}${id}`)
      this.audit(JMAP_ACTOR, 'mailbox.accepted-again', `mailbox:${id}`, null, { address: row.address })
      return true
    })
  }

  /** Begin a fill (a mailbox with no cursor and no job) or a resync (the cursor went stale). The cursor itself is left alone until the job completes. */
  startJmapJob(id: string, job: JmapJob, reason?: string): void {
    this.ports.transaction(() => {
      this.sql.exec(`UPDATE mailbox SET job = ?2 WHERE id = ?1`, id, JSON.stringify(job))
      if (job.kind === 'resync')
        this.audit(JMAP_ACTOR, 'mailbox.resync-start', `mailbox:${id}`, null, {
          reason: reason ?? '',
          after: job.after,
        })
    })
  }

  // ─── what is held ────────────────────────────────────────────────────

  /** Which of these server ids the mailbox holds. */
  knownJmapIds(mailboxId: string, ids: string[]): Set<string> {
    return this.knownGmailIds(mailboxId, ids)
  }

  /** Whether the mailbox already holds a conversation for this server thread: a message of an archived thread belongs in the store only if its thread is held (or has mail in the Inbox or Sent). */
  jmapThreadHeld(mailboxId: string, threadId: string): boolean {
    return (
      this.sql
        .exec(`SELECT 1 FROM conversation WHERE mailbox_id = ?1 AND jmap_thread_id = ?2`, mailboxId, threadId)
        .toArray()[0] !== undefined
    )
  }

  /** The ids of every message the mailbox holds in a conversation that has any message in the Inbox: what a resync reads again. */
  openJmapMessageIds(mailboxId: string): string[] {
    return this.sql
      .exec(
        `SELECT m.jmap_id AS id FROM message m
          WHERE m.mailbox_id = ?1 AND m.jmap_id IS NOT NULL
            AND m.conversation_id IN (SELECT DISTINCT m2.conversation_id FROM message m2, json_each(m2.labels) l
                                       WHERE m2.mailbox_id = ?1 AND l.value = 'INBOX')
          ORDER BY m.rowid`,
        mailboxId,
      )
      .toArray()
      .map((r) => text(r.id))
  }

  /** The newest message held, by the server's own time. A resync starts a day before it. */
  newestJmapAt(mailboxId: string): string | null {
    return textOrNull(
      this.sql
        .exec(`SELECT max(sent_at) AS t FROM message WHERE mailbox_id = ?1 AND jmap_id IS NOT NULL`, mailboxId)
        .one().t,
    )
  }

  // ─── applying what the server said ───────────────────────────────────

  /**
   * One page of the server's changes, applied in ONE transaction: the messages fetched for it, the state changes of messages already held, the ones the server destroyed (kept, and counted as trashed), and the
   * cursor. The cursor moves only here, so it cannot move past a page that was not stored. `notify` says whether each message stored for the first time is put to the notification rule (the sync: true; the
   * thread read before a Close or a send while the owner is looking: false).
   */
  applyJmapPage(input: JmapPage & { cursor: JmapCursor | null; notify: boolean }): {
    stored: number
    owed: number
    labelsChanged: number
  } {
    return this.ports.transaction(() => {
      const fresh: StoredMessage[] = []
      const counts = this.ingest(input.mailboxId, input.messages, fresh)
      const labelsChanged = this.applyServerState(input)
      if (input.cursor !== null)
        this.sql.exec(`UPDATE mailbox SET history_id = ?2 WHERE id = ?1`, input.mailboxId, JSON.stringify(input.cursor))
      return { stored: counts.stored, owed: input.notify ? this.markOwed(fresh) : 0, labelsChanged }
    })
  }

  private applyServerState(input: JmapPage): number {
    let changed = 0
    for (const l of input.labels) {
      const row = this.sql
        .exec(`SELECT id FROM message WHERE mailbox_id = ?1 AND jmap_id = ?2`, input.mailboxId, l.id)
        .toArray()[0]
      if (row && this.writeLabels(text(row.id), l.labels, JMAP_ACTOR)) changed += 1
    }
    for (const id of input.destroyed) {
      const row = this.sql
        .exec(`SELECT id FROM message WHERE mailbox_id = ?1 AND jmap_id = ?2`, input.mailboxId, id)
        .toArray()[0]
      if (row && this.writeLabels(text(row.id), DESTROYED_LABELS, JMAP_ACTOR)) changed += 1
    }
    return changed
  }

  /**
   * One step of a fill or a resync, in one transaction: store what was listed, set the state of what was held, and either save the job's progress or, when `job` is null, complete it: the cursor becomes the
   * states read before the job began, and a sync is owed to pick up whatever changed meanwhile.
   */
  applyJmapJobStep(input: JmapPage & { kind: JmapJob['kind']; cursorAfter: JmapCursor; job: JmapJob | null }): {
    stored: number
  } {
    return this.ports.transaction(() => {
      const counts = this.ingest(input.mailboxId, input.messages)
      this.applyServerState(input)
      if (input.job) {
        this.sql.exec(`UPDATE mailbox SET job = ?2 WHERE id = ?1`, input.mailboxId, JSON.stringify(input.job))
        return { stored: counts.stored }
      }
      this.sql.exec(
        `UPDATE mailbox SET job = NULL, history_id = ?2, push_seq = push_seq + 1,
                last_resync_at = CASE WHEN ?3 = 'resync' THEN ?4 ELSE last_resync_at END
          WHERE id = ?1`,
        input.mailboxId,
        JSON.stringify(input.cursorAfter),
        input.kind,
        this.now(),
      )
      this.audit(
        JMAP_ACTOR,
        input.kind === 'fill' ? 'mailbox.fill-complete' : 'mailbox.resync-complete',
        `mailbox:${input.mailboxId}`,
        null,
        { cursor: input.cursorAfter },
      )
      return { stored: counts.stored }
    })
  }

  // ─── the push subscription ───────────────────────────────────────────

  jmapPushState(id: string): JmapPushState | null {
    const raw = this.settingValue(`${PUSH_PREFIX}${id}`)
    if (raw === null) return null
    try {
      const s = JSON.parse(raw) as Partial<JmapPushState>
      return typeof s.id === 'string' && typeof s.token === 'string'
        ? {
            id: s.id,
            token: s.token,
            code: typeof s.code === 'string' ? s.code : null,
            verified: s.verified === true,
            expires: typeof s.expires === 'string' ? s.expires : null,
            madeAt: typeof s.madeAt === 'string' ? s.madeAt : '',
            early:
              s.early && typeof s.early.id === 'string' && typeof s.early.code === 'string'
                ? { id: s.early.id, code: s.early.code }
                : null,
          }
        : null
    } catch {
      return null
    }
  }

  /** Remember the subscription (or, with null, forget it). Not audited: it is the inbox's own plumbing, and the token is a secret. */
  setJmapPushState(id: string, state: JmapPushState | null): void {
    if (state === null) this.sql.exec(`DELETE FROM setting WHERE key = ?1`, `${PUSH_PREFIX}${id}`)
    else this.setting(`${PUSH_PREFIX}${id}`, JSON.stringify(state))
  }

  /** Whether `token` is the one kept for this mailbox's subscription. Compared in constant time over equal-length text; an unknown mailbox or none kept is false. */
  jmapPushTokenMatches(id: string, token: string): boolean {
    const state = this.jmapPushState(id)
    if (!state) return false
    const a = new TextEncoder().encode(state.token)
    const b = new TextEncoder().encode(token)
    let diff = a.length ^ b.length
    for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
    return diff === 0
  }

  /**
   * The server called with its verification code: kept for the alarm to complete the subscription with. Only for the subscription the inbox made (its id). While the call that makes it is still on its way the id
   * is not known yet, and the server was measured calling within a tenth of a second of making a subscription, before it answers: the code is then kept with the id it names, for the answer to be matched against.
   */
  noteJmapVerification(id: string, subscriptionId: string, code: string): boolean {
    const state = this.jmapPushState(id)
    if (!state || state.verified) return false
    if (state.id === '') {
      this.setJmapPushState(id, { ...state, early: { id: subscriptionId, code } })
      return true
    }
    if (state.id !== subscriptionId) return false
    this.setJmapPushState(id, { ...state, code })
    return true
  }

  // ─── settings, for this half alone ───────────────────────────────────

  private settingValue(key: string): string | null {
    return textOrNull(this.sql.exec(`SELECT value FROM setting WHERE key = ?1`, key).toArray()[0]?.value)
  }

  private setting(key: string, value: string): void {
    this.sql.exec(
      `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      key,
      value,
      this.now(),
      JMAP_ACTOR,
    )
  }
}
