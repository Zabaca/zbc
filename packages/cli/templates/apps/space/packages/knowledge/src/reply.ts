/**
 * What every method of both entrypoints answers, built in one place: the contract's `SpaceReply`, as data. A refusal of the store is
 * a decision the person may be shown; a fault is `broken`, and nothing a method does leaves it as an exception, because an error
 * thrown across a service binding arrives as a message with its type gone.
 */

import {
  answered,
  type Failed,
  failed,
  type Install,
  type KnowledgeBase,
  type Refused,
  refused,
  type SpaceReply,
} from '@space/workspace'
import type { Result, StoreApi } from './store'

export const FAULT = 'The knowledge base could not answer that. Nothing was changed.'
export const BAD = (what: string): Refused => refused('bad-request', what)

/** A store result as the contract's reply. */
export function reply<T>(r: Result<T>): SpaceReply<T> {
  return r.ok ? answered(r.value) : refused(r.reason, r.error)
}

/**
 * The knowledge base as both readers are given it: the install's businesses (for the row of choices), the business asked for (or
 * null for all) and the entries. Written once, for the space's tab and for Claude's script through the inbox. A business the
 * declaration does not list is the store's `not-found`.
 */
export async function readBase(store: StoreApi, install: Install, business: string | null): Promise<SpaceReply<KnowledgeBase>> {
  const read = await store.call('entries', business)
  if (!read.ok) return refused(read.reason, read.error)
  return answered({
    businesses: install.businesses().map((b) => ({ id: b.id, name: b.name })),
    business,
    entries: read.value,
  })
}

/** Run `fn`, and turn anything it throws into the contract's failure. Logged to the Worker's tail, never shown. */
export async function guarded<R>(what: string, fn: () => Promise<R>): Promise<R | Failed> {
  try {
    return await fn()
  } catch (error) {
    console.error(`knowledge: ${what} failed`, error)
    return failed(FAULT)
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
export const isText = (v: unknown): v is string => typeof v === 'string'
export const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

/** What an entry's id looks like (the store's own are uuids; the check keeps a path-shaped string out of a query). */
export const ENTRY_ID = /^[A-Za-z0-9_.:-]{1,100}$/

/** A list of strings, or null when it is not one. */
export const textList = (v: unknown): string[] | null => (Array.isArray(v) && v.every(isText) ? (v as string[]) : null)
