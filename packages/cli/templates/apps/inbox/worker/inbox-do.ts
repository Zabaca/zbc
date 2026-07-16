import { DurableObject } from 'cloudflare:workers'

/**
 * Inbox — a single SQLite-backed Durable Object holding message metadata and
 * parsed bodies. Raw MIME lives in R2 (DO SQLite caps a value at ~2 MB while
 * a message can be 5 MiB); `r2_key` points at it.
 *
 * One DO instance for the whole inbox (idFromName('inbox')) — transactional
 * ordering beats sharding at this scale.
 */

export interface MessageMeta {
  id: string
  from_addr: string
  to_addr: string
  subject: string
  date: string
  snippet: string
  size: number
  created_at: string
  direction: 'inbound' | 'outbound'
  thread_id: string
}

export interface ThreadMeta extends MessageMeta {
  thread_count: number
}

export interface MessageFull extends MessageMeta {
  message_id: string
  in_reply_to: string
  text_body: string
  html_body: string
  r2_key: string
  attachments: Array<{ filename: string; mimeType: string; size: number }>
}

export interface InsertMessage {
  id: string
  message_id: string
  from_addr: string
  to_addr: string
  subject: string
  date: string
  snippet: string
  text_body: string
  html_body: string
  r2_key: string
  attachments_json: string
  size: number
  direction: 'inbound' | 'outbound'
  in_reply_to: string
}

/** Strip Re:/Fwd: prefixes + whitespace so replies fall into the same thread. */
function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(\s*(re|fwd?|fw)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export class Inbox extends DurableObject {
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never)
    this.sql = ctx.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        from_addr TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        subject TEXT,
        date TEXT,
        snippet TEXT,
        text_body TEXT,
        html_body TEXT,
        r2_key TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        size INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at DESC, id DESC);
    `)
    // Additive migration for pre-threading deployments (v1 rows had no
    // direction/thread columns). ALTER TABLE has no IF NOT EXISTS.
    const cols = this.sql
      .exec(`SELECT name FROM pragma_table_info('messages')`)
      .toArray() as unknown as Array<{ name: string }>
    const names = new Set(cols.map((c) => c.name))
    if (!names.has('direction')) {
      this.sql.exec(`ALTER TABLE messages ADD COLUMN direction TEXT NOT NULL DEFAULT 'inbound'`)
    }
    if (!names.has('in_reply_to')) {
      this.sql.exec(`ALTER TABLE messages ADD COLUMN in_reply_to TEXT NOT NULL DEFAULT ''`)
    }
    if (!names.has('thread_id')) {
      this.sql.exec(`ALTER TABLE messages ADD COLUMN thread_id TEXT NOT NULL DEFAULT ''`)
      // Backfill: pre-existing rows each become their own thread, and their
      // message_ids get normalized to the bare (bracketless) form the worker
      // now stores.
      this.sql.exec(
        `UPDATE messages SET message_id = replace(replace(trim(message_id), '<', ''), '>', '')`,
      )
      this.sql.exec(`UPDATE messages SET thread_id = id WHERE thread_id = ''`)
    }
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id, id)`)
  }

  /**
   * Thread resolution, most-reliable first:
   * 1. in_reply_to matches a stored message's RFC Message-ID → that thread.
   * 2. Normalized subject matches an existing thread that shares a
   *    participant address (covers providers that rewrite Message-IDs).
   * 3. New thread rooted at this row's id.
   */
  private resolveThreadId(
    rowId: string,
    inReplyTo: string,
    subject: string,
    fromAddr: string,
    toAddr: string,
  ): string {
    if (inReplyTo) {
      const byRef = this.sql
        .exec(`SELECT thread_id FROM messages WHERE message_id = ? LIMIT 1`, inReplyTo)
        .toArray()[0] as unknown as { thread_id: string } | undefined
      if (byRef?.thread_id) return byRef.thread_id
    }
    const norm = normalizeSubject(subject)
    if (norm) {
      const participants = [fromAddr, toAddr].map((a) => a.toLowerCase())
      const rows = this.sql
        .exec(
          `SELECT thread_id, subject, from_addr, to_addr FROM messages ORDER BY id DESC LIMIT 200`,
        )
        .toArray() as unknown as Array<{
        thread_id: string
        subject: string
        from_addr: string
        to_addr: string
      }>
      const match = rows.find(
        (r) =>
          normalizeSubject(r.subject ?? '') === norm &&
          [r.from_addr, r.to_addr].some((a) => participants.includes((a ?? '').toLowerCase())),
      )
      if (match) return match.thread_id
    }
    return rowId
  }

  insert(msg: InsertMessage): { threadId: string } {
    const threadId = this.resolveThreadId(
      msg.id,
      msg.in_reply_to,
      msg.subject,
      msg.from_addr,
      msg.to_addr,
    )
    this.sql.exec(
      `INSERT INTO messages
         (id, message_id, from_addr, to_addr, subject, date, snippet,
          text_body, html_body, r2_key, attachments_json, size, created_at,
          direction, in_reply_to, thread_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      msg.id,
      msg.message_id,
      msg.from_addr,
      msg.to_addr,
      msg.subject,
      msg.date,
      msg.snippet,
      msg.text_body,
      msg.html_body,
      msg.r2_key,
      msg.attachments_json,
      msg.size,
      new Date().toISOString(),
      msg.direction,
      msg.in_reply_to,
      threadId,
    )
    return { threadId }
  }

  /** Newest-first page. `cursor` is the last-seen id (ids are time-ordered). */
  list(limit = 50, cursor?: string): { messages: MessageMeta[]; nextCursor: string | null } {
    const capped = Math.min(Math.max(limit, 1), 200)
    const rows = (cursor
      ? this.sql
          .exec(
            `SELECT id, from_addr, to_addr, subject, date, snippet, size, created_at, direction, thread_id
               FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?`,
            cursor,
            capped + 1,
          )
          .toArray()
      : this.sql
          .exec(
            `SELECT id, from_addr, to_addr, subject, date, snippet, size, created_at, direction, thread_id
               FROM messages ORDER BY id DESC LIMIT ?`,
            capped + 1,
          )
          .toArray()) as unknown as MessageMeta[]
    const hasMore = rows.length > capped
    const page = hasMore ? rows.slice(0, capped) : rows
    return { messages: page, nextCursor: hasMore ? page[page.length - 1]!.id : null }
  }

  /**
   * Newest-first page of THREADS: the latest message of each thread plus a
   * count. `cursor` is the last-seen latest-message id.
   */
  listThreads(limit = 50, cursor?: string): { threads: ThreadMeta[]; nextCursor: string | null } {
    const capped = Math.min(Math.max(limit, 1), 200)
    const base = `
      SELECT m.id, m.from_addr, m.to_addr, m.subject, m.date, m.snippet, m.size,
             m.created_at, m.direction, m.thread_id,
             (SELECT COUNT(*) FROM messages c WHERE c.thread_id = m.thread_id) AS thread_count
        FROM messages m
       WHERE m.id = (SELECT MAX(id) FROM messages x WHERE x.thread_id = m.thread_id)`
    const rows = (cursor
      ? this.sql
          .exec(`${base} AND m.id < ? ORDER BY m.id DESC LIMIT ?`, cursor, capped + 1)
          .toArray()
      : this.sql
          .exec(`${base} ORDER BY m.id DESC LIMIT ?`, capped + 1)
          .toArray()) as unknown as ThreadMeta[]
    const hasMore = rows.length > capped
    const page = hasMore ? rows.slice(0, capped) : rows
    return { threads: page, nextCursor: hasMore ? page[page.length - 1]!.id : null }
  }

  /** Every message in a thread, oldest-first, with full bodies. */
  getThread(threadId: string): MessageFull[] {
    const rows = this.sql
      .exec(
        `SELECT id, message_id, from_addr, to_addr, subject, date, snippet,
                text_body, html_body, r2_key, attachments_json, size, created_at,
                direction, in_reply_to, thread_id
           FROM messages WHERE thread_id = ? ORDER BY id ASC`,
        threadId,
      )
      .toArray() as unknown as Array<MessageFull & { attachments_json: string }>
    return rows.map(({ attachments_json, ...rest }) => ({
      ...rest,
      attachments: JSON.parse(attachments_json || '[]'),
    }))
  }

  get(id: string): MessageFull | null {
    const row = this.sql
      .exec(
        `SELECT id, message_id, from_addr, to_addr, subject, date, snippet,
                text_body, html_body, r2_key, attachments_json, size, created_at,
                direction, in_reply_to, thread_id
         FROM messages WHERE id = ?`,
        id,
      )
      .toArray()[0] as unknown as (MessageFull & { attachments_json: string }) | undefined
    if (!row) return null
    const { attachments_json, ...rest } = row
    return { ...rest, attachments: JSON.parse(attachments_json || '[]') }
  }

  /** Deletes the row; returns the r2_key so the caller can delete the raw blob. */
  delete(id: string): string | null {
    const row = this.sql.exec(`SELECT r2_key FROM messages WHERE id = ?`, id).toArray()[0] as
      | { r2_key: string }
      | undefined
    if (!row) return null
    this.sql.exec(`DELETE FROM messages WHERE id = ?`, id)
    return row.r2_key
  }
}
