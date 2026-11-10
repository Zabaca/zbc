/**
 * A D1 stand-in over bun:sqlite, for the tests. It applies the SAME
 * migration files the deployed database is built from, so a test that passes here ran against the real schema, its
 * CHECK constraints and its triggers, rather than a hand-written fake that agrees with whatever the code expects.
 * Foreign keys are ON, as they are in D1, and `batch` is one transaction, as D1's is.
 *
 * Also an R2 stand-in that honours the customer key (SSE-C) the way R2 does: an object put with a key is refused
 * without that key and with any other.
 */
import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import type { Db, Stmt } from '../src/records'
import type { ObjectStore } from '../src/vault'

export const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url)

export function migrate(db: Database): void {
  for (const name of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    db.run(readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8'))
  }
}

export function localD1(db: Database): Db {
  const statement = (sql: string, values: unknown[]): Stmt & { exec(): unknown[] } => {
    const params = values as Array<string | number | null>
    return {
      bind: (...next) => statement(sql, next),
      run: async () => ({ meta: { changes: db.query(sql).run(...params).changes } }),
      all: async <T,>() => ({ results: db.query(sql).all(...params) as T[] }),
      first: async <T,>() => (db.query(sql).get(...params) as T | null) ?? null,
      exec: () => db.query(sql).all(...params),
    }
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (stmts) => db.transaction(() => stmts.map((s) => ({ results: (s as ReturnType<typeof statement>).exec() })))(),
  }
}

/** A migrated in-memory database. */
export function openLocalD1(): { db: Database; d1: Db } {
  const db = new Database(':memory:', { strict: true })
  db.run('PRAGMA foreign_keys = ON')
  migrate(db)
  return { db, d1: localD1(db) }
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])
const keyBytes = (k: ArrayBuffer | string): Uint8Array => (typeof k === 'string' ? Uint8Array.from(k.match(/../g)!.map((h) => parseInt(h, 16))) : new Uint8Array(k))

export interface MemoryStore extends ObjectStore {
  objects: Map<string, { bytes: Uint8Array; contentType?: string; key?: Uint8Array }>
}

/** An R2 bucket in memory: what the vault and the logo route use of one. */
export function memoryStore(): MemoryStore {
  const objects: MemoryStore['objects'] = new Map()
  return {
    objects,
    async put(key, value, opts) {
      const bytes = new Uint8Array(value instanceof Uint8Array ? value : new Uint8Array(value))
      objects.set(key, { bytes: bytes.slice(), contentType: opts?.httpMetadata?.contentType, key: opts?.ssecKey ? keyBytes(opts.ssecKey) : undefined })
      return { key }
    },
    async get(key, opts) {
      const o = objects.get(key)
      if (!o) return null
      if (o.key) {
        if (!opts?.ssecKey) throw new Error('The object was stored with a customer key; none was given')
        if (!same(o.key, keyBytes(opts.ssecKey))) throw new Error('The customer key does not match')
      }
      return { arrayBuffer: async () => o.bytes.slice().buffer as ArrayBuffer }
    },
    async delete(key) {
      for (const k of Array.isArray(key) ? key : [key]) objects.delete(k)
    },
  }
}
