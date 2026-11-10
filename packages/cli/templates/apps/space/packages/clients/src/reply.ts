/**
 * What every method of the three faces answers, built in one place: the contract's `SpaceReply`, as data. A refusal of the store is a decision the person may be shown; a fault is `broken`, and nothing a method does
 * leaves it as an exception, because an error thrown across a Durable Object call arrives as a message with its type gone.
 */

import { answered, type Failed, failed, type Refused, refused, type SpaceReply } from '@space/workspace'
import type { Result } from './store'

export const FAULT = 'The Clients could not answer that. Nothing was changed.'
export const BAD = (what: string): Refused => refused('bad-request', what)

/** A store result as the contract's reply. */
export function reply<T>(r: Result<T>): SpaceReply<T> {
  return r.ok ? answered(r.value) : refused(r.reason, r.error)
}

/** Run `fn`, and turn anything it throws into the contract's failure. Logged to the Worker's tail, never shown. */
export async function guarded<R>(what: string, fn: () => Promise<R>): Promise<R | Failed> {
  try {
    return await fn()
  } catch (error) {
    console.error(`clients: ${what} failed`, error)
    return failed(FAULT)
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
export const isText = (v: unknown): v is string => typeof v === 'string'
export const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1
