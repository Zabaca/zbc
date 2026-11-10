// What the Workspace object remembers about each open socket, and the two decisions about it that need no
// WebSocket to make: whether its sign-in has ended, and when the next one will. Pure, so `bun test` checks them.

import type { ClientFrame } from './workspace-model'

/** Kept on the socket itself (serializeAttachment), so it survives the object hibernating. */
export interface SocketAttachment {
  person: string
  /** The guest session this socket belongs to, or null for a teammate's. */
  session: string | null
  /** When this sign-in ends, in ms: a guest session's expiry, or a teammate's assertion's. */
  endsAt: number
  /** False until the browser's `hello` has been answered: nothing is pushed before the catch-up, so order holds. */
  ready: boolean
}

export const signInEnded = (a: SocketAttachment, now: number): boolean => a.endsAt <= now

/** The earliest moment any of these sockets' sign-ins ends, for the object's alarm; null when there are none. */
export function nextExpiry(all: SocketAttachment[]): number | null {
  return all.length === 0 ? null : Math.min(...all.map((a) => a.endsAt))
}

/** A frame from the browser, or null when it is not one. */
export function parseFrame(raw: unknown): ClientFrame | null {
  if (typeof raw !== 'string' || raw.length > 1000) return null
  let f: unknown
  try {
    f = JSON.parse(raw)
  } catch {
    return null
  }
  if (!f || typeof f !== 'object') return null
  const o = f as Record<string, unknown>
  if (o.t === 'ping') return { t: 'ping' }
  if (o.t === 'hello' && typeof o.since === 'number' && Number.isInteger(o.since)) return { t: 'hello', since: o.since }
  if (o.t === 'read' && typeof o.conv === 'number' && Number.isInteger(o.conv) && typeof o.upTo === 'number' && Number.isInteger(o.upTo)) {
    return { t: 'read', conv: o.conv, upTo: o.upTo }
  }
  return null
}
