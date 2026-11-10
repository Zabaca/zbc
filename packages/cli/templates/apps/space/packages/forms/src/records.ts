/**
 * How the app reaches D1: the slice of it the app uses, so the Worker's binding and test/local-d1.ts (bun:sqlite
 * over the real migration) both satisfy it, plus the small helpers every module shares. Reads are plain
 * `prepare`; every write is sent as ONE batch (D1 runs a batch as one transaction), so a state change and the
 * event or audit row that records it land together or not at all (src/store.ts, src/events.ts).
 */

export type Row = Record<string, unknown>

export interface Stmt {
  bind(...values: unknown[]): Stmt
  first<T = Row>(): Promise<T | null>
  all<T = Row>(): Promise<{ results: T[] }>
  run(): Promise<unknown>
}

export interface Db {
  prepare(sql: string): Stmt
  batch(statements: Stmt[]): Promise<{ results: unknown[] }[]>
}

/** A random text id. Never a counter: an id shows up in a certificate and a tombstone, and must not be guessable. */
export const newId = (): string => crypto.randomUUID()

export const isoAt = (ms: number): string => new Date(ms).toISOString()

/** A UNIQUE or PRIMARY KEY violation, in either SQLite's or D1's wording. */
export const isUniqueViolation = (e: unknown): boolean => /UNIQUE constraint failed|PRIMARY KEY constraint failed|constraint failed: .*(unique|primary)/i.test(String((e as Error)?.message ?? e))

