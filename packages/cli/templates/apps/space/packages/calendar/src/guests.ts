/**
 * The calendar as the open path is given it (the space's ADR 0025): the third face, for the visitor of a booking link and for nothing else, over the same engine as the space's and the inbox's.
 *
 * It takes NO PERSON, and this is the whole of why it is safe to: a visitor is nobody the space knows, so what lets one do anything is the link's address (public, and the owner's word that it may be booked) or a booking's own secret, both checked by the
 * engine (src/bookings.ts). Its holder is the guest door of the space's Worker (packages/space/src/booking.ts) and nothing else: the space's face has no method that books, the inbox is never handed it, and `test/space-contract.test.ts` holds the three lists.
 *
 * Every method answers a `SpaceReply` as data. What goes wrong that is not a decision (the store threw) is logged to the Worker's tail with no secret in it, and reported to the visitor in the words below: for a write, the one safe next step is to look for the invitation.
 */

import { answered, type CalendarForGuests, failed, refused, type SpaceReply } from '@space/workspace'
import type { EngineApi, Result } from './engine'

/** What a read that failed says to a visitor. */
export const GUEST_READ_FAULT = 'The calendar could not answer that. Please try again in a moment.'
/** What a write that did not end cleanly says to a visitor: the event may have been made, so the one safe next step is to look. */
export const GUEST_WRITE_FAULT = 'The calendar could not tell whether that was done. Look for the invitation in your email before trying again: it may have been done.'

export interface GuestCalendarDeps {
  engine: EngineApi
}

function reply<T>(r: Result<T>): SpaceReply<T> {
  return r.ok ? answered(r.value) : refused(r.reason, r.error)
}

export function createGuestCalendar(deps: GuestCalendarDeps): CalendarForGuests {
  const { engine } = deps

  async function run<T>(what: string, fault: string, fn: () => Promise<Result<T>>): Promise<SpaceReply<T>> {
    try {
      return reply(await fn())
    } catch (error) {
      // Never the request: a secret is in it. The message of an error is the runtime's or Google's own sentence, and goes to the Worker's tail, never to the visitor.
      console.error(`calendar: ${what} (booking page) failed`, error instanceof Error ? error.message : 'not an error')
      return failed(fault)
    }
  }

  return {
    link: (slug) => run('link', GUEST_READ_FAULT, () => engine.call('guestLink', slug)),
    slots: (slug) => run('slots', GUEST_READ_FAULT, () => engine.call('guestSlots', slug)),
    book: (slug, input, network) => run('book', GUEST_WRITE_FAULT, () => engine.call('guestBook', slug, input, network)),
    booking: (secret) => run('booking', GUEST_READ_FAULT, () => engine.call('guestBooking', secret)),
    bookingSlots: (secret) => run('bookingSlots', GUEST_READ_FAULT, () => engine.call('guestBookingSlots', secret)),
    move: (secret, start) => run('move', GUEST_WRITE_FAULT, () => engine.call('guestMove', secret, start)),
    cancel: (secret) => run('cancel', GUEST_WRITE_FAULT, () => engine.call('guestCancel', secret)),
  }
}
