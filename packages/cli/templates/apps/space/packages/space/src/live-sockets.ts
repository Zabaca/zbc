// What the live object remembers about each open page's socket, and the decisions about it that need no WebSocket: whether its sign-in has ended, when the next one will, and who a message reaches.
// Pure, so `bun test` checks them (src/live-do.ts is the object that applies them).

import { type LiveMessage, isFor } from '@space/workspace'

/** Kept on the socket itself (serializeAttachment), so it survives the object hibernating. */
export interface LiveAttachment {
  /** The person's sign-in address (`Person.address`, lowercase): what a message names. */
  person: string
  /** When the sign-in behind this socket ends, in ms: the Access assertion's expiry the Worker verified on the upgrade request. */
  endsAt: number
}

export const signInEnded = (a: LiveAttachment, now: number): boolean => a.endsAt <= now

/**
 * The earliest moment a sign-in that has NOT yet ended will end, for the object's alarm; null when there is none. A socket whose sign-in has ended is the alarm's to close, not to wait for again: counting it would
 * set the alarm for the past and make it re-arm every second until the runtime had finished closing it.
 */
export function nextExpiry(all: readonly LiveAttachment[], now: number): number | null {
  const open = all.filter((a) => !signInEnded(a, now))
  return open.length === 0 ? null : Math.min(...open.map((a) => a.endsAt))
}

/** The sockets a message reaches: those of the people it is for, whose sign-in has not ended. */
export function audience<T extends LiveAttachment>(sockets: readonly T[], message: LiveMessage, now: number): T[] {
  return sockets.filter((s) => !signInEnded(s, now) && isFor(message, s.person))
}

/** The people with at least one socket open, once each, whose sign-in has not ended. */
export function peopleOpen(all: readonly LiveAttachment[], now: number): string[] {
  return [...new Set(all.filter((a) => !signInEnded(a, now)).map((a) => a.person))]
}

/** The upgrade request's two headers, as the Worker sets them after its check: the person and the end of the sign-in. Null when either is missing or wrong. */
export function attachmentOf(headers: { get(name: string): string | null }): LiveAttachment | null {
  const person = (headers.get('x-live-person') ?? '').trim().toLowerCase()
  const endsAt = Number(headers.get('x-live-ends'))
  if (person === '' || !Number.isFinite(endsAt) || endsAt <= 0) return null
  return { person, endsAt }
}
