// A booking link's call (the space's ADR 0026): what the calendar is handed to hold a booking in a call of the space's own Meet, built here over meet's own code so the calendar never imports it.
//
// THE ONE EXCEPTION TO "ONLY A SIGNED-IN TEAMMATE STARTS A CALL". Every other way of making a call (a huddle, a call link, a meeting from a conversation) is handed the person the space's one sign-in check named. A visitor of a booking link is
// nobody the space knows, so this acts as the install's DECLARED OWNER, and the rule that allows it is the link's: a booking link the owner made, left on and set to the space call is the owner's word for exactly one call per booking, as it already is for one Google
// event and invitation per booking (ADR 0025). What keeps it to that:
//  - it is handed to the calendar's object and to nothing else (packages/space/src/calendar-do.ts); no route, no face of the space reaches it;
//  - the call is made once for each key (the booking's own id), with its window set at the moment it exists, and is a meeting with the booking's title and time: nothing a caller says makes it anything else;
//  - only a call made here can be moved or closed here: the Room refuses a window on any call that has none (`RoomCore.setWindow`, `cancelCall`) and the workspace refuses to move or cancel a record that is not a booking's, so no other call can be changed through it;
//  - the meter that refuses new calls refuses these too (`makeCall`).
// Nothing here sends mail: the invitation is Google's. No token, secret or address of the guest is kept by meet beyond the invitee on the meeting's record, which the owner sees in Meet.

import type { BookingCalls } from '@space/workspace'
import { type CallSpec, callLink, makeKeyedCall, meterOf, pausedWords } from './calls'
import { RoomError } from './room'
import { CALLS_OFF, type SpaceMeetDeps } from './space-meet'
import type { Actor } from './workspace'

export type BookingCallsDeps = Pick<SpaceMeetDeps, 'install' | 'workspace' | 'room' | 'ledger' | 'appOrigin' | 'now' | 'randomBytes'>

/** meet's refusal as the words for the owner, anything else thrown: a fault is an outcome nobody knows, which the calendar reads so. */
async function answer<T>(run: () => Promise<T>): Promise<T | { ok: false; why: string }> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof RoomError) return { ok: false, why: err.message }
    throw err
  }
}

export function bookingCalls(d: BookingCallsDeps): BookingCalls {
  const owner = d.install.owner()
  // The teammate actor the workspace's rules are written for: the owner, as the owner's own call would be.
  const actor: Actor = { via: 'access', email: owner.address }
  const deps = () => ({ room: d.room, ledger: d.ledger, workspace: d.workspace, appOrigin: d.appOrigin, now: d.now, randomBytes: d.randomBytes })

  return {
    get on() {
      return d.install.has('calls')
    },

    check: () =>
      answer(async () => {
        if (!d.install.has('calls')) return { ok: false as const, why: CALLS_OFF }
        const m = await meterOf(d.ledger(), d.now())
        return m.paused ? { ok: false as const, why: pausedWords(m) } : { ok: true as const }
      }) as ReturnType<BookingCalls['check']>,

    make: (call) =>
      answer(async () => {
        if (!d.install.has('calls')) return { ok: false as const, why: CALLS_OFF }
        const spec: CallSpec = {
          kind: 'meeting',
          title: call.title,
          startsAt: call.startsAt,
          invitees: [{ name: call.guest.name, address: call.guest.email }],
          booking: true,
          window: { opensAt: call.opensAt, closesAt: call.closesAt },
        }
        const made = await makeKeyedCall(deps(), actor, owner.address, call.key, spec)
        return { ok: true as const, name: made.call.name, link: callLink(d.appOrigin, made.call.name) }
      }) as ReturnType<BookingCalls['make']>,

    move: (name, when) =>
      answer(async () => {
        // The workspace first: it refuses a record that is not a booking's, so no other call is moved by this.
        await d.workspace().callMove(actor, name, when.startsAt, d.now())
        await d.room(name).setWindow(when.opensAt, when.closesAt)
        return { ok: true as const }
      }) as ReturnType<BookingCalls['move']>,

    close: (name) =>
      answer(async () => {
        await d.workspace().callCancel(actor, name, d.now())
        await d.room(name).cancelCall(d.now())
        return { ok: true as const }
      }) as ReturnType<BookingCalls['close']>,
  }
}
