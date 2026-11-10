// Making a call, for every door that does: the meter, a name, the call's Room, the ledger's index, and the workspace's record of what the
// call is for (a huddle's conversation, a call link's or a meeting's home). Pure of Hono and of the Workers runtime, so `bun test` drives it with the
// real cores and no network.
//
// ORDER MATTERS, and each step stands alone: the workspace is asked first whether this person may (and whether this key has made a call already),
// then the meter, then the Room and the index, then the workspace is told. A step that refuses leaves nothing behind. A fault after the Room is made
// leaves a call nobody is told about, which is harmless: it is in the ledger, and the past-calls list shows it.

import type { CallKind } from '@space/workspace'
import type { CallRecordRaw } from './workspace-model'
import { GB, FREE_GB, TRIP_GB, nextMonthStart, newRoomName, utcMonth } from './model'
import { RoomError, type RoomClient } from './room'
import type { Actor, WorkspaceClient } from './workspace'

/** What making a call needs from the Worker. */
export interface CallDeps {
  room(name: string): RoomClient
  ledger(): RoomClient
  workspace(): WorkspaceClient
  /** The space's address, the install's space host (`appOriginOf`, wiring.ts): every call link is made from it. */
  appOrigin: string
  now(): number
  randomBytes(n: number): Uint8Array
}

/** Where the usage meter stands: the month's estimate and, once it has tripped, the day calls resume. */
export interface Meter {
  usedGb: number
  freeGb: number
  tripGb: number
  paused: boolean
  pausedUntil: string | null
}

export async function meterOf(ledger: RoomClient, now: number): Promise<Meter> {
  const bytes = await ledger.usageFor(utcMonth(now))
  const paused = bytes >= TRIP_GB * GB
  return {
    usedGb: Math.round((bytes / GB) * 1000) / 1000,
    freeGb: FREE_GB,
    tripGb: TRIP_GB,
    paused,
    pausedUntil: paused ? nextMonthStart(now) : null,
  }
}

/** A call's link: meet's public address and the call's name, never the address of the page that shows it. */
export const callLink = (origin: string, name: string): string => `${origin.replace(/\/+$/, '')}/r/${name}`

/** The words for a new call refused by the meter. A refusal of the `limit` kind to the space. */
export const pausedWords = (m: Meter): string => `Calls are paused until ${m.pausedUntil}.`

/**
 * Make a call: refused while the meter has tripped (new joins are refused then too), otherwise a fresh name, its Room, and its place in the ledger's
 * index. `maker` is the declared address of the person who made it (the owner's rule for a call with none), or 'guest' for a channel guest.
 */
export async function makeCall(d: CallDeps, maker: string | null): Promise<string> {
  const m = await meterOf(d.ledger(), d.now())
  if (m.paused) throw new RoomError(429, pausedWords(m))
  for (let attempt = 0; attempt < 5; attempt++) {
    const name = newRoomName(d.randomBytes)
    const room = d.room(name)
    if (await room.exists()) continue
    await room.create(name, d.now())
    await d.ledger().recordCall(name, d.now(), maker)
    return name
  }
  throw new RoomError(502, 'could not allocate a call name')
}

export interface CallSpec {
  kind: CallKind
  convId?: number | null
  home?: string | null
  title?: string | null
  startsAt?: number | null
  invitees?: Array<{ name: string; address: string | null }>
}

/**
 * Make a call of any kind once per compose key. Asks the workspace first (it checks who may, and answers the call this key made if it made one),
 * then makes the call, then records it with its link (a huddle's message carries the link, so a page that draws no card still shows "Join call").
 */
export async function makeKeyedCall(d: CallDeps, actor: Actor, maker: string | null, key: string, spec: CallSpec): Promise<CallRecordRaw> {
  const ws = d.workspace()
  const begun = await ws.callBegin(actor, key, spec.kind, spec.convId ?? null, d.now())
  if (begun.held) return { repeated: true, call: begun.held, message: null }
  const name = await makeCall(d, maker)
  return ws.callRecord(actor, key, spec, name, callLink(d.appOrigin, name), d.now())
}

