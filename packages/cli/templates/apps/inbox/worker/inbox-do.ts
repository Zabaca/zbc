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
}

export interface MessageFull extends MessageMeta {
  message_id: string
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
  }

  insert(msg: InsertMessage): void {
    this.sql.exec(
      `INSERT INTO messages
         (id, message_id, from_addr, to_addr, subject, date, snippet,
          text_body, html_body, r2_key, attachments_json, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    )
  }

  /** Newest-first page. `cursor` is the last-seen id (ids are time-ordered). */
  list(limit = 50, cursor?: string): { messages: MessageMeta[]; nextCursor: string | null } {
    const capped = Math.min(Math.max(limit, 1), 200)
    const rows = (cursor
      ? this.sql
          .exec(
            `SELECT id, from_addr, to_addr, subject, date, snippet, size, created_at
               FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?`,
            cursor,
            capped + 1,
          )
          .toArray()
      : this.sql
          .exec(
            `SELECT id, from_addr, to_addr, subject, date, snippet, size, created_at
               FROM messages ORDER BY id DESC LIMIT ?`,
            capped + 1,
          )
          .toArray()) as unknown as MessageMeta[]
    const hasMore = rows.length > capped
    const page = hasMore ? rows.slice(0, capped) : rows
    return { messages: page, nextCursor: hasMore ? page[page.length - 1]!.id : null }
  }

  get(id: string): MessageFull | null {
    const row = this.sql
      .exec(
        `SELECT id, message_id, from_addr, to_addr, subject, date, snippet,
                text_body, html_body, r2_key, attachments_json, size, created_at
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
