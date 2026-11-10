// Live updates (the space's ADR 0019): the words the space's one live object and the stores that tell it share.
//
// ONE LIVE OBJECT PER COMPANY (packages/space/src/live-do.ts) holds the connection of every open team page. Each store, once a change is STORED, tells it with a `LiveMessage`: which part moved
// (mail, chat, calls, documents, knowledge, calendar, clients), the people it is for and, when there is one, the conversation. A message NEVER carries what changed: the page reads the screens it is showing again,
// and the Worker applies every rule about what a person may see on that read. The object turns a message into a frame for each of those people's open pages (`liveFrame`), and the page reads the frame
// back (`parseLiveFrame`).
//
// TELLING IS BEST EFFORT AND NEVER PART OF THE CHANGE. `tellLive` is called after a change has been stored, starts the message and returns at once; a message that cannot be delivered (no object bound, the
// object down, a refusal) is logged and forgotten, and neither fails nor slows the change that caused it. A page that missed one reads again on reconnecting, on being shown again and every ten minutes.
//
// Pure: no I/O, no Workers types. The stores pass their `DurableObjectNamespace` as it is (it is cast here to the two calls used), and a test passes a recorder.

import type { Install } from './install'

/** The seven parts of the space a page draws, named for what the person sees. A message names exactly one. */
export const LIVE_PARTS = ['mail', 'chat', 'calls', 'documents', 'knowledge', 'calendar', 'clients'] as const
export type LivePart = (typeof LIVE_PARTS)[number]

/** The one live object's name: `idFromName(LIVE_NAME)`. A company has one, so changing this is a new object with nobody connected, not a lost store (it holds none). */
export const LIVE_NAME = 'live'

/** The path the page opens its one socket at, on the space's own address; the Worker checks the person on that request as on any other. */
export const LIVE_SOCKET_PATH = '/api/live'

/** What the socket closes with when the person's sign-in has ended: the page then goes quiet and its reads show the sign-in notice. Meet's code, so the page knows one number. */
export const LIVE_CLOSE_SIGNED_OUT = 4401

/** The most people one message names, and the longest conversation key: far above what a company of this size has, to keep a bad message small. */
export const LIVE_PEOPLE_MAX = 200
export const LIVE_KEY_MAX = 320

/** "Everyone who has the space open": a call's, which any teammate may be in. */
export const EVERYONE = 'everyone'

/**
 * A change that has been stored. `people` are sign-in addresses of this install (`Person.address`, lowercase) or `EVERYONE`. `conversation` is the key the page opens the conversation by
 * (`chat:channel:3`, `chat:<personId>`, `phone`; packages/space/src/conversation.ts `parseKey`), when exactly one conversation changed. It never names a call (a call's name is its link).
 */
export interface LiveMessage {
  part: LivePart
  people: readonly string[] | typeof EVERYONE
  conversation?: string
}

/** The message as read from an untrusted caller (the object's `tell` is an RPC method), or null when it is not one. */
export function parseLiveMessage(raw: unknown): LiveMessage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.part !== 'string' || !(LIVE_PARTS as readonly string[]).includes(o.part)) return null
  let people: LiveMessage['people']
  if (o.people === EVERYONE) people = EVERYONE
  else if (Array.isArray(o.people) && o.people.length <= LIVE_PEOPLE_MAX && o.people.every((p) => typeof p === 'string' && p.length > 0 && p.length <= LIVE_KEY_MAX)) {
    people = (o.people as string[]).map((p) => p.trim().toLowerCase())
  } else return null
  if (o.conversation === undefined) return { part: o.part as LivePart, people }
  if (typeof o.conversation !== 'string' || o.conversation === '' || o.conversation.length > LIVE_KEY_MAX) return null
  return { part: o.part as LivePart, people, conversation: o.conversation }
}

/** Whether a message is for a person (their sign-in address, any case). */
export const isFor = (message: LiveMessage, person: string): boolean => message.people === EVERYONE || message.people.includes(person.trim().toLowerCase())

/** What a page is sent: the part and the conversation, and nothing of who it is for or what changed. */
export interface LiveFrame {
  t: 'changed'
  part: LivePart
  conversation?: string
}

export const liveFrame = (message: LiveMessage): string =>
  JSON.stringify({ t: 'changed', part: message.part, ...(message.conversation !== undefined && { conversation: message.conversation }) } satisfies LiveFrame)

/** A frame as the page reads it, or null when it is anything else (a stray string, a part this build does not know). */
export function parseLiveFrame(raw: unknown): { part: LivePart; conversation?: string } | null {
  let f: unknown = raw
  if (typeof raw === 'string') {
    try {
      f = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (typeof f !== 'object' || f === null) return null
  const o = f as Record<string, unknown>
  if (o.t !== 'changed' || typeof o.part !== 'string' || !(LIVE_PARTS as readonly string[]).includes(o.part)) return null
  if (o.conversation === undefined) return { part: o.part as LivePart }
  return typeof o.conversation === 'string' && o.conversation !== '' ? { part: o.part as LivePart, conversation: o.conversation } : null
}

// ── Telling ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The two calls of a Durable Object namespace that telling uses; `env.LIVE` is passed as it is. */
interface LiveNamespace {
  idFromName(name: string): unknown
  get(id: never): { tell(message: LiveMessage): unknown; openPeople(): unknown }
}

/** A way to keep a Worker request alive until the message is out (`ctx.waitUntil`). A Durable Object has none and needs none: it stays alive for a call it has started. */
export type WaitUntil = (promise: Promise<unknown>) => void

/**
 * The live object's namespace as a store holds it in its environment (`env.LIVE`: the space's `LIVE` binding, a `DurableObjectNamespace` of `LiveDO`). Typed loosely on purpose: this package has no Workers types, and a
 * store whose environment has none (a test, a local run) holds `undefined`. Every store reads it off its environment with `liveOf` and tells it with `tellLive`.
 */
export type LiveBinding = unknown

/** The live binding of an environment, or undefined. The one place `LIVE` is read off a Durable Object's `env` (which the runtime types as whatever the Worker declares). */
export const liveOf = (env: unknown): LiveBinding => (env as { LIVE?: LiveBinding } | null | undefined)?.LIVE

const objectOf = (live: LiveBinding) => {
  const ns = live as LiveNamespace
  return ns.get(ns.idFromName(LIVE_NAME) as never)
}

/**
 * Tell the live object a change has been stored. Call it AFTER the store has the change, never before. Returns at once; nothing it does can throw into the caller, and a message that cannot be
 * delivered is logged (the reason only, never the message) and dropped. Where no live object is bound (`live` undefined: a local run, a test) it does nothing.
 */
export function tellLive(live: LiveBinding, message: LiveMessage, wait?: WaitUntil): void {
  if (live === undefined || live === null) return
  try {
    const told = Promise.resolve()
      .then(() => objectOf(live).tell(message))
      .catch((err: unknown) => console.warn('live: a message was not delivered:', err instanceof Error ? err.message : String(err)))
    wait?.(told)
  } catch (err) {
    console.warn('live: a message was not delivered:', err instanceof Error ? err.message : String(err))
  }
}

/** How long a question to the live object is waited for. Longer than that is "unknown". */
export const OPEN_PEOPLE_WITHIN_MS = 2000

/**
 * The people who have the space open right now (their sign-in addresses), asked of the live object, or `[]` when it is not bound, does not answer in time or fails: the question is for a decision that
 * is safe to get wrong in one direction only (an email not held back, which is a nuisance), so not knowing is "nobody", never a wait or an error.
 */
export async function openPeople(live: LiveBinding, withinMs: number = OPEN_PEOPLE_WITHIN_MS): Promise<string[]> {
  if (live === undefined || live === null) return []
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const asked = Promise.resolve().then(() => objectOf(live).openPeople())
    const none = new Promise<unknown>((resolve) => {
      timer = setTimeout(() => resolve([]), withinMs)
    })
    const got = await Promise.race([asked, none])
    return Array.isArray(got) ? got.filter((p): p is string => typeof p === 'string') : []
  } catch (err) {
    console.warn('live: who has the space open was not answered:', err instanceof Error ? err.message : String(err))
    return []
  } finally {
    clearTimeout(timer)
  }
}

// ── Who a store tells ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The install's owners, by sign-in address: who the knowledge store admits. */
export const ownersOf = (install: Install): string[] => install.people.filter((p) => install.isOwner(p)).map((p) => p.address)

/** Every person of the install: forms' operators are all of them (packages/forms/src/workspace.ts `operatorOf`). */
export const teamOf = (install: Install): string[] => install.people.map((p) => p.address)
