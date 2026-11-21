// How the booking page talks to the space: the calendar's public API under `/book/api/` (src/booking.ts) and nothing else. No cookie is sent (`credentials: 'omit'`): a visitor has none of the team's, and the page must not hand a signed-in person's to a call.
// An answer is the value, or the calendar's own sentence for why not (and its reason), so the page can say it as it came.

import type { GuestBooked, GuestBookingInput, GuestBookingLink, GuestBookingSlots, GuestBookingView } from '@space/workspace'

export type Answer<T> = { ok: true; value: T } | { ok: false; status: number; message: string; reason: string | null }

const UNREACHABLE = 'The calendar could not be reached. Please check your connection and try again.'

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer<T>> {
  try {
    const res = await fetch(path, {
      method,
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: 'omit',
      cache: 'no-store',
    })
    let parsed: unknown = null
    try {
      parsed = await res.json()
    } catch {
      parsed = null
    }
    const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
    if (res.ok && record !== null && 'value' in record) return { ok: true, value: record.value as T }
    return { ok: false, status: res.status, message: typeof record?.error === 'string' ? record.error : 'Something went wrong. Please try again in a moment.', reason: typeof record?.reason === 'string' ? record.reason : null }
  } catch {
    return { ok: false, status: 0, message: UNREACHABLE, reason: null }
  }
}

const link = (slug: string): string => `/book/api/links/${encodeURIComponent(slug)}`
const manage = (secret: string): string => `/book/api/manage/${encodeURIComponent(secret)}`

export const api = {
  link: (slug: string) => call<GuestBookingLink>('GET', link(slug)),
  slots: (slug: string) => call<GuestBookingSlots>('GET', `${link(slug)}/slots`),
  /** `website` is the hidden field a person never fills. */
  book: (slug: string, input: GuestBookingInput & { website: string }) => call<GuestBooked>('POST', `${link(slug)}/book`, input),
  booking: (secret: string) => call<GuestBookingView>('GET', manage(secret)),
  bookingSlots: (secret: string) => call<GuestBookingSlots>('GET', `${manage(secret)}/slots`),
  move: (secret: string, start: number) => call<GuestBookingView>('POST', `${manage(secret)}/move`, { start }),
  cancel: (secret: string) => call<GuestBookingView>('POST', `${manage(secret)}/cancel`, {}),
}

/** The address of a booking's own page. */
export const managePath = (secret: string): string => `/book/manage/${secret}`
