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
  /** 'sent' for everything except unsent drafts. */
  status: 'draft' | 'sent'
  /** Classifier label ('' until/unless labeling runs). */
  label: string
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
  /** 'draft' skips thread resolution (resolved at send time). Default 'sent'. */
  status?: 'draft' | 'sent'
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
    if (!names.has('status')) {
      this.sql.exec(`ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'sent'`)
    }
    if (!names.has('label')) {
      this.sql.exec(`ALTER TABLE messages ADD COLUMN label TEXT NOT NULL DEFAULT ''`)
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
        .exec(
          `SELECT thread_id FROM messages WHERE message_id = ? AND status != 'draft' LIMIT 1`,
          inReplyTo,
        )
        .toArray()[0] as unknown as { thread_id: string } | undefined
      if (byRef?.thread_id) return byRef.thread_id
    }
    const norm = normalizeSubject(subject)
    if (norm) {
      const participants = [fromAddr, toAddr].map((a) => a.toLowerCase())
      const rows = this.sql
        .exec(
          `SELECT thread_id, subject, from_addr, to_addr FROM messages WHERE status != 'draft' ORDER BY id DESC LIMIT 200`,
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
    const status = msg.status ?? 'sent'
    // Drafts get no thread until they're actually sent — resolving early
    // could anchor a thread to a message that never goes out.
    const threadId =
      status === 'draft'
        ? ''
        : this.resolveThreadId(msg.id, msg.in_reply_to, msg.subject, msg.from_addr, msg.to_addr)
    this.sql.exec(
      `INSERT INTO messages
         (id, message_id, from_addr, to_addr, subject, date, snippet,
          text_body, html_body, r2_key, attachments_json, size, created_at,
          direction, in_reply_to, thread_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      status,
    )
    return { threadId }
  }

  /** Update an unsent draft's editable fields. Returns false if not a draft. */
  updateDraft(
    id: string,
    fields: Partial<
      Pick<
        InsertMessage,
        'from_addr' | 'to_addr' | 'subject' | 'text_body' | 'html_body' | 'in_reply_to' | 'snippet'
      >
    >,
  ): boolean {
    const row = this.sql
      .exec(`SELECT status FROM messages WHERE id = ?`, id)
      .toArray()[0] as unknown as { status: string } | undefined
    if (!row || row.status !== 'draft') return false
    const cols = Object.keys(fields) as Array<keyof typeof fields>
    if (cols.length === 0) return true
    this.sql.exec(
      `UPDATE messages SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      ...cols.map((c) => fields[c] ?? ''),
      id,
    )
    return true
  }

  /**
   * Flip a draft to sent: resolve its thread NOW (against what actually
   * exists at send time) and stamp the send date. Returns null if the row
   * isn't an unsent draft.
   */
  markDraftSent(id: string, date: string): { threadId: string } | null {
    const row = this.sql
      .exec(
        `SELECT status, in_reply_to, subject, from_addr, to_addr FROM messages WHERE id = ?`,
        id,
      )
      .toArray()[0] as unknown as
      | { status: string; in_reply_to: string; subject: string; from_addr: string; to_addr: string }
      | undefined
    if (!row || row.status !== 'draft') return null
    const threadId = this.resolveThreadId(
      id,
      row.in_reply_to,
      row.subject,
      row.from_addr,
      row.to_addr,
    )
    this.sql.exec(
      `UPDATE messages SET status = 'sent', thread_id = ?, date = ? WHERE id = ?`,
      threadId,
      date,
      id,
    )
    return { threadId }
  }

  /** Newest-first drafts (metadata only). */
  listDrafts(limit = 50): MessageMeta[] {
    const capped = Math.min(Math.max(limit, 1), 200)
    return this.sql
      .exec(
        `SELECT id, from_addr, to_addr, subject, date, snippet, size, created_at, direction, thread_id, status, label
           FROM messages WHERE status = 'draft' ORDER BY id DESC LIMIT ?`,
        capped,
      )
      .toArray() as unknown as MessageMeta[]
  }

  /**
   * Case-insensitive keyword search over subject + text_body. Plain LIKE —
   * fine at this table's scale; revisit with an FTS index if volume grows.
   * Drafts included; newest first.
   */
  search(q: string, limit = 50): MessageMeta[] {
    const capped = Math.min(Math.max(limit, 1), 200)
    const term = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    return this.sql
      .exec(
        `SELECT id, from_addr, to_addr, subject, date, snippet, size, created_at, direction, thread_id, status, label
           FROM messages
          WHERE subject LIKE ? ESCAPE '\\' OR text_body LIKE ? ESCAPE '\\'
          ORDER BY id DESC LIMIT ?`,
        term,
        term,
        capped,
      )
      .toArray() as unknown as MessageMeta[]
  }

  /** Set the classifier label. No-op if the row is gone (delete raced it). */
  setLabel(id: string, label: string): void {
    this.sql.exec(`UPDATE messages SET label = ? WHERE id = ?`, label, id)
  }

  /**
   * Newest-first page (drafts excluded — see listDrafts). `cursor` is the
   * last-seen id (ids are time-ordered). `label` filters to one label.
   */
  list(
    limit = 50,
    cursor?: string,
    label?: string,
  ): { messages: MessageMeta[]; nextCursor: string | null } {
    const capped = Math.min(Math.max(limit, 1), 200)
    const where = [`status != 'draft'`]
    const params: unknown[] = []
    if (cursor) {
      where.push('id < ?')
      params.push(cursor)
    }
    if (label) {
      where.push('label = ?')
      params.push(label)
    }
    const rows = this.sql
      .exec(
        `SELECT id, from_addr, to_addr, subject, date, snippet, size, created_at, direction, thread_id, status, label
           FROM messages WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
        ...params,
        capped + 1,
      )
      .toArray() as unknown as MessageMeta[]
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
             m.created_at, m.direction, m.thread_id, m.status, m.label,
             (SELECT COUNT(*) FROM messages c WHERE c.thread_id = m.thread_id) AS thread_count
        FROM messages m
       WHERE m.status != 'draft'
         AND m.id = (SELECT MAX(id) FROM messages x WHERE x.thread_id = m.thread_id)`
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
                direction, in_reply_to, thread_id, status, label
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
                direction, in_reply_to, thread_id, status, label
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
