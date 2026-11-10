import { Database } from 'bun:sqlite'
import type { InboxSql, SqlCursor } from '../src/store/schema'

/**
 * Enough of Cloudflare's `SqlStorage` for the inbox store, over a real SQLite.
 *
 * NOT A MOCK. It runs the SQL, so a mistyped column, a CHECK that does not hold,
 * a UNIQUE index that does not unique or a conditional UPDATE that does not
 * condition fails here exactly as it would on the real object. What it stands in
 * for is a Durable Object's STORAGE, not the store. The same shim, and the same
 * reasoning, as Northfield Works/pinecrest's test-support/sql-over-sqlite.ts, which this
 * follows; one difference: the cursor here is the subset the store reads.
 *
 * `exec` takes a query and positional bindings, as the real one does, and accepts
 * several statements in one call (a migration holds a whole table plus its
 * indexes); a multi-statement call returns an empty cursor there and here.
 */
export function sqlOver(db: Database): InboxSql {
  return {
    exec(query: string, ...bindings: unknown[]): SqlCursor {
      const args = bindings as never[]
      if (countStatements(query) > 1) {
        // One transaction per `exec`, as a Durable Object's is (schema.ts says so): a migration that rebuilds a table
        // relies on `PRAGMA defer_foreign_keys`, which holds only to the end of the transaction it is in.
        db.transaction(() => db.run(query, ...args))()
        return cursor([], 0)
      }
      const before = db.query('SELECT total_changes() AS n').get() as { n: number }
      // `all()` on a write returns [] and still performs it, so one path serves
      // reads and writes and `rowsWritten` stays honest for both.
      const rows = db.query(query).all(...args) as Record<string, unknown>[]
      const after = db.query('SELECT total_changes() AS n').get() as { n: number }
      return cursor(rows, after.n - before.n)
    },
  }
}

function cursor(rows: Record<string, unknown>[], rowsWritten: number): SqlCursor {
  return {
    toArray: () => rows,
    // Throws on anything but exactly one row, which is what the real cursor does.
    one: () => {
      if (rows.length !== 1) throw new Error(`Expected exactly one row from exec(), got ${rows.length}.`)
      return rows[0] as Record<string, unknown>
    },
    rowsWritten,
  }
}

/**
 * Whether a query is one statement or several. Counts semicolons outside string
 * literals and comments, because the migrations carry both and a naive
 * `split(';')` would cut a CHECK clause in half.
 */
function countStatements(query: string): number {
  let statements = 1
  let quote: string | null = null
  let comment: 'line' | 'block' | null = null

  for (let i = 0; i < query.length; i += 1) {
    const char = query[i]
    const next = query[i + 1]
    if (comment === 'line') {
      if (char === '\n') comment = null
      continue
    }
    if (comment === 'block') {
      if (char === '*' && next === '/') {
        comment = null
        i += 1
      }
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '-' && next === '-') {
      comment = 'line'
      i += 1
      continue
    }
    if (char === '/' && next === '*') {
      comment = 'block'
      i += 1
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    // A trailing semicolon terminates; it does not separate.
    if (char === ';' && query.slice(i + 1).trim() !== '') statements += 1
  }
  return statements
}

/** A fresh in-memory database with foreign keys ON, as a Durable Object's is. */
export function memoryDatabase(): { db: Database; sql: InboxSql; transaction: <T>(fn: () => T) => T } {
  const db = new Database(':memory:')
  // bun:sqlite ships foreign keys OFF and a Durable Object's SQLite does not, so
  // without this a REFERENCES clause would be inert and a broken one would pass.
  db.run('PRAGMA foreign_keys = ON')
  return {
    db,
    sql: sqlOver(db),
    // transactionSync's stand-in: commit if `fn` returns, roll back if it throws.
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
  }
}
