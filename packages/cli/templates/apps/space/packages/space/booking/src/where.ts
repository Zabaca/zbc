// Where a meeting is held, in a visitor's words (the space's ADR 0026): on Google Meet, or in a video call that opens in the browser with no account. One place, so the link's page, the confirmation and the booking's own page say it alike.

import type { BookingWhere } from '@space/workspace'

/** The short form, beside the length on the link's page and as the place on a booking. */
export const whereShort = (where: BookingWhere): string => (where === 'space' ? 'Video call in your browser' : 'Google Meet')

/** The text of the link a visitor joins by. */
export const whereJoin = (where: BookingWhere): string => (where === 'space' ? 'Join the video call' : 'Google Meet')

/** What a visitor needs to know about the place besides its name, or null when there is nothing to add. */
export const whereNote = (where: BookingWhere): string | null => (where === 'space' ? 'It opens in your browser, with no account, from 30 minutes before the start.' : null)
